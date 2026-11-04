import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { dependencyPrBase } from "../dependencies/fix";
import type { DependencyAdvisory, Incident, Mitigation } from "../schema";
import { exampleIncidents } from "../fixtures";
import { conventionalTitle, pullRequestBase, pullRequestText, repoRootPatch } from "./pull-request";

const mitigation: Mitigation = {
  kind: "rollback",
  target: "9f3c2a1",
  branch: "shopfront-release/formatted-price",
  title: "Roll back shopfront to the deploy before 9f3c2a1",
  why: { text: "", evidenceIds: ["ev_commit_1"] },
  steps: [],
  undo: "",
  risk: "low",
  state: "applied",
  proposedAt: "2026-11-01T12:00:00.000Z",
};

const incident = (m?: Mitigation) => ({ id: "inc_test", mitigation: m }) as unknown as Incident;

describe("pullRequestBase", () => {
  it("targets the rolled-back release's branch", () => {
    assert.equal(pullRequestBase(incident(mitigation)), "shopfront-release/formatted-price");
  });

  it("leaves the default branch for a rollback with no branch, a flag, or no mitigation", () => {
    assert.equal(pullRequestBase(incident({ ...mitigation, branch: undefined })), undefined);
    assert.equal(pullRequestBase(incident({ ...mitigation, kind: "flag_off", target: "FF_LIST_PRICES" })), undefined);
    assert.equal(pullRequestBase(incident()), undefined);
  });
});

describe("a dependency fix's PR", () => {
  const advisory: DependencyAdvisory = {
    advisoryId: "GHSA-3g3m-2fjr-6pw4",
    package: "glob",
    title: "glob CLI: command injection",
    versions: ["10.5.0"],
    vulnerable: ">=9.0.0 <=14.0.1",
    patched: ">=14.0.2",
    severity: "moderate",
    cwe: ["CWE-400"],
    url: "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4",
    dev: false,
    direct: ["@opentelemetry/auto-instrumentations-node"],
    paths: ["@opentelemetry/auto-instrumentations-node>@opentelemetry/resource-detector-gcp>gcp-metadata>gaxios>rimraf>glob"],
    audits: 2,
    lastFoundAt: "2026-11-02T10:00:00.000Z",
  };
  const run = (label: string, ref: "original" | "patched", exitCode = 0) => ({
    label,
    ref,
    command: label.startsWith("Install") ? "pnpm install" : "pnpm audit --json",
    exitCode,
    durationMs: 10,
    tests: [],
    output: "",
  });
  const dependencyIncident = (validation = [run("Audit before the bump", "original", 1), run("Install", "patched"), run("Re-audit", "patched"), run("Typecheck", "patched"), run("Tests", "patched")]) =>
    ({
      id: "inc_deps",
      title: "Vulnerable dependency: glob@10.5.0 (moderate, GHSA-3g3m-2fjr-6pw4)",
      dependency: advisory,
      report: {
        summary: "glob 10.5.0 is in the tree through the OpenTelemetry auto-instrumentations.",
        hypotheses: [],
        verdict: { kind: "insufficient_evidence", reason: "" },
        servicesQueried: [],
        exposure: { verdict: "transitive_only", rationale: { text: "No file in src imports glob; only rimraf uses it.", evidenceIds: [] } },
      },
      fix: {
        summary: "Override glob to ^14.0.2 in the workspace's pnpm-workspace.yaml.",
        patch: "",
        files: ["../../pnpm-workspace.yaml"],
        regressionTest: { file: "../../pnpm-workspace.yaml", name: "pnpm audit no longer lists GHSA-3g3m-2fjr-6pw4" },
        risk: "medium",
        touchesData: false,
        bump: { package: "glob", from: "10.5.0", to: "14.0.2", kind: "override", major: true },
      },
      validation,
    }) as unknown as Incident;

  it("cites the advisory, the exposure, the bump and the proof", () => {
    const { title, body } = pullRequestText(dependencyIncident(), { lockfile: "regenerated" });
    assert.equal(title, "fix(deps): bump glob to 14.0.2 (GHSA-3g3m-2fjr-6pw4)");
    assert.match(body, /\*\*\[GHSA-3g3m-2fjr-6pw4\]\(https:\/\/github\.com\/advisories\/GHSA-3g3m-2fjr-6pw4\)\*\*: glob CLI/);
    assert.match(body, /Severity: moderate · CWE-400/);
    assert.match(body, /\*\*Transitive only\.\*\* No file in src imports glob/);
    assert.match(body, /\*\*Override\.\*\*.*pnpm-workspace\.yaml/);
    assert.match(body, /\[!WARNING\]\n> \*\*This crosses a major version\*\* \(10\.5\.0 to 14\.0\.2\)/);
    assert.match(body, /`pnpm-lock\.yaml` was regenerated/);
    assert.match(body, /lists GHSA-3g3m-2fjr-6pw4 before the bump and not after it/);
    assert.match(body, /\| Re-audit \| `pnpm audit --json` \| 0 \|/);
    assert.match(body, /incident resolves when the audit no longer finds GHSA-3g3m-2fjr-6pw4/);
  });

  it("says when the lockfile isn't in it, and when typecheck and tests didn't run", () => {
    const offline = dependencyIncident([run("Audit before the bump", "original", 1), run("Install (lockfile only)", "patched"), run("Re-audit", "patched")]);
    const { body } = pullRequestText(offline);
    assert.match(body, /`pnpm-lock\.yaml` is not in this PR: run `pnpm install`/);
    assert.match(body, /\*\*Typecheck and tests did not run\.\*\*/);
  });

  it("applies a file outside the app from the repository root", () => {
    const patch = "--- a/../../pnpm-workspace.yaml\n+++ b/../../pnpm-workspace.yaml\n@@ -1 +1,3 @@\n packages: []\n+overrides:\n+  a: 1\n--- a/package.json\r\n+++ b/package.json\r\n@@ -1 +1 @@\n-x\n+y";
    assert.equal(
      repoRootPatch(patch, "apps/shopfront"),
      "--- a/pnpm-workspace.yaml\n+++ b/pnpm-workspace.yaml\n@@ -1 +1,3 @@\n packages: []\n+overrides:\n+  a: 1\n--- a/apps/shopfront/package.json\r\n+++ b/apps/shopfront/package.json\r\n@@ -1 +1 @@\n-x\n+y",
    );
    assert.equal(repoRootPatch("--- a/src/x.ts\n+++ b/src/x.ts\n", "apps/shopfront"), undefined);
    assert.throws(() => repoRootPatch("--- a/../../../x\n+++ b/../../../x\n", "apps/shopfront"), /outside the repository/);
  });

  // Against this repository's own history: the initial commit added
  // drizzle-orm to Shopfront's package.json (and the lockfile); the
  // formatted-price release (1e69623) touches no dependency.
  const shopfront = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "shopfront");
  it("goes against the deployed release's branch when that release brought the package in", async () => {
    const drizzle = { dependency: { ...advisory, package: "drizzle-orm" } };
    const deployed = (sha: string) => async () => ({ sha, branch: "shopfront-release/vulnerable-dep" });
    assert.equal(await dependencyPrBase(drizzle, shopfront, deployed("edaf2d2")), "shopfront-release/vulnerable-dep");
    assert.equal(await dependencyPrBase(drizzle, shopfront, deployed("1e69623")), undefined);
    assert.equal(await dependencyPrBase(drizzle, shopfront, async () => undefined), undefined);
    assert.equal(await dependencyPrBase(drizzle, shopfront, async () => ({ sha: "edaf2d2" })), undefined);
    // A package the release never mentions.
    const leftPad = { dependency: { ...advisory, package: "left-pad" } };
    assert.equal(await dependencyPrBase(leftPad, shopfront, deployed("edaf2d2")), undefined);
  });
});

describe("a code fix's PR title", () => {
  it("is a Conventional Commit scoped to the service, from the leading hypothesis", () => {
    const poolLeak = exampleIncidents.find((i) => i.id === "inc_pool_leak")!;
    assert.equal(pullRequestText(poolLeak).title, "fix(shopfront): connection leak in getStockLevel exhausts the pg pool");
  });

  it("lowers only a capitalised first word, drops a final period, and stays under 120 characters", () => {
    assert.equal(conventionalTitle("shopfront", "Connection leak in getStock."), "fix(shopfront): connection leak in getStock");
    assert.equal(conventionalTitle("shopfront", "N+1 queries on /products"), "fix(shopfront): N+1 queries on /products");
    assert.equal(conventionalTitle("shopfront", "DB pool exhausted"), "fix(shopfront): DB pool exhausted");
    assert.equal(conventionalTitle("shopfront", "x".repeat(200)).length, 120);
  });
});
