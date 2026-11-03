import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { archivedRefusal } from "./archive";
import { resolved } from "./postmortem/test-incidents";
import type { Incident, RunModels } from "./schema";
import { closeDb } from "../db";

// Archive, restore and delete in the store and through the routes, on a
// temp working directory so .data is ours. The store resolves its folder
// when it loads, so everything that touches .data is imported after the
// chdir.
const cwd = process.cwd();
let dir: string;
let store: typeof import("./store");
let archive: typeof import("./archive-store");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-archive-"));
  process.chdir(dir);
  store = await import("./store");
  archive = await import("./archive-store");
});
after(async () => {
  process.chdir(cwd);
  // Windows may still hold a just-renamed file for a moment.
  closeDb();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

// A resolved incident of our own, saved: the pool leak after its quiet
// window, its fix still awaiting approval.
async function saved(id: string, patch: Partial<Incident> = {}): Promise<Incident> {
  const incident = { ...resolved(), id, ...patch };
  await store.saveIncident(incident);
  return incident;
}

const models: RunModels = { investigate: { provider: "meta", model: "muse-spark-1.3" } };
const ids = (incidents: Incident[]) => incidents.map((i) => i.id);
const exists = (file: string) => readdir(path.dirname(file)).then((names) => names.includes(path.basename(file)), () => false);

describe("archiving in the store", () => {
  it("archives a closed incident, hides it from the default list, and restores it", async () => {
    await saved("inc_arch_list");
    const done = await archive.archiveIncident("inc_arch_list", "2026-11-02T10:00:00.000Z");
    assert.ok(done.ok);
    assert.equal(done.incident.archivedAt, "2026-11-02T10:00:00.000Z");
    assert.equal((await store.getIncident("inc_arch_list"))?.archivedAt, "2026-11-02T10:00:00.000Z");

    assert.ok(!ids(await store.listIncidents()).includes("inc_arch_list"));
    assert.deepEqual(ids(await store.listIncidents({ archived: "only" })), ["inc_arch_list"]);
    const all = ids(await store.listIncidents({ archived: "include" }));
    assert.ok(all.includes("inc_arch_list") && all.includes("inc_pool_leak"));

    // A second archive is harmless and keeps the first time.
    const again = await archive.archiveIncident("inc_arch_list", "2026-11-02T11:00:00.000Z");
    assert.ok(again.ok);
    assert.equal(again.incident.archivedAt, "2026-11-02T10:00:00.000Z");

    const restored = await archive.restoreIncident("inc_arch_list");
    assert.ok(restored.ok);
    assert.equal(restored.incident.archivedAt, undefined);
    assert.equal((await store.getIncident("inc_arch_list"))?.archivedAt, undefined);
    assert.ok(ids(await store.listIncidents()).includes("inc_arch_list"));
    assert.deepEqual(ids(await store.listIncidents({ archived: "only" })), []);
  });

  it("refuses an open incident, one with work still running, and an unknown one", async () => {
    await saved("inc_arch_open", { status: "awaiting_approval", resolvedAt: undefined });
    assert.deepEqual(await archive.archiveIncident("inc_arch_open"), { ok: false, status: 409, error: "Resolve the incident first" });
    const base = resolved();
    await saved("inc_arch_pr", { approval: { ...base.approval!, state: "approved", prState: "opening" } });
    assert.deepEqual(await archive.archiveIncident("inc_arch_pr"), { ok: false, status: 409, error: "Wait for the PR to open" });
    await saved("inc_arch_mit", { mitigation: { ...base.mitigation!, state: "running" } });
    assert.deepEqual(await archive.archiveIncident("inc_arch_mit"), { ok: false, status: 409, error: "Wait for the mitigation to finish" });
    assert.deepEqual(await archive.archiveIncident("inc_arch_nope"), { ok: false, status: 404, error: "unknown incident: inc_arch_nope" });
    assert.equal((await store.getIncident("inc_arch_open"))?.archivedAt, undefined);
  });

  it("deletes only an archived incident, with its question images and run snapshot", async () => {
    await saved("inc_arch_del");
    const { saveQuestionImage } = await import("./ask/images");
    await saveQuestionImage("inc_arch_del", "q_1", new Uint8Array([1, 2, 3]), "image/png");
    const snapshot = path.join(dir, ".data", "snapshots", "inc_arch_del");
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(snapshot, "db.json"), "{}");

    assert.deepEqual(await archive.deleteIncident("inc_arch_del"), { ok: false, status: 409, error: "Archive the incident before deleting it" });
    assert.ok(await store.getIncident("inc_arch_del"));

    assert.ok((await archive.archiveIncident("inc_arch_del")).ok);
    assert.deepEqual(await archive.deleteIncident("inc_arch_del"), { ok: true });
    assert.equal(await store.getIncident("inc_arch_del"), undefined);
    assert.equal(await exists(path.join(dir, ".data", "question-images", "inc_arch_del")), false);
    assert.equal(await exists(snapshot), false);
    assert.deepEqual(await archive.deleteIncident("inc_arch_del"), { ok: false, status: 404, error: "unknown incident: inc_arch_del" });
  });

  it("archives a bundled example but never deletes it", async () => {
    // The control run found nothing wrong, so it's closed.
    assert.ok((await archive.archiveIncident("inc_control")).ok);
    assert.ok(!ids(await store.listIncidents()).includes("inc_control"));
    assert.deepEqual(await archive.deleteIncident("inc_control"), { ok: false, status: 409, error: "Example incidents can't be deleted" });
    assert.ok((await archive.restoreIncident("inc_control")).ok);
    assert.ok(ids(await store.listIncidents()).includes("inc_control"));
  });
});

describe("recovering on restart", () => {
  it("cuts off work an archived incident still claims, like an active one's", async () => {
    const base = resolved();
    await saved("inc_arch_restart", {
      archivedAt: "2026-11-02T10:00:00.000Z",
      approval: { ...base.approval!, state: "approved", prState: "opening" },
    });
    const { failInterruptedRuns } = await import("./recover");
    assert.ok((await failInterruptedRuns()) >= 1);
    const after = await store.getIncident("inc_arch_restart");
    assert.equal(after?.approval?.prState, "failed");
    assert.equal(after?.archivedAt, "2026-11-02T10:00:00.000Z");
  });
});

describe("an archived incident is read-only", () => {
  const id = "inc_arch_ro";
  before(async () => {
    const base = resolved();
    // A failed mitigation could be approved again (the retry), and the fix
    // awaits approval: both would go through if it weren't archived.
    await saved(id, { mitigation: { ...base.mitigation!, state: "failed", error: "flag service down" } });
    assert.ok((await archive.archiveIncident(id)).ok);
  });

  it("refuses the decisions the page and Slack's buttons make", async () => {
    const { decideApproval, retryPr } = await import("./approval");
    const { decideMitigation } = await import("./mitigation/decide");
    const refused = { ok: false, status: 409, error: archivedRefusal };
    assert.deepEqual(await decideMitigation(id, "approved"), refused);
    assert.deepEqual(await decideApproval(id, "approved", undefined, true), refused);
    assert.deepEqual(await retryPr(id), refused);
  });

  it("refuses a question, a re-run, a promotion and a verification", async () => {
    const { startQuestion } = await import("./ask/start");
    const { startRerun, promoteRun } = await import("./rerun");
    const { startVerification, verificationRefusal } = await import("./verify");
    assert.deepEqual(await startQuestion(id, "why?"), { ok: false, status: 409, error: archivedRefusal });
    await assert.rejects(startRerun(id, models), { message: archivedRefusal });
    await assert.rejects(promoteRun(id, 2), { message: archivedRefusal });
    assert.equal(verificationRefusal((await store.getIncident(id))!, "manual"), archivedRefusal);
    await assert.rejects(startVerification(id, { after: "manual", since: new Date().toISOString() }), { message: archivedRefusal });
  });

  it("answers 409 from every route that changes it, and leaves it as it was", async () => {
    const before = await store.getIncident(id);
    const params = Promise.resolve({ id });
    const post = (body: unknown) =>
      new Request(`http://localhost/api/incidents/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const responses: [string, Response][] = [
      ["approval", await (await import("../../app/api/incidents/[id]/approval/route")).POST(post({ decision: "approved", dataReviewed: true }), { params })],
      ["mitigation", await (await import("../../app/api/incidents/[id]/mitigation/route")).POST(post({ decision: "approved" }), { params })],
      ["resolve", await (await import("../../app/api/incidents/[id]/resolution/route")).POST(post({ action: "resolve" }), { params })],
      ["reopen", await (await import("../../app/api/incidents/[id]/resolution/route")).POST(post({ action: "reopen" }), { params })],
      ["verify", await (await import("../../app/api/incidents/[id]/resolution/route")).POST(post({ action: "verify" }), { params })],
      ["questions", await (await import("../../app/api/incidents/[id]/questions/route")).POST(post({ text: "why?" }), { params })],
      ["postmortem", await (await import("../../app/api/incidents/[id]/postmortem/route")).POST(post({}), { params })],
      ["reruns", await (await import("../../app/api/incidents/[id]/reruns/route")).POST(post({ models }), { params })],
      [
        "promote",
        await (await import("../../app/api/incidents/[id]/reruns/[number]/promote/route")).POST(post({}), {
          params: Promise.resolve({ id, number: "2" }),
        }),
      ],
      ["pull-request", await (await import("../../app/api/incidents/[id]/pull-request/route")).POST(post({}), { params })],
    ];
    for (const [name, res] of responses) {
      assert.equal(res.status, 409, name);
      assert.deepEqual(await res.json(), { error: archivedRefusal }, name);
    }
    assert.deepEqual(await store.getIncident(id), before);
  });
});

describe("the archive and delete routes", () => {
  const id = "inc_arch_route";
  let archiveRoute: typeof import("../../app/api/incidents/[id]/archive/route");
  let incidentRoute: typeof import("../../app/api/incidents/[id]/route");
  before(async () => {
    archiveRoute = await import("../../app/api/incidents/[id]/archive/route");
    incidentRoute = await import("../../app/api/incidents/[id]/route");
    await saved(id);
    await saved("inc_arch_route_open", { status: "diagnosed", resolvedAt: undefined });
  });
  const req = (method: string) => new Request(`http://localhost/api/incidents/${id}`, { method });
  const ctx = (incident = id) => ({ params: Promise.resolve({ id: incident }) });

  it("archives, answers the same on a second POST, and restores with DELETE", async () => {
    const first = await archiveRoute.POST(req("POST"), ctx());
    assert.equal(first.status, 200);
    const { archivedAt } = await first.json();
    assert.match(archivedAt, /^\d{4}-\d{2}-\d{2}T/);
    const second = await archiveRoute.POST(req("POST"), ctx());
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { archivedAt });

    const restored = await archiveRoute.DELETE(req("DELETE"), ctx());
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), { archivedAt: null });
    assert.equal((await store.getIncident(id))?.archivedAt, undefined);
  });

  it("answers 409 with the reason for an open incident, and 404 for an unknown one", async () => {
    const open = await archiveRoute.POST(req("POST"), ctx("inc_arch_route_open"));
    assert.equal(open.status, 409);
    assert.deepEqual(await open.json(), { error: "Resolve the incident first" });
    assert.equal((await archiveRoute.POST(req("POST"), ctx("inc_arch_route_nope"))).status, 404);
  });

  it("deletes for good only once archived", async () => {
    const refused = await incidentRoute.DELETE(req("DELETE"), ctx());
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "Archive the incident before deleting it" });
    assert.equal((await incidentRoute.DELETE(req("DELETE"), ctx("inc_pool_leak"))).status, 409);

    assert.equal((await archiveRoute.POST(req("POST"), ctx())).status, 200);
    const deleted = await incidentRoute.DELETE(req("DELETE"), ctx());
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal(await store.getIncident(id), undefined);
    assert.equal((await incidentRoute.DELETE(req("DELETE"), ctx())).status, 404);
  });
});
