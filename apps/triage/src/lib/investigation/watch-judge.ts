import { p95, type RequestSample } from "./live/live-source";
import { matchesTarget, type WatchCondition, type WatchRule } from "./watch-rule-model";

// How the watch judges a rule: shared by the live watch (watch.ts) and the
// backtest that replays a rule over past telemetry, so the two can't drift.

export const CHECK_MS = 10_000;
// Judged checks with nothing over a limit before an open episode ends.
export const HEALTHY_TO_REARM = 6;

// Never judged: a health check is the probe, not the traffic. HEAD requests
// are probes too.
const ignoredRoutes = new Set(["/api/health"]);
export const isWatched = (s: RequestSample) => !ignoredRoutes.has(s.route) && s.method !== "HEAD";

type Judgment = { verdict: "idle" | "ok" | "breach"; value: number; limit: number };

// One route's requests against one condition.
function judge(c: WatchCondition, rows: RequestSample[], minRequests: number): Judgment {
  const n = rows.length;
  const slowShare = (ms: number) => (rows.filter((r) => r.durationMs > ms).length / n) * 100;
  let value: number;
  let limit: number;
  switch (c.metric) {
    case "p95":
      [value, limit] = [n ? p95(rows.map((r) => r.durationMs)) : 0, c.aboveMs];
      break;
    case "slowCount":
      [value, limit] = [rows.filter((r) => r.durationMs > c.slowerThanMs).length, c.moreThan];
      break;
    case "slowShare":
      [value, limit] = [n ? slowShare(c.slowerThanMs) : 0, c.moreThanPercent];
      break;
    case "errorRate":
      [value, limit] = [n ? (rows.filter((r) => r.failed).length / n) * 100 : 0, c.moreThanPercent];
      break;
  }
  // A count needs no minimum: zero slow requests is a verdict.
  const enough = c.metric === "slowCount" ? n > 0 : n >= minRequests;
  return { verdict: !enough ? "idle" : value > limit ? "breach" : "ok", value, limit };
}

function summarize(c: WatchCondition, value: number, route: string): string {
  const v = Math.round(value);
  switch (c.metric) {
    case "p95":
      return `p95 ${v} ms on ${route}`;
    case "slowCount":
      return `${v} slower than ${c.slowerThanMs} ms on ${route}`;
    case "slowShare":
      return `${v}% slower than ${c.slowerThanMs} ms on ${route}`;
    case "errorRate":
      return `${v}% errors on ${route}`;
  }
}

// How far past its limit a value is, to pick a rule's worst route.
const pressure = ({ value, limit }: Judgment) => (limit > 0 ? value / limit : value > 0 ? Number.POSITIVE_INFINITY : 0);

export type RuleResult = {
  status: "ok" | "breaching" | "idle" | "paused";
  // What its route nearest (or furthest past) the limit measured.
  summary?: string;
  // Checks in a row over the limit, on its worst route.
  checks?: number;
  // Set when the rule has been over its limit on a route long enough to open.
  trip?: { route: string; method: string };
};

// Judges a rule at `now` on each route it covers, advancing that route's
// streak in `streaks` (keyed "rule|route"). A route without enough requests
// leaves its streak where it was.
export function evaluateRule(
  rule: WatchRule,
  samples: RequestSample[],
  now: number,
  streaks: Map<string, number>,
): RuleResult {
  if (!rule.enabled) return { status: "paused" };
  const byRoute = new Map<string, RequestSample[]>();
  for (const s of samples) {
    if (s.start <= now - rule.windowSeconds * 1000 || s.start > now || !matchesTarget(rule.target, s.route)) continue;
    const list = byRoute.get(s.route);
    if (list) list.push(s);
    else byRoute.set(s.route, [s]);
  }

  let worst: { route: string; j: Judgment } | undefined;
  let anyOk = false;
  let checks = 0;
  let trip: RuleResult["trip"];
  for (const [route, rows] of byRoute) {
    const j = judge(rule.condition, rows, rule.minRequests);
    if (j.verdict === "idle") continue;
    const key = `${rule.id}|${route}`;
    if (j.verdict === "ok") {
      streaks.delete(key);
      anyOk = true;
    } else {
      const streak = (streaks.get(key) ?? 0) + 1;
      streaks.set(key, streak);
      checks = Math.max(checks, streak);
      if (streak >= rule.checksToOpen && !trip) trip = { route, method: rows[0].method };
    }
    if (!worst || pressure(j) > pressure(worst.j)) worst = { route, j };
  }
  return {
    status: checks > 0 ? "breaching" : anyOk ? "ok" : "idle",
    summary: worst && summarize(rule.condition, worst.j.value, worst.route),
    checks: checks || undefined,
    trip,
  };
}

export type Backtest = {
  // When it would have opened an incident, newest last.
  fired: { at: string; route: string; summary?: string }[];
  // Checks replayed, those with enough traffic to judge, and those over the limit.
  checks: number;
  judged: number;
  breaching: number;
  from: string;
  to: string;
  // The oldest request in range, when it's well after `from`: the telemetry
  // doesn't reach back that far.
  dataFrom?: string;
};

// Replays the watch's checks for one rule over past requests, every CHECK_MS
// from `from` to `to`, with the live watch's streaks and episodes: once it
// fires it stays quiet until HEALTHY_TO_REARM healthy checks. It judges the
// rule on its own, as if it were the only one. `samples` must be sorted by
// start.
export function backtestRule(rule: WatchRule, samples: RequestSample[], from: number, to: number): Backtest {
  const live = { ...rule, enabled: true };
  const windowMs = rule.windowSeconds * 1000;
  const streaks = new Map<string, number>();
  const fired: Backtest["fired"] = [];
  let [checks, judged, breaching] = [0, 0, 0];
  let alerting = false;
  let healthy = 0;
  // The window slides forward with the checks: samples[lo, hi) are in it.
  let lo = 0;
  let hi = 0;
  for (let t = from + CHECK_MS; t <= to; t += CHECK_MS) {
    while (hi < samples.length && samples[hi].start <= t) hi++;
    while (lo < hi && samples[lo].start <= t - windowMs) lo++;
    const r = evaluateRule(live, samples.slice(lo, hi), t, streaks);
    checks++;
    if (r.status !== "idle") judged++;
    if (r.status === "breaching") breaching++;
    if (alerting) {
      healthy = r.status === "breaching" ? 0 : r.status === "ok" ? healthy + 1 : healthy;
      if (healthy >= HEALTHY_TO_REARM) {
        alerting = false;
        healthy = 0;
        streaks.clear();
      }
    } else if (r.trip) {
      fired.push({ at: new Date(t).toISOString(), route: r.trip.route, summary: r.summary });
      alerting = true;
      healthy = 0;
    }
  }
  const oldest = samples.find((s) => s.start > from)?.start;
  return {
    fired,
    checks,
    judged,
    breaching,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    dataFrom: oldest !== undefined && oldest - from > 5 * 60_000 ? new Date(oldest).toISOString() : undefined,
  };
}
