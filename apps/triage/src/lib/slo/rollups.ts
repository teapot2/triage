import type { DatabaseSync } from "node:sqlite";
import { getDb, transaction } from "@/lib/db";
import { errorMessage } from "@/lib/errors";
import { type RequestSample, requestSamples } from "@/lib/investigation/live/live-source";
import { readTelemetry, RETENTION_MS } from "@/lib/investigation/live/otlp-files";
import { isWatched } from "@/lib/investigation/watch-judge";

// Request counts for SLOs: per route and UTC minute, how many requests there
// were, how many failed, and how many succeeded within each latency bucket.
// The collector's files only reach back RETENTION_MS and an error budget is
// counted over up to 30 days, so the counts are kept in SQLite (db.ts): each
// minute for MINUTE_DAYS, each complete hour for HOURLY_DAYS. An hour is
// summarised before its minutes go, in the same transaction, as uptime's
// results are (uptime/samples.ts).

// The latency an SLO can hold requests to. Fixed, so a new SLO (or one given
// another latency) is judged on the history already counted.
export const LATENCY_BUCKETS = [100, 250, 500, 1000, 2500] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

// Long enough for the slowest burn window (3 days) plus its edges.
export const MINUTE_DAYS = 4;
export const HOURLY_DAYS = 90;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A minute is written once it ended this long ago: the collector writes
// spans a few seconds after they end.
export const SETTLE_MS = 30_000;
// Each pass rewrites the minutes this far back, so a span that lands after
// its minute was first written still counts.
const LOOKBACK_MS = 5 * MINUTE;
const ROLLUP_EVERY_MS = 10_000;
const PRUNE_EVERY_MS = 10 * MINUTE;

const okColumns = LATENCY_BUCKETS.map((b) => `ok_${b}`);
const COLUMNS = ["service", "route", "method", "total", "failed", ...okColumns].join(", ");

export type MinuteRow = {
  service: string;
  route: string;
  method: string;
  minute: number;
  total: number;
  failed: number;
  // Requests that didn't fail and took at most LATENCY_BUCKETS[i] ms.
  ok: number[];
};

const minuteStart = (t: number) => Math.floor(t / MINUTE) * MINUTE;
const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR;

// The requests that started in [from, to), counted per route and minute.
export function bucketMinutes(samples: RequestSample[], from: number, to: number): MinuteRow[] {
  const rows = new Map<string, MinuteRow>();
  for (const s of samples) {
    if (s.start < from || s.start >= to) continue;
    const minute = minuteStart(s.start);
    const key = `${s.service}\n${s.route}\n${s.method}\n${minute}`;
    const row = rows.get(key) ?? { service: s.service, route: s.route, method: s.method, minute, total: 0, failed: 0, ok: LATENCY_BUCKETS.map(() => 0) };
    rows.set(key, row);
    row.total++;
    if (s.failed) row.failed++;
    else for (const [i, b] of LATENCY_BUCKETS.entries()) if (s.durationMs <= b) row.ok[i]++;
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.minute - b.minute ||
      a.service.localeCompare(b.service) ||
      a.route.localeCompare(b.route) ||
      a.method.localeCompare(b.method),
  );
}

// Writes the settled minutes of the last `lookbackMs` from `samples`, which
// must hold every request in that stretch, replacing what was written for
// them before. `dataFrom` is where the telemetry starts: older minutes
// aren't in it any more, and the one it starts in may be cut short (a big
// file read from its last part, or rows past retention dropped), so neither
// is rewritten. Returns the minutes written, [from, to).
export function rollUp(
  db: DatabaseSync,
  samples: RequestSample[],
  dataFrom: number,
  now: number,
  lookbackMs = LOOKBACK_MS,
): { from: number; to: number } | undefined {
  const to = minuteStart(now - SETTLE_MS);
  const from = Math.max(minuteStart(now - lookbackMs), minuteStart(dataFrom) + MINUTE);
  if (from >= to) return undefined;
  const rows = bucketMinutes(samples, from, to);
  const insert = db.prepare(
    `INSERT INTO request_minutes (${COLUMNS}, minute) VALUES (${Array(okColumns.length + 6).fill("?").join(", ")})`,
  );
  transaction(db, () => {
    db.prepare("DELETE FROM request_minutes WHERE minute >= ? AND minute < ?").run(from, to);
    for (const r of rows) insert.run(r.service, r.route, r.method, r.total, r.failed, ...r.ok, r.minute);
  });
  return { from, to };
}

// One transaction: summarise every complete hour still in minutes, then
// drop minutes past MINUTE_DAYS and summaries past HOURLY_DAYS. Hours are
// summarised again each time (REPLACE), so minutes rewritten after their
// hour closed are counted. Minutes go by whole hours, so every hour left in
// them is whole and a summary is never replaced by part of itself.
export function pruneRollups(db: DatabaseSync, now: number) {
  const sums = okColumns.map((c) => `sum(${c})`).join(", ");
  transaction(db, () => {
    db.prepare(
      `INSERT OR REPLACE INTO request_hourly (${COLUMNS}, hour)
       SELECT service, route, method, sum(total), sum(failed), ${sums}, (minute / ${HOUR}) * ${HOUR} AS h
       FROM request_minutes WHERE minute < ? GROUP BY service, route, method, h`,
    ).run(hourStart(now));
    db.prepare("DELETE FROM request_minutes WHERE minute < ?").run(hourStart(now - MINUTE_DAYS * DAY));
    db.prepare("DELETE FROM request_hourly WHERE hour < ?").run(now - HOURLY_DAYS * DAY);
  });
}

export type Counts = { total: number; good: number };

// A route's requests in [from, to), and how many were good: didn't fail
// and, with latencyMs, took at most that long. Every method together, as the
// watch judges a route. Hours older than the oldest minute kept come from
// the hourly summaries, whole hours only, so a window reaching that far back
// can start up to an hour late; the rest comes from the minutes.
export function countsIn(
  q: { service: string; route: string; from: number; to: number; latencyMs?: LatencyBucket },
  db = getDb(),
): Counts {
  const { service, route, from, to, latencyMs } = q;
  if (latencyMs !== undefined && !LATENCY_BUCKETS.includes(latencyMs)) throw new Error(`not a latency bucket: ${latencyMs}`);
  const good = latencyMs === undefined ? "total - failed" : `ok_${latencyMs}`;
  const oldest = db.prepare("SELECT min(minute) AS m FROM request_minutes WHERE service = ?").get(service)?.m;
  const split = oldest === null || oldest === undefined ? Number.POSITIVE_INFINITY : hourStart(Number(oldest));
  const hourly = db
    .prepare(
      `SELECT coalesce(sum(total), 0) AS total, coalesce(sum(${good}), 0) AS good FROM request_hourly
       WHERE service = ? AND route = ? AND hour >= ? AND hour + ${HOUR} <= ? AND hour < ?`,
    )
    .get(service, route, from, to, split);
  const minutes = db
    .prepare(
      `SELECT coalesce(sum(total), 0) AS total, coalesce(sum(${good}), 0) AS good FROM request_minutes
       WHERE service = ? AND route = ? AND minute >= ? AND minute < ?`,
    )
    .get(service, route, Math.max(from, split), to);
  return {
    total: Number(hourly?.total ?? 0) + Number(minutes?.total ?? 0),
    good: Number(hourly?.good ?? 0) + Number(minutes?.good ?? 0),
  };
}

// The routes with requests counted at or after `since`, with the method of
// their latest request, for SLOs over a kind of route (every API route,
// say) to find what they cover beyond the telemetry still in memory.
export function routesSince(service: string, since: number, db = getDb()): { route: string; method: string }[] {
  const rows = db
    .prepare(
      `SELECT route, method, max(t) AS latest FROM (
         SELECT route, method, minute AS t FROM request_minutes WHERE service = ? AND minute >= ?
         UNION ALL
         SELECT route, method, hour AS t FROM request_hourly WHERE service = ? AND hour >= ?
       ) GROUP BY route, method ORDER BY route, latest DESC`,
    )
    .all(service, since, service, hourStart(since));
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    const route = String(r.route);
    if (seen.has(route)) return [];
    seen.add(route);
    return [{ route, method: String(r.method) }];
  });
}

// --- the loop ----------------------------------------------------------------

type State = {
  version: number;
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
  // The first pass after a start writes every minute still in the
  // telemetry, closing the gap a restart left.
  backfilled: boolean;
  // Minutes before this are written; requests from here on are only in
  // the telemetry.
  through?: number;
  lastPrune: number;
  error?: string;
};

// On globalThis, as the watch is: one loop per server process across dev
// hot reloads, the timer calling whichever pass() was loaded last.
const VERSION = 1;
const g = globalThis as unknown as { triageRollups?: State; triageRollupPass?: () => Promise<void> };
const state = (() => {
  const old = g.triageRollups;
  if (old?.version === VERSION) return old;
  if (old?.timer) clearInterval(old.timer);
  g.triageRollups = { version: VERSION, running: false, backfilled: false, lastPrune: Number.NEGATIVE_INFINITY };
  if (old?.timer) setTimeout(() => startRollups(), 0);
  return g.triageRollups;
})();
g.triageRollupPass = pass;

// Started with the watch but not paused with it: pausing stops alerting, and
// a pause mustn't leave a gap in an error budget.
export function startRollups() {
  if (state.timer) return;
  state.timer = setInterval(() => void g.triageRollupPass?.(), ROLLUP_EVERY_MS);
  void pass();
}

export function stopRollups() {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
}

// Where the written minutes end: counts from here on are in the telemetry.
export const rolledThrough = () => state.through;

async function pass() {
  if (state.running) return;
  state.running = true;
  try {
    const now = Date.now();
    const lookback = state.backfilled ? LOOKBACK_MS : RETENTION_MS;
    const { spans } = await readTelemetry();
    let dataFrom = Number.POSITIVE_INFINITY;
    for (const s of spans) if (s.start < dataFrom) dataFrom = s.start;
    const db = getDb();
    if (dataFrom !== Number.POSITIVE_INFINITY) {
      const samples = requestSamples(spans, minuteStart(now - lookback) - 1, now).filter(isWatched);
      const written = rollUp(db, samples, dataFrom, now, lookback);
      if (written) state.through = written.to;
    }
    state.backfilled = true;
    if (now - state.lastPrune >= PRUNE_EVERY_MS) {
      state.lastPrune = now;
      pruneRollups(db, now);
    }
    state.error = undefined;
  } catch (err) {
    // Logged when it changes, not every 10 s.
    const message = errorMessage(err);
    if (message !== state.error) console.error(`[triage] counting requests for SLOs failed: ${message}`);
    state.error = message;
  } finally {
    state.running = false;
  }
}
