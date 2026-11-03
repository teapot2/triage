import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeDb, getDb } from "../db";
import { claim, MAX_DELIVERIES, MAX_SENT, recentDeliveries, record } from "./log";
import type { Delivery } from "./types";

// log.ts on a temp working directory, so .data is ours.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-notify-log-"));
  process.chdir(dir);
  await mkdir(path.join(dir, ".data"), { recursive: true });
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const legacyFile = () => path.join(dir, ".data", "notifications.json");
const count = (table: string) => (getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const delivery = (i: number, extra: Partial<Delivery> = {}): Delivery => ({
  at: new Date(Date.parse("2026-11-01T12:00:00.000Z") + i * 1000).toISOString(),
  kind: "incident_opened",
  incidentId: `inc_${i}`,
  ok: true,
  ...extra,
});

// Each case starts as a restart would: a fresh handle, the log empty.
beforeEach(() => {
  getDb().exec("DELETE FROM notification_sent; DELETE FROM notification_deliveries;");
  closeDb();
});

describe("notification log", () => {
  it("claims a key once", () => {
    assert.equal(claim("inc_a:opened"), true);
    assert.equal(claim("inc_a:opened"), false);
    assert.equal(claim("inc_b:opened"), true);
  });

  it("keeps the newest MAX_SENT keys", () => {
    for (let i = 0; i <= MAX_SENT; i++) claim(`key_${i}`);
    assert.equal(count("notification_sent"), MAX_SENT);
    // The oldest went, so it could be claimed again; the newest stays.
    assert.equal(claim(`key_${MAX_SENT}`), false);
    assert.equal(claim("key_0"), true);
  });

  it("records deliveries, newest first, keeping MAX_DELIVERIES", () => {
    record(delivery(0, { ok: false, error: "404 no_service" }));
    record({ at: delivery(1).at, kind: "test", ok: true });
    assert.deepEqual(recentDeliveries(), [
      { at: delivery(1).at, kind: "test", ok: true },
      delivery(0, { ok: false, error: "404 no_service" }),
    ]);
    for (let i = 2; i < MAX_DELIVERIES + 5; i++) record(delivery(i));
    assert.equal(count("notification_deliveries"), MAX_DELIVERIES);
    assert.deepEqual(recentDeliveries(1), [delivery(MAX_DELIVERIES + 4)]);
  });

  it("imports the old notifications.json once, then deletes it", async () => {
    // Deliveries newest first, keys oldest first, as the file kept them.
    const deliveries = [delivery(2), delivery(1, { ok: false, error: "timeout" }), delivery(0)];
    await writeFile(legacyFile(), JSON.stringify({ deliveries, sent: ["inc_0:opened", "inc_1:opened"] }));
    assert.equal(claim("inc_0:opened"), false);
    assert.equal(existsSync(legacyFile()), false);
    assert.deepEqual(recentDeliveries(), deliveries);
    assert.equal(claim("inc_2:opened"), true);

    // A file put back (an import cut short before it went) adds nothing twice.
    closeDb();
    await writeFile(legacyFile(), JSON.stringify({ deliveries, sent: ["inc_0:opened"] }));
    assert.deepEqual(recentDeliveries(), deliveries);
    assert.equal(count("notification_sent"), 3);
    assert.equal(existsSync(legacyFile()), false);
  });

  it("leaves an old file that doesn't parse, and starts empty", async () => {
    await writeFile(legacyFile(), "{ not json");
    assert.deepEqual(recentDeliveries(), []);
    assert.equal(claim("inc_a:opened"), true);
    assert.equal(existsSync(legacyFile()), true);
    await rm(legacyFile());
  });
});
