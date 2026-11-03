import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeDb, getDb } from "../db";
import {
  publicModelSettings,
  readNotificationSettings,
  readSlackBot,
  updateModelSettings,
  webSearchOn,
  writeNotificationSettings,
  writeSlackBot,
} from "./settings";

// settings.ts on a temp working directory, so .data is ours.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-settings-"));
  process.chdir(dir);
  await mkdir(path.join(dir, ".data"), { recursive: true });
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const legacyFile = () => path.join(dir, ".data", "settings.json");
const saved = () => {
  const row = getDb().prepare("SELECT body FROM documents WHERE name = 'settings'").get() as { body: string } | undefined;
  return row && JSON.parse(row.body);
};

// Each case starts as a restart would: a fresh handle, with nothing saved.
beforeEach(() => {
  getDb().prepare("DELETE FROM documents WHERE name = 'settings'").run();
  closeDb();
});

describe("settings", () => {
  it("reads the defaults when nothing is saved", async () => {
    assert.equal(await webSearchOn(), true);
    assert.equal((await publicModelSettings()).fanout, false);
    assert.equal(saved(), undefined);
  });

  it("saves changes, and two at once both land", async () => {
    await Promise.all([
      updateModelSettings({ fanout: true, endpoints: { custom: { baseUrl: "http://localhost:9000/v1", apiKey: "test-key" } } }),
      writeNotificationSettings({ events: { resolved: false } }),
      writeSlackBot({ channel: "C0123456" }),
    ]);
    assert.equal((await publicModelSettings()).fanout, true);
    assert.equal((await readNotificationSettings()).events.resolved, false);
    assert.equal((await readSlackBot()).channel, "C0123456");
    assert.equal(saved().endpoints.custom.apiKey, "test-key");
  });

  it("imports the old settings.json, then deletes it", async () => {
    await writeFile(
      legacyFile(),
      JSON.stringify({ stages: {}, endpoints: { custom: { baseUrl: "http://localhost:9000/v1", apiKey: "test-key" } }, webSearch: false }),
    );
    assert.equal(await webSearchOn(), false);
    assert.equal(existsSync(legacyFile()), false);
    assert.equal(saved().endpoints.custom.apiKey, "test-key");
    // A change keeps what came from the file.
    await writeSlackBot({ channel: "C0123456" });
    assert.equal(saved().endpoints.custom.apiKey, "test-key");
    assert.equal(saved().webSearch, false);
  });

  it("throws on an old settings.json that doesn't parse, and won't save over it", async () => {
    await writeFile(legacyFile(), '{ "endpoints": { "custom": { "apiKey": "test-key" ');
    // Named, with why, but never quoting the file: it holds keys.
    await assert.rejects(webSearchOn(), (err: Error) => /settings\.json isn't valid \(not valid JSON/.test(err.message) && !err.message.includes("test-key"));
    await assert.rejects(writeSlackBot({ channel: "C0123456" }), /settings\.json isn't valid/);
    await writeFile(legacyFile(), JSON.stringify({ webSearch: "yes" }));
    await assert.rejects(readSlackBot(), /settings\.json isn't valid/);
    assert.equal(existsSync(legacyFile()), true);
    assert.equal(saved(), undefined);
  });
});
