import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { BumpChange } from "./fix";
import { proveBump, type RunResult, type Runner, standaloneLockfile, standaloneWorkspaceYaml, unreachable } from "./sandbox";

// pnpm 12's lockfile: a first document about pnpm itself, then the
// workspace's, one importer per app.
const lock = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.16.1
        version: 12.16.1

packages:

  pnpm@12.16.1:
    resolution: {integrity: sha512-p}

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .: {}

  apps/shopfront:
    dependencies:
      glob:
        specifier: ^10.0.0
        version: 10.5.0

  apps/triage:
    dependencies:
      zod:
        specifier: ^4.0.0
        version: 4.6.7

packages:

  glob@10.5.0:
    resolution: {integrity: sha512-g}
`;

describe("the sandbox's workspace", () => {
  it("cuts the workspace lockfile down to the service's importer, as the root", () => {
    const own = standaloneLockfile(lock, "apps/shopfront")!;
    assert.match(own, /^lockfileVersion: '9.0'/);
    assert.match(own, /importers:\n\n {2}\.:\n {4}dependencies:\n {6}glob:\n {8}specifier: \^10\.0\.0\n {8}version: 10\.5\.0\n\npackages:/);
    assert.ok(!own.includes("apps/triage"));
    assert.ok(!own.includes("zod"));
    assert.ok(!own.includes("pnpm@12.16.1"));
    assert.match(own, /settings:\n {2}autoInstallPeers: true/);
    assert.equal(standaloneLockfile(lock, "apps/missing"), undefined);
  });

  it("keeps the workspace's settings without its packages", () => {
    const yaml = 'packages:\n  - "apps/*"\n  - "libs/*"\n\nallowBuilds:\n  esbuild: true\n\noverrides:\n  "glob@<14.0.2": "^14.0.2"\n';
    assert.equal(standaloneWorkspaceYaml(yaml), 'allowBuilds:\n  esbuild: true\n\noverrides:\n  "glob@<14.0.2": "^14.0.2"\n');
  });

  it("tells an unreachable registry from a failed install", () => {
    assert.ok(unreachable("ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/glob: request to … failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org"));
    assert.ok(!unreachable("ERR_PNPM_NO_MATCHING_VERSION No matching version found for glob@^99.0.0"));
  });
});

describe("proveBump", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "triage-depsandbox-test-"));
  after(() => rm(base, { recursive: true, force: true }));
  const appDir = path.join(base, "apps", "shopfront");
  await mkdir(path.join(appDir, "node_modules", "glob"), { recursive: true });
  await writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "shopfront", dependencies: { "@opentelemetry/auto-instrumentations-node": "^0.82.0" } }));
  await writeFile(path.join(appDir, ".env.local"), "SECRET=1\n");
  const workspaceYaml = 'packages:\n  - "apps/*"\n';
  await writeFile(path.join(base, "pnpm-workspace.yaml"), workspaceYaml);
  await writeFile(path.join(base, "pnpm-lock.yaml"), lock);

  const advisoryId = "GHSA-3g3m-2fjr-6pw4";
  const auditJson = (listed: boolean) =>
    JSON.stringify({
      advisories: listed
        ? {
            1: {
              id: 1,
              module_name: "glob",
              severity: "moderate",
              github_advisory_id: advisoryId,
              findings: [{ version: "10.5.0", paths: [".>@opentelemetry/auto-instrumentations-node>glob"] }],
            },
          }
        : {},
    });
  const ok = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, output: stdout, durationMs: 3, timedOut: false });
  const change: BumpChange = {
    file: "../../pnpm-workspace.yaml",
    target: "workspace",
    before: workspaceYaml,
    after: `${workspaceYaml}\noverrides:\n  "glob@>=9.0.0 <=14.0.1": "^14.0.2"\n`,
  };
  const prove = (runner: Runner) =>
    proveBump({
      appDir,
      name: "deps-sandbox-test",
      service: "shopfront",
      advisoryId,
      lockRoot: base,
      importer: "apps__shopfront",
      changes: [change],
      runner,
      database: async () => {
        throw new Error("no Postgres here");
      },
    });

  it("installs in its own workspace with the override, audits before and after, typechecks and tests", async () => {
    const seen: { files: string[]; yaml: string; lock: string; env?: NodeJS.ProcessEnv }[] = [];
    let installed = false;
    const result = await prove({
      async pnpm(args, cwd) {
        if (args[0] === "install") {
          installed = true;
          const { readdir } = await import("node:fs/promises");
          seen.push({
            files: (await readdir(cwd)).sort(),
            yaml: await readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8"),
            lock: await readFile(path.join(cwd, "pnpm-lock.yaml"), "utf8"),
          });
          assert.ok(!args.includes("--ignore-workspace"));
          assert.ok(args.includes("--no-frozen-lockfile"));
          return ok("Packages: +1");
        }
        return ok(auditJson(!installed), installed ? 0 : 1);
      },
      async node(args, _cwd, env) {
        seen.at(-1)!.env = env;
        return ok(args.some((a) => a.endsWith("vitest.mjs")) ? "Test Files  1 passed" : "");
      },
    });
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("\n"));
    assert.equal(result.ok && result.offline, false);
    // No node_modules link, no secrets, and the workspace files of its own.
    assert.deepEqual(seen[0].files, ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
    assert.equal(seen[0].yaml, 'overrides:\n  "glob@>=9.0.0 <=14.0.1": "^14.0.2"\n');
    assert.match(seen[0].lock, /importers:\n\n {2}\.:\n/);
    // The installed code runs without Triage's secrets.
    assert.equal(seen[0].env?.DATABASE_URL, undefined);
    assert.deepEqual(
      result.runs.map((r) => [r.label, r.exitCode, r.tests.map((t) => t.status).join()]),
      [
        ["Audit before the bump", 1, "failed"],
        ["Install", 0, ""],
        ["Re-audit", 0, "passed"],
        ["Typecheck", 0, ""],
        ["Tests", 0, ""],
      ],
    );
    assert.match(result.runs[4].output, /No copy of the database for the tests \(no Postgres here\)/);
    // Removed after.
    await assert.rejects(stat(path.join(os.tmpdir(), "triage-sandbox", "deps-sandbox-test")));
  });

  it("falls back to resolving the lockfile when the registry can't be reached, and skips typecheck and tests", async () => {
    let resolved = false;
    const calls: string[] = [];
    const result = await prove({
      async pnpm(args) {
        calls.push(args.join(" "));
        if (args[0] === "install" && !args.includes("--lockfile-only")) return ok("ERR_PNPM_META_FETCH_FAIL getaddrinfo ENOTFOUND registry.npmjs.org", 1);
        if (args[0] === "install") {
          resolved = true;
          return ok("Done");
        }
        return ok(auditJson(!resolved));
      },
      async node() {
        throw new Error("nothing runs offline");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.offline, true);
    assert.deepEqual(result.runs.map((r) => r.label), ["Audit before the bump", "Install (lockfile only)", "Re-audit"]);
    assert.match(result.runs[1].output, /typecheck and tests were skipped/);
    assert.ok(calls.includes("install --lockfile-only --no-frozen-lockfile --prefer-offline"));
  });

  it("fails on a typecheck error, a real proof failure for a major bump", async () => {
    let installed = false;
    const result = await prove({
      async pnpm(args) {
        if (args[0] === "install") installed = true;
        return args[0] === "install" ? ok("Done") : ok(auditJson(!installed));
      },
      async node() {
        return ok("src/lib/files.ts(3,10): error TS2305: Module '\"glob\"' has no exported member 'sync'.", 2);
      },
    });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.problems[0] : "", /doesn't typecheck with the bump/);
    assert.deepEqual(result.runs.map((r) => r.label), ["Audit before the bump", "Install", "Re-audit", "Typecheck"]);
  });

  it("refuses to call it fixed when the sandbox never had the advisory", async () => {
    const result = await prove({
      async pnpm() {
        return ok(auditJson(false));
      },
      async node() {
        return ok("");
      },
    });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.problems[0] : "", /doesn't list GHSA-3g3m-2fjr-6pw4 before the bump/);
  });
});
