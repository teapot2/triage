import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeDb } from "../db";
import type { MessageKind } from "../notifications/types";
import type { AuditResult } from "./dependencies/audit";
import type { Finding } from "./dependencies/model";
import type { Incident } from "./schema";
import type { TelemetrySource } from "./source";

// The dependency loop over a fake audit and a fake clock, on a temp working
// directory so .data is ours. Everything that touches .data is imported
// after the chdir.
const cwd = process.cwd();
let dir: string;
let loop: typeof import("./dependencies");
let store: typeof import("./store");
let findings: typeof import("./dependencies/store");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-deps-loop-"));
  process.chdir(dir);
  loop = await import("./dependencies");
  store = await import("./store");
  findings = await import("./dependencies/store");
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const HOUR = 3_600_000;
let clock = Date.parse("2026-11-02T12:00:00.000Z");
let next: Finding[] | Error = [];
const sent: { kind: MessageKind; incidentId: string }[] = [];
const investigated: string[] = [];

const semver: Finding = {
  advisoryId: "GHSA-c2qf-rxjj-qqgw",
  service: "shopfront",
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
};
const glob: Finding = { ...semver, advisoryId: "GHSA-3g3m-2fjr-6pw4", package: "glob", severity: "moderate", direct: ["x"], paths: ["x>glob"] };
const devHigh: Finding = { ...semver, advisoryId: "GHSA-dev0-0000-0000", package: "esbuild", dev: true, direct: ["drizzle-kit"] };

const emptySource = (service: string, now: number): TelemetrySource => ({
  describe: () => ({ id: `deps:${service}`, now: new Date(now).toISOString(), services: [{ name: service, dependsOn: [] }], metrics: [] }),
  queryLogs: async () => [],
  queryTraces: async () => [],
  queryMetric: async ({ name }) => {
    const { dependencySeries } = await import("./dependencies/source");
    return dependencySeries(service, now).find((s) => s.name === name);
  },
  dbDiagnostics: async () => ({ query: "", rows: [] }),
  readSource: async () => undefined,
  listSourceFiles: async () => [],
  gitLog: async () => [],
  deployHistory: async () => [],
});

function restart(enabled = true) {
  loop.dependenciesForTests.restart(
    {
      now: () => clock,
      audit: async (): Promise<AuditResult> => {
        if (next instanceof Error) throw next;
        const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
        for (const f of next) counts[f.severity]++;
        return { packageManager: "pnpm", findings: next, counts, raw: "{}" };
      },
      notify: (kind, incident) => void sent.push({ kind, incidentId: incident.id }),
      investigationProblem: async () => undefined,
      source: async (service, now) => emptySource(service, now),
      investigate: async (incident) => void investigated.push(incident.id),
    },
    { enabled },
  );
}

async function audit(found: Finding[] | Error) {
  next = found;
  clock += 6 * HOUR;
  return loop.dependenciesForTests.audit();
}

const depIncidents = async () => (await store.listIncidents()).filter((i) => i.dependency);
// The investigation, finished by hand: a report, so the incident can settle.
const diagnose = (id: string) =>
  store.patchIncident(id, (i): Incident => ({
    ...i,
    status: "diagnosed",
    report: { hypotheses: [], verdict: { kind: "inconclusive", missing: [] }, servicesQueried: [] },
  }));

describe("dependency loop", () => {
  beforeEach(() => restart());

  it("lists findings below the floor and dev ones without opening anything", async () => {
    const a = await audit([glob, devHigh]);
    assert.equal(a.error, undefined);
    assert.equal(a.runtime, 1);
    assert.deepEqual(await depIncidents(), []);
    assert.deepEqual(
      findings.listFindings("shopfront").map((f) => f.package).sort(),
      ["esbuild", "glob"],
    );
  });

  it("opens one incident per advisory and counts later audits on it", async () => {
    await audit([glob, semver]);
    let [incident] = await depIncidents();
    assert.ok(incident);
    assert.equal(incident.severity, "sev3");
    assert.equal(incident.trigger.rule?.id, "deps:shopfront:GHSA-c2qf-rxjj-qqgw");
    assert.equal(incident.trigger.route, "semver");
    assert.equal(incident.dependency?.audits, 1);
    assert.deepEqual(investigated, [incident.id]);
    assert.deepEqual(sent.at(-1), { kind: "incident_opened", incidentId: incident.id });
    assert.equal(findings.getFinding("shopfront", semver.advisoryId)?.incidentId, incident.id);

    await audit([glob, semver]);
    const all = await depIncidents();
    assert.equal(all.length, 1);
    [incident] = all;
    assert.equal(incident.dependency?.audits, 2);
    // The finding's first sighting stands.
    const f = findings.getFinding("shopfront", semver.advisoryId)!;
    assert.ok(Date.parse(f.firstSeen) < Date.parse(f.lastSeen));
  });

  it("keeps the findings through a failed audit and opens nothing", async () => {
    const before = findings.listFindings("shopfront").length;
    const a = await audit(new Error("pnpm audit failed: getaddrinfo ENOTFOUND registry.npmjs.org"));
    assert.match(a.error ?? "", /ENOTFOUND/);
    assert.equal(findings.listFindings("shopfront").length, before);
    assert.equal(loop.dependencyState().status, "error");
    assert.equal((await depIncidents()).length, 1);
  });

  it("waits for the investigation, then resolves once the advisory is gone", async () => {
    const [incident] = await depIncidents();
    // Still investigating: gone is recorded, the incident waits.
    await audit([glob]);
    let saved = (await store.getIncident(incident.id))!;
    assert.equal(saved.status, "investigating");
    assert.ok(saved.dependency?.goneAt);
    assert.equal(findings.getFinding("shopfront", semver.advisoryId)?.goneAt !== undefined, true);

    await diagnose(incident.id);
    await audit([glob]);
    saved = (await store.getIncident(incident.id))!;
    assert.equal(saved.status, "resolved");
    assert.equal(saved.verification?.after, "dependencies");
    assert.match(saved.verification?.note ?? "", /without a Triage PR/);
    assert.deepEqual(sent.at(-1), { kind: "resolved", incidentId: incident.id });
  });

  it("reopens the incident when the advisory comes back within 30 days", async () => {
    const [incident] = await depIncidents();
    await audit([glob, semver]);
    const all = await depIncidents();
    assert.equal(all.length, 1);
    const saved = all[0];
    assert.equal(saved.id, incident.id);
    assert.equal(saved.status, "diagnosed");
    assert.equal(saved.reopenings?.length, 1);
    assert.equal(saved.dependency?.goneAt, undefined);
    assert.deepEqual(sent.at(-1), { kind: "incident_reopened", incidentId: incident.id });
  });

  it("verifies a merged fix: still found is a note, gone resolves it", async () => {
    const [incident] = await depIncidents();
    await loop.startDependencyVerification(incident.id, new Date(clock).toISOString());
    // startDependencyVerification audits too; wait for it, with the advisory
    // still in the tree (the checkout hasn't pulled the merge).
    next = [glob, semver];
    await loop.dependenciesForTests.audit();
    let saved = (await store.getIncident(incident.id))!;
    assert.equal(saved.verification?.status, "verifying");
    assert.match(saved.verification?.note ?? "", /still finds semver@7\.5\.1/);

    await audit([glob]);
    saved = (await store.getIncident(incident.id))!;
    assert.equal(saved.status, "resolved");
    assert.equal(saved.verification?.status, "resolved");
    assert.equal(saved.verification?.note, undefined);
    assert.equal(saved.verification?.series.at(-1)?.value, 0);
  });

  it("opens nothing while the watch is paused, but still resolves", async () => {
    restart(false);
    const critical: Finding = { ...semver, advisoryId: "GHSA-crit-0000-0000", package: "lodash", severity: "critical" };
    await audit([glob, critical]);
    assert.ok(!(await depIncidents()).some((i) => i.dependency?.advisoryId === critical.advisoryId));
    assert.equal(loop.dependencyState().status, "paused");
  });
});
