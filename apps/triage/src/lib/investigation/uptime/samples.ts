import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { getDb, transaction } from "@/lib/db";
import { checkIdPattern, sampleSchema, type UptimeSample } from "./model";

// Each check's results, in SQLite (db.ts): every raw result for RAW_HOURS,
// and a summary of each complete UTC hour for HOURLY_DAYS. An hour is always
// summarised before its raw results go, in the same transaction.

// The recent window the judge, the check's page and an investigation see.
export const MAX_SAMPLES = 500;
export const RAW_HOURS = 48;
export const HOURLY_DAYS = 90;

const HOUR = 3_600_000;
const PRUNE_EVERY_MS = 10 * 60_000;

export type HourlyRollup = {
  hour: string; // ISO, start of the UTC hour
  checks: number;
  ok: number;
  slow: number;
  down: number;
  avgMs: number;
  maxMs: number;
};

// Ids came from the model; refuse anything else, as when they named files.
function checked(checkId: string): string {
  if (!checkIdPattern.test(checkId)) throw new Error(`not an uptime check id: ${JSON.stringify(checkId)}`);
  return checkId;
}

function epochMs(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`not a date: ${JSON.stringify(iso)}`);
  return t;
}

// Back to the shape it was saved in: a NULL status or error is left out,
// not undefined, so a round trip equals what went in.
function toSample(row: Record<string, SQLOutputValue>): UptimeSample {
  return {
    at: new Date(Number(row.at)).toISOString(),
    ms: Number(row.ms),
    ...(row.status === null ? {} : { status: Number(row.status) }),
    outcome: row.outcome as UptimeSample["outcome"],
    ...(row.error === null ? {} : { error: String(row.error) }),
  };
}

const COLUMNS = "at, ms, status, outcome, error";

// The last MAX_SAMPLES, oldest first.
export async function readSamples(checkId: string): Promise<UptimeSample[]> {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM uptime_samples WHERE check_id = ? ORDER BY at DESC LIMIT ?`)
    .all(checked(checkId), MAX_SAMPLES);
  return rows.reverse().map(toSample);
}

// Every raw result at or after since, oldest first.
export async function readSamplesSince(checkId: string, sinceIso: string): Promise<UptimeSample[]> {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM uptime_samples WHERE check_id = ? AND at >= ? ORDER BY at`)
    .all(checked(checkId), epochMs(sinceIso));
  return rows.map(toSample);
}

// The hourly summaries with from <= hour < to, oldest first.
export async function readHourly(checkId: string, fromIso: string, toIso: string): Promise<HourlyRollup[]> {
  const rows = getDb()
    .prepare(
      `SELECT hour, checks, ok, slow, down, avg_ms, max_ms FROM uptime_hourly
       WHERE check_id = ? AND hour >= ? AND hour < ? ORDER BY hour`,
    )
    .all(checked(checkId), epochMs(fromIso), epochMs(toIso));
  return rows.map((r) => ({
    hour: new Date(Number(r.hour)).toISOString(),
    checks: Number(r.checks),
    ok: Number(r.ok),
    slow: Number(r.slow),
    down: Number(r.down),
    avgMs: Number(r.avg_ms),
    maxMs: Number(r.max_ms),
  }));
}

// When each open database was last pruned (wall clock). Set before the prune
// runs, so one that keeps failing logs every 10 minutes, not every append.
const lastPrune = new WeakMap<DatabaseSync, number>();

// Resolves to the recent window as saved, newest last, ready for the judge.
export async function appendSample(checkId: string, sample: UptimeSample): Promise<UptimeSample[]> {
  const id = checked(checkId);
  const s = sampleSchema.parse(sample);
  const db = getDb();
  // (check, at) is the key: a second result for one check in the same
  // millisecond is dropped, not an error.
  db.prepare("INSERT OR IGNORE INTO uptime_samples (check_id, at, ms, status, outcome, error) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    epochMs(s.at),
    s.ms,
    s.status ?? null,
    s.outcome,
    s.error ?? null,
  );
  const wall = Date.now();
  if (wall - (lastPrune.get(db) ?? -Infinity) >= PRUNE_EVERY_MS) {
    lastPrune.set(db, wall);
    // Pruned as of the result's own time when that's earlier than the clock
    // (the loop's tests run on a fake one), never later: a result stamped in
    // the future mustn't age out the rest. History is a by-product here, so
    // a prune that fails is logged and the result still counts as saved.
    try {
      prune(db, Math.min(wall, epochMs(s.at)));
    } catch (err) {
      console.error("[triage] pruning uptime samples failed", err);
    }
  }
  return readSamples(id);
}

// For a deleted check, or one pointed at another URL: its raw results and
// its hourly history both go.
export async function deleteSamples(checkId: string) {
  const id = checked(checkId);
  const db = getDb();
  transaction(db, () => {
    db.prepare("DELETE FROM uptime_samples WHERE check_id = ?").run(id);
    db.prepare("DELETE FROM uptime_hourly WHERE check_id = ?").run(id);
  });
}

export async function pruneSamples(now = Date.now()) {
  prune(getDb(), now);
}

const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR;

// One transaction: summarise every complete hour still in raw, then drop raw
// past RAW_HOURS and summaries past HOURLY_DAYS. Every complete hour is
// summarised again each time (REPLACE), so a result that lands after its
// hour closed is still counted. Raw goes by whole hours, so every hour left
// in raw is whole and a new summary never replaces a full one with part of it.
function prune(db: DatabaseSync, now: number) {
  transaction(db, () => {
    db.prepare(
      `INSERT OR REPLACE INTO uptime_hourly (check_id, hour, checks, ok, slow, down, avg_ms, max_ms)
       SELECT check_id, (at / ${HOUR}) * ${HOUR} AS h, count(*),
         sum(outcome = 'ok'), sum(outcome = 'slow'), sum(outcome = 'down'), avg(ms), max(ms)
       FROM uptime_samples WHERE at < ? GROUP BY check_id, h`,
    ).run(hourStart(now));
    db.prepare("DELETE FROM uptime_samples WHERE at < ?").run(hourStart(now - RAW_HOURS * HOUR));
    db.prepare("DELETE FROM uptime_hourly WHERE hour < ?").run(now - HOURLY_DAYS * 24 * HOUR);
  });
}
