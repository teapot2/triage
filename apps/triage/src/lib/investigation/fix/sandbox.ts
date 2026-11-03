import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxRun, TestCase } from "../schema";
import { exportTreeAt } from "./release-tree";

// A throwaway copy of the app where Triage tries a fix: the source, config
// and migrations, with node_modules linked rather than copied. Tests run
// against a throwaway copy of the app's database (database.ts), never the
// one the app serves from. Never touches the app itself.

// Every sandbox lives under here, dependency ones too (dependencies/sandbox.ts).
export const sandboxRoot = path.join(/* turbopackIgnore: true */ os.tmpdir(), "triage-sandbox");
const root = sandboxRoot;

// Top-level entries a sandbox doesn't need: deps (linked instead), build
// output, product photos and anything holding secrets.
const skipTop = new Set(["node_modules", ".next", "public", "tsconfig.tsbuildinfo"]);
// Paths come from the file system (the OS separator) or from git (forward
// slashes).
export const skip = (rel: string) => skipTop.has(rel.split(/[\\/]/)[0]) || path.basename(rel).startsWith(".env");

// Stops a hung test run; a passing run takes a few seconds.
const RUN_TIMEOUT_MS = 90_000;
// Sandbox output kept per run: enough to read a failure, small enough to
// store and show.
const OUTPUT_LIMIT = 6_000;

// The app's files come from the live checkout, or, with `releaseSha`, from
// that commit's tree in git: a fix for a rolled-back release is proven
// against the release's code, which the rollback has taken out of the
// checkout. `baseDir`, when given, is copied over them: the source as a
// re-run's first run read it. The dependencies and generated types are the
// live app's either way.
export async function createSandbox(
  appDir: string,
  name: string,
  opts: { baseDir?: string; releaseSha?: string } = {},
): Promise<string> {
  const dir = path.join(root, name);
  await rm(dir, { recursive: true, force: true });
  if (opts.releaseSha) await exportTreeAt(appDir, opts.releaseSha, dir, (rel) => !skip(rel));
  else await cp(appDir, dir, { recursive: true, filter: (src) => src === appDir || !skip(path.relative(appDir, src)) });
  if (opts.baseDir) await cp(opts.baseDir, dir, { recursive: true, force: true });
  // A real node_modules folder whose entries link to the app's, so tools
  // that write caches there (vitest, vite) write into the sandbox.
  await mkdir(path.join(dir, "node_modules"));
  for (const entry of await readdir(path.join(appDir, "node_modules"))) {
    if (entry.startsWith(".") && entry !== ".bin") continue;
    await symlink(path.join(appDir, "node_modules", entry), path.join(dir, "node_modules", entry), "junction");
  }
  // Next's generated route types, which next-env.d.ts imports; without them
  // the typecheck fails for reasons that have nothing to do with the fix.
  await cp(path.join(appDir, ".next", "dev", "types"), path.join(dir, ".next", "dev", "types"), { recursive: true }).catch(
    () => undefined,
  );
  return dir;
}

export async function removeSandbox(dir: string) {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export async function writeSandboxFile(dir: string, file: string, content: string) {
  const target = path.join(dir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export const readSandboxFile = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");

type Exec = { exitCode: number; output: string; durationMs: number };

// The environment code in the sandbox runs with: the app's database client
// pointed at the copy, and Triage's own address for the real database left
// out, so nothing in the sandbox can find its way back to it.
export function sandboxEnv(databaseUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" };
  delete env.SHOPFRONT_DATABASE_URL;
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  return env;
}

// Runs a command, merging stdout and stderr, and kills the whole process
// tree if it outlives the timeout (vitest forks workers).
export function exec(cmd: string, args: string[], cwd: string, env = sandboxEnv(), timeoutMs = RUN_TIMEOUT_MS): Promise<Exec> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Windows from the environment, read at run time: Turbopack folds
      // process.platform into a constant in the server build, which would
      // leave vitest's forked workers running after a timeout.
      if (process.env.OS === "Windows_NT" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      if (timedOut) output += `\nKilled after ${timeoutMs / 1000} s.`;
      resolve({ exitCode, output, durationMs: Math.round(performance.now() - started) });
    };
    child.on("error", (err) => {
      output += String(err);
      finish(127);
    });
    child.on("close", (code) => finish(timedOut ? 124 : (code ?? 1)));
  });
}

// The end of the output is where test runners put the verdict.
export const trim = (output: string) =>
  output.length <= OUTPUT_LIMIT ? output.trimEnd() : `…\n${output.slice(-OUTPUT_LIMIT).trimEnd()}`;

// Vitest's JSON report (Jest-compatible). A file that fails to load has no
// assertion results, only a message.
type VitestJson = {
  testResults?: {
    message?: string;
    assertionResults?: { title: string; fullName?: string; status: string; duration?: number | null; failureMessages?: string[] }[];
  }[];
};

const statusOf = (s: string): TestCase["status"] => (s === "passed" ? "passed" : s === "failed" ? "failed" : "skipped");

// The run, plus why no tests ran when the file failed to load. The tests
// use the database at `databaseUrl`, a copy made for this run.
export async function runTests(
  dir: string,
  testFile: string,
  meta: { label: string; ref: SandboxRun["ref"] },
  databaseUrl: string,
): Promise<{ run: SandboxRun; loadError?: string }> {
  const report = path.join(dir, ".triage-vitest.json");
  await rm(report, { force: true });
  const vitest = path.join(dir, "node_modules", "vitest", "vitest.mjs");
  const run = await exec(
    process.execPath,
    [vitest, "run", testFile, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`],
    dir,
    sandboxEnv(databaseUrl),
  );
  const json = (await readFile(report, "utf8").then(JSON.parse).catch(() => ({}))) as VitestJson;
  const results = json.testResults ?? [];
  const tests = results.flatMap((r) =>
    (r.assertionResults ?? []).map((a) => ({
      name: a.title,
      status: statusOf(a.status),
      durationMs: Math.round(a.duration ?? 0),
      error: a.failureMessages?.length ? a.failureMessages[0].split("\n")[0] : undefined,
    })),
  );
  const loadError = tests.length === 0 ? results.find((r) => r.message)?.message || "no tests ran" : undefined;
  return {
    run: {
      ...meta,
      command: `pnpm vitest run ${testFile}`,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      tests,
      output: `${trim(run.output)}\n\nexit code ${run.exitCode}`,
    },
    loadError,
  };
}

export async function runTypecheck(dir: string, meta: { label: string; ref: SandboxRun["ref"] }): Promise<SandboxRun> {
  const tsc = path.join(dir, "node_modules", "typescript", "bin", "tsc");
  const run = await exec(process.execPath, [tsc, "--noEmit", "--incremental", "false"], dir);
  return {
    ...meta,
    command: "pnpm tsc --noEmit",
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    tests: [],
    output: `${trim(run.output) || "No type errors."}\n\nexit code ${run.exitCode}`,
  };
}

// A unified diff of what the fix changes, from git's own diff so it reads
// like any patch, one file at a time in the order given (the fix before its
// test). Each file is staged side by side as a/<file> and b/<file>.
export async function unifiedDiff(
  name: string,
  files: { file: string; before: string | null; after: string }[],
): Promise<string> {
  const dir = path.join(root, `${name}-diff`);
  const parts: string[] = [];
  try {
    for (const f of files) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.join(dir, "a"), { recursive: true });
      if (f.before !== null) await writeSandboxFile(path.join(dir, "a"), f.file, f.before);
      await writeSandboxFile(path.join(dir, "b"), f.file, f.after);
      // Line-ending settings off, so Windows' CRLF warnings stay out of the
      // output (stderr is merged into it).
      const run = await exec(
        "git",
        ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "diff", "--no-index", "--no-prefix", "--no-color", "--no-ext-diff", "a", "b"],
        dir,
      );
      // Exit 1 just means the trees differ.
      if (run.exitCode > 1) throw new Error(`git diff failed: ${run.output}`);
      parts.push(
        run.output
          .split("\n")
          .filter(
            (l) =>
              !l.startsWith("diff --git ") && !l.startsWith("index ") && !l.startsWith("new file mode ") && !l.startsWith("warning: "),
          )
          .join("\n")
          .trimEnd(),
      );
    }
  } finally {
    await removeSandbox(dir);
  }
  return parts.filter(Boolean).join("\n");
}
