import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import { InvestigationRecorder } from "../recorder";
import type { DependencyAdvisory, Incident } from "../schema";
import {
  bumpPatch,
  compareVersions,
  crossesMajor,
  isDirect,
  lowerBounds,
  pickPatchedVersion,
  planBump,
  raisedSpec,
  runDependencyFix,
  satisfies,
  setDependencySpec,
  setOverride,
} from "./fix";
import type { RunResult, Runner } from "./sandbox";

describe("version ranges", () => {
  it("reads the comparators advisories use", () => {
    assert.ok(satisfies("14.0.2", ">=14.0.2"));
    assert.ok(!satisfies("14.0.1", ">=14.0.2"));
    assert.ok(satisfies("10.5.0", ">=9.0.0 <=14.0.1"));
    assert.ok(!satisfies("14.0.2", ">=9.0.0 <=14.0.1"));
    assert.ok(satisfies("7.5.2", ">7.5.1"));
    assert.ok(satisfies("2.1.0", ">=1.2.0 <2.0.0 || >=2.1.0"));
    assert.ok(!satisfies("2.0.5", ">=1.2.0 <2.0.0 || >=2.1.0"));
    assert.ok(satisfies("1.4.0", ">= 1.2.0 < 2"));
  });

  it("expands carets, tildes, x-ranges and partial versions", () => {
    assert.ok(satisfies("7.9.0", "^7.5.2"));
    assert.ok(!satisfies("8.0.0", "^7.5.2"));
    assert.ok(satisfies("0.25.9", "^0.25.0"));
    assert.ok(!satisfies("0.26.0", "^0.25.0"));
    assert.ok(!satisfies("0.0.4", "^0.0.3"));
    assert.ok(satisfies("1.2.9", "~1.2.3"));
    assert.ok(!satisfies("1.3.0", "~1.2.3"));
    assert.ok(satisfies("1.9.9", "1.x"));
    assert.ok(satisfies("1.2.7", "1.2"));
    assert.ok(!satisfies("1.3.0", "<=1.2"));
    assert.ok(satisfies("1.2.9", "<=1.2"));
    assert.ok(satisfies("3.0.0", "1.0.0 - 3.0.0"));
  });

  it("never offers a prerelease, and satisfies nothing from a range it can't read", () => {
    assert.ok(!satisfies("14.1.0-rc.1", ">=14.0.2"));
    assert.ok(!satisfies("1.0.0", "latest"));
  });

  it("sorts versions, prereleases before their release", () => {
    assert.deepEqual(["10.0.0", "9.1.0", "10.0.0-beta.2", "10.0.0-beta.10"].sort(compareVersions), [
      "9.1.0",
      "10.0.0-beta.2",
      "10.0.0-beta.10",
      "10.0.0",
    ]);
  });

  it("works out each alternative's lowest version", () => {
    assert.deepEqual(lowerBounds(">=14.0.2"), ["14.0.2"]);
    assert.deepEqual(lowerBounds(">7.5.1"), ["7.5.2"]);
    assert.deepEqual(lowerBounds(">=1.2.0 <2 || >=2.1.0"), ["1.2.0", "2.1.0"]);
    assert.deepEqual(lowerBounds("<0.0.0"), []);
  });
});

describe("pickPatchedVersion", () => {
  const published = ["7.5.0", "7.5.1", "7.5.2", "7.5.3", "7.6.0", "8.0.0-rc.1", "8.0.0"];

  it("takes the lowest release in the patched range", () => {
    assert.equal(pickPatchedVersion({ patched: ">=7.5.2", current: ["7.5.1"], published }), "7.5.2");
  });

  it("prefers a fix at or above the newest copy the tree holds, so nothing moves down", () => {
    const backported = ["2.0.5", "2.1.0", "3.0.0", "3.0.4"];
    assert.equal(pickPatchedVersion({ patched: ">=2.0.5 <3.0.0 || >=3.0.4", current: ["3.0.1"], published: backported }), "3.0.4");
    assert.equal(pickPatchedVersion({ patched: ">=2.0.5 <3.0.0 || >=3.0.4", current: ["2.0.1"], published: backported }), "2.0.5");
  });

  it("falls back to the range's lower bound without the registry", () => {
    assert.equal(pickPatchedVersion({ patched: ">=14.0.2", current: ["10.5.0"] }), "14.0.2");
  });

  it("finds nothing when no release satisfies the range", () => {
    assert.equal(pickPatchedVersion({ patched: ">=9.0.0", current: ["7.5.1"], published }), undefined);
  });
});

describe("crossesMajor", () => {
  it("is the major, or the minor below 1.0.0", () => {
    assert.equal(crossesMajor("10.5.0", "14.0.2"), true);
    assert.equal(crossesMajor("7.5.1", "7.5.2"), false);
    assert.equal(crossesMajor("0.18.20", "0.25.0"), true);
    assert.equal(crossesMajor("0.25.0", "0.25.3"), false);
  });
});

describe("the bump writer", () => {
  const manifestText = `{\r\n  "name": "@triage/shopfront",\r\n  "dependencies": {\r\n    "next": "16.4.3",\r\n    "semver": "7.5.1"\r\n  },\r\n  "devDependencies": {\r\n    "semver-like": "^1.0.0"\r\n  }\r\n}\r\n`;
  const semver: DependencyAdvisory = {
    advisoryId: "GHSA-c2qf-rxjj-qqgw",
    package: "semver",
    title: "semver vulnerable to Regular Expression Denial of Service",
    versions: ["7.5.1"],
    vulnerable: ">=7.0.0 <7.5.2",
    patched: ">=7.5.2",
    severity: "high",
    cwe: ["CWE-1333"],
    url: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw",
    dev: false,
    direct: ["semver"],
    paths: ["semver"],
    audits: 1,
    lastFoundAt: "2026-11-02T10:00:00.000Z",
  };
  const glob: DependencyAdvisory = {
    ...semver,
    advisoryId: "GHSA-3g3m-2fjr-6pw4",
    package: "glob",
    versions: ["10.5.0"],
    vulnerable: ">=9.0.0 <=14.0.1",
    patched: ">=14.0.2",
    severity: "moderate",
    direct: ["@opentelemetry/auto-instrumentations-node"],
    paths: ["@opentelemetry/auto-instrumentations-node>@opentelemetry/resource-detector-gcp>gcp-metadata>gaxios>rimraf>glob"],
  };
  const workspace = { file: "../../pnpm-workspace.yaml", text: 'packages:\n  - "apps/*"\n\nallowBuilds:\n  esbuild: true\n' };

  it("keeps a range's operator when raising it", () => {
    assert.equal(raisedSpec("^7.5.1", "7.5.2"), "^7.5.2");
    assert.equal(raisedSpec("~1.2.3", "1.3.0"), "~1.3.0");
    assert.equal(raisedSpec("7.5.1", "7.5.2"), "7.5.2");
    assert.equal(raisedSpec(">=1", "2.0.0"), "^2.0.0");
  });

  it("changes one dependency's range and nothing else in package.json", () => {
    const after = setDependencySpec(manifestText, "dependencies", "semver", "7.5.2");
    assert.equal(after, manifestText.replace('"semver": "7.5.1"', '"semver": "7.5.2"'));
    assert.throws(() => setDependencySpec(manifestText, "dependencies", "semver-like", "2.0.0"), /not in package.json's dependencies/);
  });

  it("adds, replaces and creates overrides in pnpm-workspace.yaml", () => {
    const added = setOverride(workspace.text, "glob@>=9.0.0 <=14.0.1", "^14.0.2");
    assert.equal(added, `${workspace.text}\noverrides:\n  "glob@>=9.0.0 <=14.0.1": "^14.0.2"\n`);
    const replaced = setOverride(added, "glob@>=9.0.0 <=14.0.1", "^14.0.3");
    assert.match(replaced, /"glob@>=9.0.0 <=14.0.1": "\^14.0.3"/);
    assert.equal(replaced.match(/glob@/g)?.length, 1);
    const beside = setOverride("overrides:\n  lodash: 4.17.21\nallowBuilds: {}\n", "glob@<14.0.2", "^14.0.2");
    assert.equal(beside, 'overrides:\n  "glob@<14.0.2": "^14.0.2"\n  lodash: 4.17.21\nallowBuilds: {}\n');
    assert.equal(setOverride("overrides: {}\r\n", "a", "1"), 'overrides:\r\n  "a": "1"\r\n');
  });

  it("raises a direct dependency in package.json", () => {
    assert.ok(isDirect(semver, JSON.parse(manifestText)));
    const plan = planBump(semver, "7.5.2", { text: manifestText }, workspace);
    assert.deepEqual(plan.bump, { package: "semver", from: "7.5.1", to: "7.5.2", kind: "direct", major: false });
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].file, "package.json");
    assert.match(plan.changes[0].after, /"semver": "7.5.2"/);
    assert.equal(plan.risk, "low");
    assert.match(plan.summary, /^Raise semver from 7\.5\.1 to 7\.5\.2 in package\.json/);
  });

  it("overrides a transitive one at the workspace root, keyed on the vulnerable range, and says it crosses a major", () => {
    assert.ok(!isDirect(glob, JSON.parse(manifestText)));
    const plan = planBump(glob, "14.0.2", { text: manifestText }, workspace);
    assert.deepEqual(plan.bump, { package: "glob", from: "10.5.0", to: "14.0.2", kind: "override", major: true });
    assert.equal(plan.changes[0].file, "../../pnpm-workspace.yaml");
    assert.equal(plan.changes[0].target, "workspace");
    assert.match(plan.changes[0].after, /overrides:\n {2}"glob@>=9\.0\.0 <=14\.0\.1": "\^14\.0\.2"/);
    assert.equal(plan.overrideKey, "glob@>=9.0.0 <=14.0.1");
    assert.equal(plan.risk, "medium");
    assert.match(plan.summary, /through @opentelemetry\/auto-instrumentations-node/);
    assert.match(plan.summary, /crosses a major version \(10\.5\.0 to 14\.0\.2\)/);
  });

  it("overrides a package that is direct and also pulled in by others", () => {
    const both = { ...semver, paths: ["semver", "eslint>semver"], direct: ["semver", "eslint"] };
    assert.equal(planBump(both, "7.5.2", { text: manifestText }, workspace).bump.kind, "override");
  });

  it("diffs a file outside the app under its path relative to the app", async () => {
    const plan = planBump(glob, "14.0.2", { text: manifestText }, workspace);
    const patch = await bumpPatch("fix-test", plan.changes);
    assert.match(patch, /^--- a\/\.\.\/\.\.\/pnpm-workspace\.yaml$/m);
    assert.match(patch, /^\+\+\+ b\/\.\.\/\.\.\/pnpm-workspace\.yaml$/m);
    assert.match(patch, /^\+ {2}"glob@>=9\.0\.0 <=14\.0\.1": "\^14\.0\.2"$/m);
  });
});

// The stage end to end in a throwaway workspace (an app two folders under a
// pnpm-workspace.yaml), with the registry and the sandbox's commands
// stubbed.
describe("runDependencyFix", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "triage-depfix-test-"));
  after(() => rm(base, { recursive: true, force: true }));
  const appDir = path.join(base, "apps", "shopfront");
  await mkdir(path.join(appDir, "src"), { recursive: true });
  await writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "shopfront", dependencies: { semver: "7.5.1", next: "16.4.3" } }, null, 2));
  await writeFile(path.join(appDir, "src", "index.ts"), "export {};\n");
  await writeFile(path.join(base, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
  await writeFile(
    path.join(base, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/shopfront:\n    dependencies:\n      semver:\n        specifier: 7.5.1\n        version: 7.5.1\n\npackages:\n\n  semver@7.5.1:\n    resolution: {integrity: sha512-x}\n",
  );

  const advisory: DependencyAdvisory = {
    advisoryId: "GHSA-c2qf-rxjj-qqgw",
    package: "semver",
    title: "semver ReDoS",
    versions: ["7.5.1"],
    vulnerable: ">=7.0.0 <7.5.2",
    patched: ">=7.5.2",
    severity: "high",
    cwe: ["CWE-1333"],
    url: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw",
    dev: false,
    direct: ["semver"],
    paths: ["semver"],
    audits: 1,
    lastFoundAt: "2026-11-02T10:00:00.000Z",
  };
  const incidentWith = (dependency: DependencyAdvisory): Incident => {
    const example = structuredClone(exampleIncidents.find((i) => i.id === "inc_pool_leak")!);
    return { ...example, id: "inc_deps_test", fix: undefined, fixRun: undefined, validation: undefined, approval: undefined, dependency };
  };
  const result = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, output: stdout, durationMs: 5, timedOut: false });
  const auditJson = (listed: boolean) =>
    JSON.stringify({
      advisories: listed
        ? {
            1: {
              id: 1,
              module_name: "semver",
              severity: "high",
              vulnerable_versions: ">=7.0.0 <7.5.2",
              patched_versions: ">=7.5.2",
              github_advisory_id: "GHSA-c2qf-rxjj-qqgw",
              findings: [{ version: "7.5.1", paths: [".>semver"] }],
            },
          }
        : {},
    });
  // Lists the advisory until an install has run.
  const runner = (): Runner & { calls: string[] } => {
    let installed = false;
    const calls: string[] = [];
    return {
      calls,
      async pnpm(args) {
        calls.push(`pnpm ${args[0]}`);
        if (args[0] === "install") installed = true;
        return args[0] === "audit" ? result(auditJson(!installed), installed ? 0 : 1) : result("Done");
      },
      async node(args) {
        calls.push(args.some((a) => a.endsWith("vitest.mjs")) ? "vitest" : "tsc");
        return result("ok");
      },
    };
  };

  it("proves a direct bump and asks for approval", async () => {
    const recorder = new InvestigationRecorder(incidentWith(advisory), async () => {});
    const r = runner();
    await runDependencyFix(recorder, appDir, {
      notify: false,
      published: async () => ["7.5.0", "7.5.1", "7.5.2", "7.6.0"],
      runner: r,
      database: async () => ({ name: "copy", url: "postgres://sandbox/copy", drop: async () => {} }),
    });
    const incident = recorder.incident;
    assert.equal(incident.fixRun?.status, "proven");
    assert.equal(incident.status, "awaiting_approval");
    assert.deepEqual(incident.fix?.bump, { package: "semver", from: "7.5.1", to: "7.5.2", kind: "direct", major: false });
    assert.deepEqual(incident.fix?.files, ["package.json"]);
    assert.match(incident.fix!.patch, /^-\s+"semver": "7\.5\.1",?$/m);
    assert.match(incident.fix!.patch, /^\+\s+"semver": "7\.5\.2",?$/m);
    assert.deepEqual(incident.fix?.regressionTest, { file: "package.json", name: "pnpm audit no longer lists GHSA-c2qf-rxjj-qqgw" });
    assert.equal(incident.fix?.dataChange?.detected, false);
    assert.deepEqual(
      incident.validation?.map((v) => [v.label, v.ref, v.exitCode]),
      [
        ["Audit before the bump", "original", 1],
        ["Install", "patched", 0],
        ["Re-audit", "patched", 0],
        ["Typecheck", "patched", 0],
        ["Tests", "patched", 0],
      ],
    );
    assert.deepEqual(r.calls, ["pnpm audit", "pnpm install", "pnpm audit", "tsc", "vitest"]);
  });

  it("declines when no patched version is published", async () => {
    const recorder = new InvestigationRecorder(incidentWith({ ...advisory, patched: undefined }), async () => {});
    const r = runner();
    await runDependencyFix(recorder, appDir, { notify: false, runner: r });
    assert.equal(recorder.incident.fixRun?.status, "declined");
    assert.match(recorder.incident.fixRun!.declinedBecause!, /No patched version of semver/);
    assert.equal(recorder.incident.fix, undefined);
    assert.deepEqual(r.calls, []);
  });

  it("declines when the registry has no release in the patched range", async () => {
    const recorder = new InvestigationRecorder(incidentWith(advisory), async () => {});
    await runDependencyFix(recorder, appDir, { notify: false, runner: runner(), published: async () => ["7.5.0", "7.5.1"] });
    assert.equal(recorder.incident.fixRun?.status, "declined");
    assert.match(recorder.incident.fixRun!.declinedBecause!, /satisfies the advisory's patched range/);
  });

  it("fails, with the runs, when the advisory survives the bump", async () => {
    const recorder = new InvestigationRecorder(incidentWith(advisory), async () => {});
    const stuck: Runner = {
      async pnpm(args) {
        return args[0] === "audit" ? result(auditJson(true), 1) : result("Done");
      },
      async node() {
        return result("ok");
      },
    };
    await runDependencyFix(recorder, appDir, { notify: false, runner: stuck, published: async () => ["7.5.2"] });
    assert.equal(recorder.incident.fixRun?.status, "failed");
    assert.match(recorder.incident.fixRun!.error!, /still listed after the bump/);
    assert.deepEqual(recorder.incident.validation?.map((v) => v.label), ["Audit before the bump", "Install", "Re-audit"]);
    assert.equal(recorder.incident.fix, undefined);
  });
});
