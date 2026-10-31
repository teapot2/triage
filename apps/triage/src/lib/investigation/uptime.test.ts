import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb } from "../db";
import type { MessageKind } from "../notifications/types";
import type { Incident } from "./schema";
import type { UptimeSample } from "./uptime/model";

// The uptime loop over a fake probe and a fake clock, ticked by hand, on a
// temp working directory so .data is ours. The store resolves its folder
// when it loads, so everything that touches .data is imported after the
// chdir.
const cwd = process.cwd();
let dir: string;
let loop: typeof import("./uptime");
let store: typeof import("./store");
let InvestigationRecorder: typeof import("./recorder").InvestigationRecorder;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-uptime-loop-"));
  process.chdir(dir);
  loop = await import("./uptime");
  store = await import("./store");
  ({ InvestigationRecorder } = await import("./recorder"));
  const { defaultCheck, saveChecks } = await import("./uptime/checks");
  await saveChecks([defaultCheck({ id: "chk_shop01", name: "Shopfront", url: "http://localhost:3001/api/health", slowMs: 1000 })]);
});
after(async () => {
  // Windows won't delete the temp directory while the database is open.
  closeDb();
  process.chdir(cwd);
  // Windows may still hold a just-renamed file for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const MINUTE = 60_000;
let clock = Date.parse("2026-10-30T12:00:00.000Z");
let outcome: UptimeSample["outcome"] = "ok";
const sent: { kind: MessageKind; incidentId: string }[] = [];
// Each investigation's recorder, finished by hand: it saves the whole
// incident, as a real run does, over whatever the loop patched meanwhile.
const recorders: InstanceType<typeof InvestigationRecorder>[] = [];

const report: NonNullable<Incident["report"]> = {
  hypotheses: [],
  verdict: { kind: "inconclusive", missing: ["application logs"] },
  servicesQueried: [],
};

function restart() {
  loop.uptimeForTests.restart({
    now: () => clock,
    probe: async () => ({
      at: new Date(clock).toISOString(),
      ms: outcome === "slow" ? 2500 : 40,
      ...(outcome === "down" ? { error: "ECONNREFUSED" } : { status: 200 }),
      outcome,
    }),
    notify: (kind, incident) => void sent.push({ kind, incidentId: incident.id }),
    investigationProblem: async () => undefined,
    investigate: async (incident) => void recorders.push(new InvestigationRecorder(incident, store.saveIncident)),
  });
}

// One check's worth of time, then a tick: the default interval is 30 s.
async function check(o: UptimeSample["outcome"], times = 1) {
  outcome = o;
  for (let n = 0; n < times; n++) {
    clock += 30_000;
    await loop.uptimeForTests.tick();
  }
}

const uptimeIncidents = async () => (await store.listIncidents()).filter((i) => i.uptime);
const kinds = () => sent.map((s) => s.kind);

describe("uptime loop", () => {
  let first: Incident;

  it("opens one incident on the third slow check and only counts the next ten", async () => {
    restart();
    await check("ok");
    await check("slow", 2);
    assert.equal((await uptimeIncidents()).length, 0);
    await check("slow");
    const opened = await uptimeIncidents();
    assert.equal(opened.length, 1);
    first = opened[0];
    assert.equal(first.trigger.rule?.id, "uptime:chk_shop01:slow");
    assert.equal(first.trigger.route, "http://localhost:3001/api/health");
    assert.deepEqual(first.uptime, { checkId: "chk_shop01", rule: "slow", failedChecks: 3, lastFailedAt: new Date(clock).toISOString() });
    assert.deepEqual(kinds(), ["incident_opened"]);
    assert.equal(loop.uptimeState()[0].status, "alerting");
    assert.equal(loop.uptimeState()[0].incidentId, first.id);

    await check("slow", 10);
    // The investigation ends after them; its save keeps the count.
    const recorder = recorders.at(-1)!;
    recorder.update({ status: "diagnosed", report });
    await recorder.flush();
    const still = await uptimeIncidents();
    assert.equal(still.length, 1);
    assert.equal(still[0].status, "diagnosed");
    assert.equal(still[0].uptime?.failedChecks, 13);
    assert.equal(still[0].uptime?.lastFailedAt, new Date(clock).toISOString());
    assert.deepEqual(kinds(), ["incident_opened"]);
  });

  it("resolves after three ok checks, with the verification and one message", async () => {
    await check("ok", 2);
    assert.equal((await store.getIncident(first.id))?.status, "diagnosed");
    await check("ok");
    const resolved = (await store.getIncident(first.id))!;
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolvedAt, new Date(clock).toISOString());
    const v = resolved.verification!;
    assert.equal(v.after, "uptime");
    assert.equal(v.status, "resolved");
    assert.equal(v.since, new Date(clock - 60_000).toISOString());
    assert.equal(v.windowMinutes, 1);
    assert.equal(v.metric, first.trigger.metric);
    assert.deepEqual(v.series.map((p) => p.value), [40, 40, 40]);
    assert.equal(resolved.uptime?.recoveredAt, resolved.resolvedAt);

    await check("ok", 3);
    assert.deepEqual(kinds(), ["incident_opened", "resolved"]);
    assert.equal(loop.uptimeState()[0].status, "healthy");
  });

  it("reopens the same incident on a failure 10 minutes after the resolution", async () => {
    const resolvedAt = Date.parse((await store.getIncident(first.id))!.resolvedAt!);
    clock = resolvedAt + 10 * MINUTE - 3 * 30_000;
    await check("slow", 3);
    const incidents = await uptimeIncidents();
    assert.equal(incidents.length, 1);
    const reopened = incidents[0];
    assert.equal(reopened.id, first.id);
    assert.equal(reopened.status, "diagnosed");
    assert.equal(reopened.reopenings?.length, 1);
    assert.equal(reopened.reopenings?.[0].by, "watch");
    assert.equal(reopened.uptime?.failedChecks, 16);
    assert.deepEqual(kinds(), ["incident_opened", "resolved", "incident_reopened"]);

    // And recovery is confirmed again before the next resolution message.
    await check("ok", 3);
    assert.equal((await store.getIncident(first.id))?.status, "resolved");
    assert.deepEqual(kinds(), ["incident_opened", "resolved", "incident_reopened", "resolved"]);
  });

  it("opens a new incident on a failure 40 minutes after the resolution", async () => {
    clock += 40 * MINUTE;
    await check("slow", 3);
    const incidents = await uptimeIncidents();
    assert.equal(incidents.length, 2);
    assert.notEqual(incidents[0].id, first.id);
    assert.equal(sent.at(-1)?.kind, "incident_opened");
    assert.equal(sent.at(-1)?.incidentId, incidents[0].id);
  });

  it("opens nothing after a restart mid-episode", async () => {
    const [open] = await uptimeIncidents();
    const before = sent.length;
    restart();
    // Counted as they come, written once a minute: the third check writes.
    await check("slow", 3);
    const incidents = await uptimeIncidents();
    assert.equal(incidents.length, 2);
    assert.equal(incidents[0].uptime?.failedChecks, 6);
    assert.equal(sent.length, before);
    assert.equal(loop.uptimeState()[0].incidentId, open.id);
  });

  it("waits for the investigation's report before resolving", async () => {
    const [open] = await uptimeIncidents();
    await check("ok", 3);
    const waiting = (await store.getIncident(open.id))!;
    assert.equal(waiting.status, "investigating");
    assert.equal(waiting.uptime?.recoveredAt, new Date(clock).toISOString());

    const recorder = recorders.at(-1)!;
    recorder.update({ status: "diagnosed", report });
    await recorder.flush();
    // The next tick resolves it, with no check due.
    clock += 5000;
    await loop.uptimeForTests.tick();
    const resolved = (await store.getIncident(open.id))!;
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolvedAt, waiting.uptime?.recoveredAt);
    assert.deepEqual(sent.at(-1), { kind: "resolved", incidentId: open.id });
  });

  it("leaves the error on the check when no model can investigate", async () => {
    // A down check on a fresh process with no episode to join.
    for (const i of await uptimeIncidents()) await store.patchIncident(i.id, (x) => ({ ...x, status: "resolved", resolvedAt: new Date(clock - 2 * 60 * MINUTE).toISOString() }));
    restart();
    loop.uptimeForTests.restart({
      now: () => clock,
      probe: async () => ({ at: new Date(clock).toISOString(), ms: 5, error: "ECONNREFUSED", outcome: "down" }),
      notify: () => {},
      investigationProblem: async () => "MODEL_API_KEY is not set.",
    });
    await check("down", 12);
    assert.equal((await uptimeIncidents()).filter((i) => i.status !== "resolved").length, 0);
    assert.match(loop.uptimeState()[0].error ?? "", /MODEL_API_KEY is not set\. No incident was opened\./);
  });

  it("resolves an incident whose investigation failed, since no report is coming", async () => {
    restart();
    await check("slow", 3);
    const [open] = (await uptimeIncidents()).filter((i) => i.status !== "resolved");
    const recorder = recorders.at(-1)!;
    recorder.update({ status: "failed", run: { ...open.run!, finishedAt: new Date(clock).toISOString(), error: "model error" } });
    await recorder.flush();
    await check("ok", 3);
    assert.equal((await store.getIncident(open.id))?.status, "resolved");
    assert.deepEqual(sent.at(-1), { kind: "resolved", incidentId: open.id });
  });

  it("turns a Slow episode into the Down incident once the endpoint stops answering", async () => {
    for (const i of await uptimeIncidents()) await store.patchIncident(i.id, (x) => ({ ...x, status: "resolved", resolvedAt: new Date(clock - 2 * 60 * MINUTE).toISOString() }));
    restart();
    await check("ok");
    await check("slow", 3);
    const [open] = (await uptimeIncidents()).filter((i) => i.status !== "resolved");
    assert.equal(open.severity, "sev3");
    assert.equal(open.uptime?.rule, "slow");
    const before = sent.length;
    await check("down", 11);
    const down = (await store.getIncident(open.id))!;
    assert.equal(down.severity, "sev2");
    assert.equal(down.title, "localhost:3001 is not responding");
    assert.equal(down.trigger.rule?.id, "uptime:chk_shop01:down");
    assert.match(down.trigger.metric, /^uptime\.availability/);
    assert.equal(down.trigger.threshold, 100);
    assert.equal(down.uptime?.rule, "down");
    assert.equal(down.uptime?.failedChecks, 14);
    assert.equal((await uptimeIncidents()).filter((i) => i.status !== "resolved").length, 1);
    assert.equal(sent.length, before);
    assert.equal(loop.uptimeState()[0].rule, "down");
    // Out of the way of the next case, which opens its own Down incident.
    await store.patchIncident(open.id, (x) => ({ ...x, status: "resolved", resolvedAt: new Date(clock - 2 * 60 * MINUTE).toISOString() }));
  });

  it("resolves a Down incident with its recovery in availability, the metric it charts", async () => {
    restart();
    await check("down", 12);
    const [open] = (await uptimeIncidents()).filter((i) => i.status !== "resolved");
    assert.equal(open.trigger.rule?.id, "uptime:chk_shop01:down");
    assert.match(open.trigger.metric, /^uptime\.availability/);
    const recorder = recorders.at(-1)!;
    recorder.update({ status: "diagnosed", report });
    await recorder.flush();
    await check("ok", 3);
    const v = (await store.getIncident(open.id))!.verification!;
    assert.equal(v.after, "uptime");
    assert.equal(v.metric, open.trigger.metric);
    assert.deepEqual(v.series.map((p) => p.value), [100, 100, 100]);
  });

  it("starts a check over when it is pointed at another URL", async () => {
    restart();
    await check("slow", 3);
    assert.equal(loop.uptimeState()[0].status, "alerting");
    const { readChecks, saveChecks } = await import("./uptime/checks");
    const [c] = await readChecks();
    await saveChecks([{ ...c, url: "http://localhost:3001/api/products" }]);
    await check("ok");
    const [state] = loop.uptimeState();
    assert.equal(state.url, "http://localhost:3001/api/products");
    assert.equal(state.status, "healthy");
    assert.equal(state.healthyStreak, 1);
    assert.equal(state.incidentId, undefined);
  });
});
