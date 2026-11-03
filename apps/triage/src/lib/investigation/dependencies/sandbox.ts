import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../errors";
import { createSandboxDatabase, type SandboxDatabase } from "../fix/database";
import { exec, removeSandbox, sandboxRoot, skip, trim } from "../fix/sandbox";
import type { SandboxRun, TestCase } from "../schema";
import { auditEnv, parseAudit, runPackageManager } from "./audit";
import type { BumpChange } from "./fix";

// Proves a dependency bump by installing it: a copy of the app with its own
// node_modules (the code-fix sandbox links the app's, which a bump can't
// change), the bump written in, `pnpm install`, then the advisory must be
// gone from `pnpm audit`, and the app must still typecheck and pass its
// tests against what was installed. Before the bump, the same audit must
// list the advisory, so the pair reads like a regression test: failing
// before, passing after.
//
// The sandbox is its own workspace root rather than a project installed
// with --ignore-workspace: pnpm reads overrides (and every other setting:
// which packages may run build scripts, the release-age rules) only from
// the workspace root's pnpm-workspace.yaml, and --ignore-workspace ignores
// that file altogether, so an override bump would install as if it weren't
// there. The sandbox gets a copy of the workspace's pnpm-workspace.yaml
// (without its `packages`, so the sandbox is the only project) and the
// workspace lockfile cut down to the service's importer, renamed ".": the
// install keeps every version the service resolves today and moves only
// what the bump moves. os.tmpdir() has no workspace above it, so nothing
// else is picked up. The sandbox goes under os.tmpdir()/triage-sandbox and
// is removed after.
//
// If the registry can't be reached the install can't fetch anything; the
// lockfile is then resolved alone (--lockfile-only, from pnpm's cache) and
// audited, and typecheck and tests are skipped, which the runs say.

export type RunResult = { exitCode: number; stdout: string; output: string; durationMs: number; timedOut: boolean };

// The commands the proof runs, swapped in tests so they need no registry.
export type Runner = {
  pnpm(args: string[], cwd: string, timeoutMs: number): Promise<RunResult>;
  node(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult>;
};

// A warm store installs Shopfront in 30 to 60 s; a cold one fetches
// everything.
const INSTALL_TIMEOUT_MS = 180_000;
const AUDIT_TIMEOUT_MS = 60_000;
const TYPECHECK_TIMEOUT_MS = 120_000;
const TESTS_TIMEOUT_MS = 180_000;

export const realRunner: Runner = {
  async pnpm(args, cwd, timeoutMs) {
    const started = performance.now();
    // pnpm is a .cmd shim on Windows: runPackageManager starts it through
    // a shell, with the registry settings and none of Triage's secrets, and
    // kills the whole tree on a timeout.
    const r = await runPackageManager("pnpm", args, cwd, timeoutMs);
    const output = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
    return {
      exitCode: r.timedOut ? 124 : r.exitCode,
      stdout: r.stdout,
      output: r.timedOut ? `${output}\nKilled after ${timeoutMs / 1000} s.` : output,
      durationMs: Math.round(performance.now() - started),
      timedOut: r.timedOut,
    };
  },
  async node(args, cwd, env, timeoutMs) {
    const r = await exec(process.execPath, args, cwd, env, timeoutMs);
    return { exitCode: r.exitCode, stdout: r.output, output: r.output, durationMs: r.durationMs, timedOut: r.exitCode === 124 };
  },
};

// What a failed install says when the registry was out of reach.
export const unreachable = (output: string) =>
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|getaddrinfo|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_|socket hang up|network/i.test(output);

// pnpm-workspace.yaml for a sandbox that is its own workspace: the
// workspace's settings, without the `packages` list.
export function standaloneWorkspaceYaml(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^packages\s*:/.test(lines[i])) {
      while (i + 1 < lines.length && (lines[i + 1] === "" || /^[\s-]/.test(lines[i + 1]))) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

// The workspace lockfile as the service's alone: its importer becomes ".",
// the others go (pnpm prunes the packages only they used). pnpm 12 writes a
// first YAML document about pnpm itself (with an importer "." of its own);
// the main one is the document whose importers include the service.
// Undefined when no document has it, and the sandbox then resolves from
// scratch.
export function standaloneLockfile(lock: string, importer: string): string | undefined {
  for (const doc of lock.split(/^---\s*$/m)) {
    const own = standaloneDocument(doc, importer);
    if (own) return own;
  }
  return undefined;
}

function standaloneDocument(doc: string, importer: string): string | undefined {
  if (!/^lockfileVersion:/m.test(doc)) return undefined;
  const lines = doc.replace(/^\r?\n/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^importers:\s*$/.test(l));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end++;
  // Each importer is a block opened by a two-space-indented key.
  const blocks: { key: string; lines: string[] }[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const head = /^ {2}(?!\s)(?:'([^']*)'|"([^"]*)"|([^:]+)):(.*)$/.exec(line);
    if (head) blocks.push({ key: head[1] ?? head[2] ?? head[3], lines: [`  .:${head[4]}`] });
    else blocks.at(-1)?.lines.push(line);
  }
  const ours = blocks.find((b) => b.key === importer);
  if (!ours) return undefined;
  while (ours.lines.at(-1) === "") ours.lines.pop();
  return [...lines.slice(0, start + 1), "", ...ours.lines, "", ...lines.slice(end)].join("\n");
}

// The name the re-audit goes by, as a test and as the fix's regressionTest.
export const reauditTestName = (advisoryId: string) => `pnpm audit no longer lists ${advisoryId}`;

export type BumpProof = { ok: true; runs: SandboxRun[]; offline: boolean } | { ok: false; runs: SandboxRun[]; problems: string[] };

type Vitest = { testResults?: { assertionResults?: { title: string; status: string; duration?: number | null; failureMessages?: string[] }[] }[] };

export async function proveBump(opts: {
  appDir: string;
  name: string;
  service: string;
  advisoryId: string;
  // Where the lockfile and pnpm-workspace.yaml are, and the service's
  // importer in it ("apps__shopfront"'s path form, "apps/shopfront", is
  // worked out here).
  lockRoot: string;
  importer: string;
  changes: BumpChange[];
  runner?: Runner;
  // A copy of the app's database for the tests; tests stub it.
  database?: (dir: string, purpose: string) => Promise<SandboxDatabase>;
  onStage?: (stage: "audit" | "install" | "reaudit" | "typecheck" | "tests") => void;
}): Promise<BumpProof> {
  const runner = opts.runner ?? realRunner;
  const dir = path.join(/* turbopackIgnore: true */ sandboxRoot, opts.name);
  const runs: SandboxRun[] = [];
  const testName = reauditTestName(opts.advisoryId);
  const tail = (output: string) => output.split("\n").slice(-25).join("\n");
  let database: SandboxDatabase | undefined;
  try {
    await rm(dir, { recursive: true, force: true });
    await cp(opts.appDir, dir, { recursive: true, filter: (src) => src === opts.appDir || !skip(path.relative(opts.appDir, src)) });
    // Next's generated route types, which next-env.d.ts imports.
    await cp(path.join(/* turbopackIgnore: true */ opts.appDir, ".next", "dev", "types"), path.join(/* turbopackIgnore: true */ dir, ".next", "dev", "types"), { recursive: true }).catch(() => undefined);

    // The sandbox as its own workspace root (see above). When the service is
    // the workspace root itself, its own files were copied already.
    const workspace = path.resolve(/* turbopackIgnore: true */ opts.lockRoot) !== path.resolve(/* turbopackIgnore: true */ opts.appDir);
    let lockNote = "";
    if (workspace) {
      const yaml = await readFile(path.join(/* turbopackIgnore: true */ opts.lockRoot, "pnpm-workspace.yaml"), "utf8").catch(() => "");
      await writeFile(path.join(/* turbopackIgnore: true */ dir, "pnpm-workspace.yaml"), standaloneWorkspaceYaml(yaml));
      const lock = await readFile(path.join(/* turbopackIgnore: true */ opts.lockRoot, "pnpm-lock.yaml"), "utf8").catch(() => "");
      const importer = opts.importer.split("__").join("/");
      const own = lock && standaloneLockfile(lock, importer);
      if (own) await writeFile(path.join(/* turbopackIgnore: true */ dir, "pnpm-lock.yaml"), own);
      else lockNote = `The workspace lockfile has no ${importer} importer, so the install resolved every version afresh.\n`;
    }

    const manifest = JSON.parse(await readFile(path.join(/* turbopackIgnore: true */ dir, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    const audit = async (label: string, ref: SandboxRun["ref"]): Promise<{ run: SandboxRun; listed?: boolean }> => {
      const r = await runner.pnpm(["audit", "--json"], dir, AUDIT_TIMEOUT_MS);
      let listed: boolean | undefined;
      let summary: string;
      try {
        const json = JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf("{"))));
        const findings = parseAudit(json, { service: opts.service, importer: ".", manifest });
        listed = findings.some((f) => f.advisoryId === opts.advisoryId);
        const others = findings.filter((f) => f.advisoryId !== opts.advisoryId).map((f) => `${f.advisoryId} (${f.package}, ${f.severity})`);
        summary = `${opts.advisoryId} ${listed ? "is listed" : "is not listed"}.${others.length ? `\nOther advisories still listed (${others.length}): ${others.join(", ")}` : "\nNo other advisories listed."}`;
      } catch (err) {
        summary = `The audit's output couldn't be read: ${errorMessage(err)}\n${tail(trim(r.output))}`;
      }
      // One test, named like the fix's regressionTest: failed while the
      // advisory is listed.
      const tests: TestCase[] = listed === undefined ? [] : [{ name: testName, status: listed ? "failed" : "passed", durationMs: r.durationMs }];
      return {
        run: {
          label,
          ref,
          command: "pnpm audit --json",
          // The run passes when the advisory isn't listed; before the bump it
          // is expected to fail, like a regression test on the original code.
          exitCode: listed === undefined ? (r.exitCode || 1) : listed ? 1 : 0,
          durationMs: r.durationMs,
          tests,
          output: summary,
        },
        listed,
      };
    };

    // 1. Before the bump, the sandbox's audit must find the advisory: that
    // shows the sandbox's tree is the service's.
    opts.onStage?.("audit");
    const before = await audit("Audit before the bump", "original");
    runs.push(before.run);
    if (before.listed === false) {
      return { ok: false, runs, problems: [`the sandbox's audit doesn't list ${opts.advisoryId} before the bump, so it can't show the bump fixes it`] };
    }

    // 2. The bump, then the install.
    for (const c of opts.changes) {
      const target = c.target === "manifest" ? "package.json" : "pnpm-workspace.yaml";
      await writeFile(path.join(/* turbopackIgnore: true */ dir, target), c.target === "workspace" && workspace ? standaloneWorkspaceYaml(c.after) : c.after);
    }
    opts.onStage?.("install");
    // CI=1 (set by the runner's environment) makes the lockfile frozen by
    // default; the bump has to change it.
    const installArgs = ["install", "--no-frozen-lockfile", "--config.confirmModulesPurge=false"];
    const install = await runner.pnpm(installArgs, dir, INSTALL_TIMEOUT_MS);
    let offline = false;
    if (install.exitCode === 0) {
      runs.push(run("Install", `pnpm ${installArgs.join(" ")}`, install, lockNote));
    } else if (unreachable(install.output) && !install.timedOut) {
      // The offline fallback: resolve the lockfile from the cache and audit
      // that; nothing can be installed to typecheck or test.
      offline = true;
      const args = ["install", "--lockfile-only", "--no-frozen-lockfile", "--prefer-offline"];
      const resolved = await runner.pnpm(args, dir, INSTALL_TIMEOUT_MS);
      runs.push(
        run(
          "Install (lockfile only)",
          `pnpm ${args.join(" ")}`,
          resolved,
          `${lockNote}The registry couldn't be reached, so nothing was installed: the lockfile was resolved from pnpm's cache and audited, and typecheck and tests were skipped.\n\nThe install's error:\n${tail(trim(install.output))}\n\n`,
        ),
      );
      if (resolved.exitCode !== 0) {
        return { ok: false, runs, problems: [`the registry couldn't be reached and the lockfile couldn't be resolved offline:\n${tail(resolved.output)}`] };
      }
    } else {
      runs.push(run("Install", `pnpm ${installArgs.join(" ")}`, install, lockNote));
      return { ok: false, runs, problems: [`the install failed with the bump:\n${tail(install.output)}`] };
    }

    // 3. The audit again: the advisory must be gone.
    opts.onStage?.("reaudit");
    const after = await audit("Re-audit", "patched");
    runs.push(after.run);
    if (after.listed !== false) {
      const why = after.listed ? `${opts.advisoryId} is still listed after the bump` : `the re-audit didn't run: ${after.run.output.split("\n")[0]}`;
      return { ok: false, runs, problems: [why] };
    }
    if (offline) return { ok: true, runs, offline };

    // The installed packages run here, new versions included, so the
    // commands get the registry-safe environment the audit has, not
    // Triage's secrets.
    const env = (databaseUrl?: string): NodeJS.ProcessEnv => ({ ...auditEnv(), ...(databaseUrl && { DATABASE_URL: databaseUrl }) });

    // 4. Typecheck against the installed versions' types.
    opts.onStage?.("typecheck");
    const tscArgs = [path.join(/* turbopackIgnore: true */ dir, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--incremental", "false"];
    const types = await runner.node(tscArgs, dir, env(), TYPECHECK_TIMEOUT_MS);
    runs.push({
      label: "Typecheck",
      ref: "patched",
      command: "pnpm tsc --noEmit",
      exitCode: types.exitCode,
      durationMs: types.durationMs,
      tests: [],
      output: `${trim(types.output) || "No type errors."}\n\nexit code ${types.exitCode}`,
    });
    if (types.exitCode !== 0) return { ok: false, runs, problems: [`the app doesn't typecheck with the bump:\n${tail(types.output)}`] };

    // 5. The app's own tests, against a copy of its database like a code
    // fix's (they may use it). Without one they still run, and the output
    // says why there was none.
    opts.onStage?.("tests");
    let dbNote = "";
    try {
      database = await (opts.database ?? createSandboxDatabase)(dir, `${opts.name}-tests`);
    } catch (err) {
      dbNote = `No copy of the database for the tests (${errorMessage(err).split("\n")[0]}); they ran without one.\n\n`;
    }
    const report = path.join(/* turbopackIgnore: true */ dir, ".triage-vitest.json");
    const vitestArgs = [
      path.join(/* turbopackIgnore: true */ dir, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--passWithNoTests",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${report}`,
    ];
    const tests = await runner.node(vitestArgs, dir, env(database?.url), TESTS_TIMEOUT_MS);
    const json = (await readFile(report, "utf8").then(JSON.parse).catch(() => ({}))) as Vitest;
    const cases: TestCase[] = (json.testResults ?? []).flatMap((r) =>
      (r.assertionResults ?? []).map((a) => ({
        name: a.title,
        status: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped",
        durationMs: Math.round(a.duration ?? 0),
        error: a.failureMessages?.length ? a.failureMessages[0].split("\n")[0] : undefined,
      })),
    );
    runs.push({
      label: "Tests",
      ref: "patched",
      command: "pnpm vitest run",
      exitCode: tests.exitCode,
      durationMs: tests.durationMs,
      tests: cases,
      output: `${dbNote}${trim(tests.output)}\n\nexit code ${tests.exitCode}`,
    });
    if (tests.exitCode !== 0) return { ok: false, runs, problems: [`the app's tests fail with the bump:\n${tail(tests.output)}`] };

    return { ok: true, runs, offline };
  } catch (err) {
    return { ok: false, runs, problems: [`the sandbox couldn't be set up: ${errorMessage(err)}`] };
  } finally {
    await database?.drop();
    await removeSandbox(dir);
  }
}

function run(label: string, command: string, r: RunResult, note = ""): SandboxRun {
  return {
    label,
    ref: "patched",
    command,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    tests: [],
    output: `${note}${trim(r.output)}\n\nexit code ${r.exitCode}`,
  };
}
