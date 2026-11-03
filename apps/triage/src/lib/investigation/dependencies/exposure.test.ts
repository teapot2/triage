import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runInvestigation } from "../agent";
import type { Stage } from "../fanout/run";
import {
  type Call,
  inOrder,
  lastUserText,
  scriptedModel,
  systemText,
  toolNames,
  toolOutputs,
  type Turn,
  userText,
} from "../scripted-model";
import {
  type DependencyAdvisory,
  type Evidence,
  exposureVerdicts,
  findUnknownEvidenceIds,
  type Incident,
  incidentSchema,
  reportProblems,
} from "../schema";
import type { TelemetrySource } from "../source";
import { exposureReport, grepSource, NO_DEPENDENCY_MITIGATION } from "./exposure";

// The exposure stage: grep_source over a real directory, the report it
// builds for each verdict, and runInvestigation routing a dependency
// incident through it with a scripted model.

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-exposure-"));
});
after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

// A source over a directory on disk, as the live one reads Shopfront's.
function dirSource(root: string): Pick<TelemetrySource, "listSourceFiles" | "readSource"> {
  async function walk(rel: string): Promise<string[]> {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((e) => {
        const p = rel ? `${rel}/${e.name}` : e.name;
        return e.isDirectory() ? walk(p) : Promise.resolve([p]);
      }),
    );
    return nested.flat();
  }
  return {
    listSourceFiles: async () => (await walk("")).sort(),
    readSource: async (p) => {
      const content = await readFile(path.join(root, p), "utf8").catch(() => undefined);
      return content === undefined ? undefined : { path: p, content };
    },
  };
}

const files: Record<string, string> = {
  "package.json": '{\n  "dependencies": {\n    "semver": "^7.5.1"\n  }\n}\n',
  "src/lib/version.ts": 'import semver from "semver";\n\nexport const supported = (v: string) => semver.satisfies(v, ">=2");\n',
  "src/app/page.tsx": 'import { supported } from "@/lib/version";\nexport default function Page() { return supported("3.0.0"); }\n',
  "scripts/seed.ts": 'const semver = require("semver");\r\n',
};

describe("grepSource", () => {
  before(async () => {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    }
  });

  it("finds every line with the string, case-insensitively, with its line number", async () => {
    const { matches, files: searched } = await grepSource(dirSource(dir), { pattern: "SEMVER" });
    assert.equal(searched, 4);
    assert.deepEqual(
      matches.map((m) => `${m.file}:${m.line}`),
      ["package.json:3", "scripts/seed.ts:1", "src/lib/version.ts:1", "src/lib/version.ts:3"],
    );
    // A Windows line ending isn't part of the line.
    assert.equal(matches[1].text, 'const semver = require("semver");');
  });

  it("takes a regular expression, and a directory to search under", async () => {
    const imports = await grepSource(dirSource(dir), { pattern: String.raw`from ["']semver["']|require\(["']semver`, regex: true });
    assert.deepEqual(
      imports.matches.map((m) => m.file),
      ["scripts/seed.ts", "src/lib/version.ts"],
    );
    const underSrc = await grepSource(dirSource(dir), { pattern: "semver", path: "./src" });
    assert.equal(underSrc.files, 2);
    assert.ok(underSrc.matches.every((m) => m.file.startsWith("src/")));
  });

  it("treats a plain pattern literally, and says when a regex doesn't compile", async () => {
    assert.equal((await grepSource(dirSource(dir), { pattern: ".satisfies(" })).matches.length, 1);
    await assert.rejects(grepSource(dirSource(dir), { pattern: "(", regex: true }), /Invalid regular expression/);
  });
});

const advisory: DependencyAdvisory = {
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
  lastFoundAt: "2026-11-02T12:00:00.000Z",
};

describe("exposureReport", () => {
  const evidence: Evidence[] = [
    { id: "ev_web_1", tool: "dependency_audit", kind: "web", summary: "the advisory", url: advisory.url },
    { id: "ev_source_1", tool: "grep_source", kind: "source", summary: "import", file: "src/lib/version.ts", startLine: 1, code: "x" },
  ];

  it("passes the report's checks for every verdict, the exposure leading", () => {
    for (const verdict of exposureVerdicts) {
      const rationale = { text: `The service's code ${verdict} because of what was found`, evidenceIds: ["ev_source_1"] };
      const report = exposureReport(advisory, { verdict, rationale }, "semver is vulnerable.", "ev_web_1", ["shopfront"]);
      assert.deepEqual(reportProblems(report), [], verdict);
      assert.deepEqual(findUnknownEvidenceIds(report, evidence), [], verdict);
      assert.equal(report.verdict.kind, "root_cause");
      assert.equal(report.hypotheses.length, 3);
      const [leading, ...others] = report.hypotheses;
      assert.equal(leading.status, "leading");
      assert.deepEqual(leading.causalChain.propagation, rationale);
      assert.ok(others.every((h) => h.status === "rejected" && h.rejectedBecause?.evidenceIds[0] === "ev_source_1"));
      assert.equal(report.exposure?.verdict, verdict);
    }
  });

  it("says when no fixed version is published", () => {
    const report = exposureReport(
      { ...advisory, patched: undefined },
      { verdict: "transitive_only", rationale: { text: "Nothing in the code imports it", evidenceIds: ["ev_web_1"] } },
      "semver is vulnerable.",
      "ev_web_1",
      ["shopfront"],
    );
    assert.match(report.hypotheses[0].causalChain.rootCause.text, /no fixed version is published$/);
  });
});

// runInvestigation on a dependency incident, the source in memory.

const stage: Stage = { provider: "meta", model: "scripted", effort: "high", baseUrl: "http://127.0.0.1:9/v1", apiKey: "test" };

const memorySource: TelemetrySource = {
  describe: () => ({
    id: "deps:shopfront",
    now: "2026-11-02T12:00:00.000Z",
    services: [{ name: "shopfront", dependsOn: [] }],
    metrics: [],
  }),
  queryLogs: async () => [],
  queryTraces: async () => [],
  queryMetric: async () => undefined,
  dbDiagnostics: async () => ({ query: "", rows: [] }),
  listSourceFiles: async () => Object.keys(files).sort(),
  readSource: async (p) => (files[p] === undefined ? undefined : { path: p, content: files[p] }),
  gitLog: async () => [],
  deployHistory: async () => [],
};

function dependencyIncident(): Incident {
  return {
    id: "inc_deps_test",
    title: "Vulnerable dependency: semver@7.5.1 (high, GHSA-c2qf-rxjj-qqgw)",
    service: "shopfront",
    severity: "sev3",
    status: "investigating",
    detectedAt: "2026-11-02T12:00:00.000Z",
    openedBy: "watch",
    trigger: {
      metric: "vulnerable_dependencies{advisory=GHSA-c2qf-rxjj-qqgw}",
      unit: "advisories",
      threshold: 1,
      observed: 1,
      series: [{ t: "2026-11-02T12:00:00.000Z", value: 1 }],
      route: "semver",
    },
    steps: [],
    evidence: [],
    run: { source: "deps:shopfront", model: "scripted", startedAt: "2026-11-02T12:00:00.000Z" },
    dependency: advisory,
  };
}

async function investigate(script: (call: Call) => Turn, opts: { appDir?: string } = {}) {
  const seen: Call[] = [];
  const incident = await runInvestigation(dependencyIncident(), memorySource, {
    stage,
    save: async () => {},
    languageModel: () => scriptedModel(script, seen),
    ...opts,
  });
  return { incident, seen };
}

// grep_source's evidence, in file order: package.json:3 (ev_source_1),
// scripts/seed.ts:1 (2), src/lib/version.ts:1 and :3 (3 and 4); then the
// file read whole (5). ev_web_1 is the advisory.
const grep: Turn = { text: "Searching.", tools: [["grep_source", { pattern: "semver" }]] };
const read: Turn = { tools: [["read_source", { path: "src/lib/version.ts" }]] };
const summary = "Shopfront uses a semver version with a known denial-of-service flaw, and its version check calls it.";
const reachable = {
  verdict: "reachable",
  rationale: { text: "src/lib/version.ts imports semver and calls satisfies on every page", evidenceIds: ["ev_source_3", "ev_source_5"] },
  summary,
};

describe("runInvestigation on a dependency incident", () => {
  it("checks exposure instead of telemetry, and saves a root-cause report with it", async () => {
    const { incident, seen } = await investigate(
      inOrder(
        grep,
        read,
        // Reachable citing only the advisory: turned back.
        { tools: [["submit_exposure", { ...reachable, rationale: { ...reachable.rationale, evidenceIds: ["ev_web_1"] } }]] },
        { tools: [["submit_exposure", reachable]] },
      ),
    );
    assert.equal(incident.status, "diagnosed", incident.run?.error);

    // The prompt is the advisory; the tools are the stage's own.
    assert.match(userText(seen[0]), /Advisory: GHSA-c2qf-rxjj-qqgw: semver vulnerable/);
    assert.match(userText(seen[0]), /Vulnerable: >=7\.0\.0 <7\.5\.2\nPatched: >=7\.5\.2/);
    assert.match(systemText(seen[0]), /reachable, transitive_only|reachable:/);
    assert.deepEqual(toolNames(seen[0]), ["grep_source", "list_files", "read_source", "submit_exposure"]);

    const rejected = toolOutputs(seen[3]).find((o) => o.toolName === "submit_exposure")?.value as { accepted: boolean; problems: string[] };
    assert.equal(rejected.accepted, false);
    assert.match(rejected.problems[0], /reachable verdict must cite the lines/);
    assert.equal(incident.run?.rejectedReports, 1);

    const report = incident.report!;
    assert.deepEqual(reportProblems(report), []);
    assert.deepEqual(findUnknownEvidenceIds(report, incident.evidence), []);
    assert.equal(report.verdict.kind, "root_cause");
    assert.equal(report.exposure?.verdict, "reachable");
    assert.deepEqual(report.exposure?.rationale.evidenceIds, ["ev_source_3", "ev_source_5"]);
    assert.equal(report.summary, summary);
    assert.deepEqual(report.servicesQueried, ["shopfront"]);

    // The advisory first, as the audit's step and a page; then the stage's.
    assert.deepEqual(
      incident.steps.map((s) => s.tool),
      ["dependency_audit", "grep_source", "read_source"],
    );
    const [page] = incident.evidence;
    assert.equal(page.kind, "web");
    assert.equal(page.kind === "web" && page.url, advisory.url);
    assert.ok(incident.evidence.filter((e) => e.kind === "source").length === 5);

    assert.equal(incident.mitigation, undefined);
    assert.equal(incident.noMitigation?.why, NO_DEPENDENCY_MITIGATION);
    assert.equal(incident.run?.modelSteps, 4);
    assert.equal(incident.snapshot, undefined);
    incidentSchema.parse(incident);
  });

  it("nudges a run that stops in plain text, and fails one that never submits", async () => {
    const nudged = await investigate(inOrder(grep, { text: "It is reachable." }, { tools: [["submit_exposure", { ...reachable, rationale: { ...reachable.rationale, evidenceIds: ["ev_source_3"] } }]] }));
    assert.equal(nudged.incident.status, "diagnosed", nudged.incident.run?.error);
    assert.match(lastUserText(nudged.seen[2]), /^You have not submitted an accepted exposure verdict yet\./);

    const silent = await investigate(() => ({ text: "Hmm." }));
    assert.equal(silent.incident.status, "failed");
    assert.equal(silent.incident.noMitigation, undefined);
    assert.match(silent.incident.run?.error ?? "", /^No accepted report after 3 model steps/);
  });

  it("goes on to the fix stage with an app directory", async () => {
    const exposure = inOrder(grep, { tools: [["submit_exposure", { ...reachable, rationale: { ...reachable.rationale, evidenceIds: ["ev_source_3"] } }]] });
    const { incident } = await investigate(
      // The fix stage's calls get no answer, so it records a failure.
      (call) => (toolNames(call).includes("submit_exposure") ? exposure() : new Error("no fix in this test")),
      { appDir: dir },
    );
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    assert.ok(incident.fixRun, "the fix stage ran");
  });
});
