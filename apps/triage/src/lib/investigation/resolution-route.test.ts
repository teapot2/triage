import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { resolved } from "./postmortem/test-incidents";
import { closeDb } from "../db";

// Reopening by hand through the resolution route, on a temp working
// directory so .data is ours. The store resolves its folder when it loads,
// so it and the route are imported after the chdir.
const cwd = process.cwd();
let dir: string;
let store: typeof import("./store");
let route: typeof import("../../app/api/incidents/[id]/resolution/route");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-resolution-"));
  process.chdir(dir);
  store = await import("./store");
  route = await import("../../app/api/incidents/[id]/resolution/route");
});
after(async () => {
  process.chdir(cwd);
  closeDb();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const reopen = (id: string, body: object) =>
  route.POST(
    new Request(`http://localhost/api/incidents/${id}/resolution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reopen", ...body }),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("reopening through the resolution route", () => {
  it("saves no stand-in why when the person gave none", async () => {
    const id = "inc_reopen_bare";
    await store.saveIncident({ ...resolved(), id });
    const res = await reopen(id, {});
    assert.equal(res.status, 200);
    const last = (await store.getIncident(id))!.reopenings!.at(-1)!;
    assert.equal(last.by, "person");
    assert.equal(last.why, "");
  });

  it("saves the person's note, trimmed", async () => {
    const id = "inc_reopen_note";
    await store.saveIncident({ ...resolved(), id });
    assert.equal((await reopen(id, { note: "  errors are back  " })).status, 200);
    assert.equal((await store.getIncident(id))!.reopenings!.at(-1)!.why, "errors are back");
  });
});
