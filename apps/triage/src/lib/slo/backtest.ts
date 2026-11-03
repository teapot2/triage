import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import type { RequestSample } from "@/lib/investigation/live/live-source";
import { type Backtest, dataFrom, replay } from "@/lib/investigation/watch-judge";
import type { WatchRule } from "@/lib/investigation/watch-rule-model";
import { evaluateSloRule } from "./judge";
import { LATENCY_BUCKETS, type LatencyBucket } from "./model";
import { bucketMinutes, type CountsFn } from "./rollups";

// Replaying an SLO rule: its alerts reach back 3 days and its budget 30, so
// it's judged on the request counts (rollups.ts) rather than the telemetry,
// loaded once and summed in memory, since the replay judges every route
// thousands of times.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// A stretch of a route's requests and how many were good: a minute, or an
// hour where only its summary is left.
export type Bucket = { t: number; total: number; good: number };
export type History = Map<string, { method: string; buckets: Bucket[] }>;

// Each route's buckets for an SLO's latency (undefined: availability), from
// `since` on: the hourly summaries older than the minutes kept, the minutes
// rolled up before `through`, and `samples` after it, as liveCounts reads
// them. Oldest first.
export function loadHistory(
  service: string,
  latencyMs: LatencyBucket | undefined,
  samples: RequestSample[],
  through: number | undefined,
  since: number,
  db: DatabaseSync = getDb(),
): History {
  if (latencyMs !== undefined && !LATENCY_BUCKETS.includes(latencyMs)) throw new Error(`not a latency bucket: ${latencyMs}`);
  const good = latencyMs === undefined ? "total - failed" : `ok_${latencyMs}`;
  const oldest = db.prepare("SELECT min(minute) AS m FROM request_minutes WHERE service = ?").get(service)?.m;
  const split = oldest === null || oldest === undefined ? Number.POSITIVE_INFINITY : Math.floor(Number(oldest) / HOUR) * HOUR;
  const raw = through ?? Number.NEGATIVE_INFINITY;

  const rows = [
    ...db
      .prepare(`SELECT route, method, hour AS t, total, ${good} AS good FROM request_hourly WHERE service = ? AND hour >= ? AND hour < ?`)
      .all(service, Math.floor(since / HOUR) * HOUR, split),
    ...db
      .prepare(`SELECT route, method, minute AS t, total, ${good} AS good FROM request_minutes WHERE service = ? AND minute >= ? AND minute < ?`)
      .all(service, since, raw),
  ].map((r) => ({ route: String(r.route), method: String(r.method), t: Number(r.t), total: Number(r.total), good: Number(r.good) }));
  const i = latencyMs === undefined ? -1 : LATENCY_BUCKETS.indexOf(latencyMs);
  for (const m of bucketMinutes(
    samples.filter((s) => s.service === service),
    Math.max(raw, since),
    Number.POSITIVE_INFINITY,
  )) {
    rows.push({ route: m.route, method: m.method, t: m.minute, total: m.total, good: i < 0 ? m.total - m.failed : m.ok[i] });
  }

  rows.sort((a, b) => a.t - b.t);
  const history: History = new Map();
  for (const { route, method, ...b } of rows) {
    const h = history.get(route);
    // Methods on one route together, as the watch judges a route; the
    // method is its latest request's.
    if (!h) history.set(route, { method, buckets: [b] });
    else {
      h.method = method;
      const last = h.buckets.at(-1)!;
      if (last.t === b.t) [last.total, last.good] = [last.total + b.total, last.good + b.good];
      else h.buckets.push(b);
    }
  }
  return history;
}

// Counts from a history: the buckets that start in [from, to), by running
// sums and binary search.
export function historyCounts(history: History): CountsFn {
  const sums = new Map(
    [...history].map(([route, { buckets }]) => {
      const total = [0];
      const good = [0];
      for (const b of buckets) {
        total.push(total.at(-1)! + b.total);
        good.push(good.at(-1)! + b.good);
      }
      return [route, { t: buckets.map((b) => b.t), total, good }];
    }),
  );
  const firstAtOrAfter = (ts: number[], x: number) => {
    let [lo, hi] = [0, ts.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (route, from, to) => {
    const s = sums.get(route);
    if (!s) return { total: 0, good: 0 };
    const [i, j] = [firstAtOrAfter(s.t, from), firstAtOrAfter(s.t, to)];
    return { total: s.total[j] - s.total[i], good: s.good[j] - s.good[i] };
  };
}

// The live watch's checks for an SLO rule replayed from `from` to `to` over
// `history`, as backtestRule replays the others: when it would have opened
// an incident, and how often it was judged and over.
export function backtestSloRule(rule: WatchRule, history: History, from: number, to: number): Backtest {
  const live = { ...rule, enabled: true };
  const routes = [...history].map(([route, { method }]) => ({ route, method }));
  const counts = historyCounts(history);
  const held = new Map<string, number>();
  const result = replay(
    from,
    to,
    (t) => evaluateSloRule(live, routes, counts, t, held),
    () => held.clear(),
  );
  const oldest = Math.min(...[...history.values()].map((h) => h.buckets[0]?.t ?? Number.POSITIVE_INFINITY));
  return { ...result, dataFrom: dataFrom(from, Number.isFinite(oldest) ? oldest : undefined) };
}
