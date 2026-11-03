import type { RuleResult, TripBurn } from "../investigation/watch-judge";
import { matchesTarget, type WatchRule } from "../investigation/watch-rule-model";
import {
  type BurnAlert,
  budgetLeftPercent,
  budgetText,
  burnAlerts,
  burnRate,
  burnText,
  burnThreshold,
  durationText,
  SLOW_BURN_SEVERITY,
} from "./model";
import type { CountsFn } from "./rollups";

// How the watch judges an SLO rule: on how fast each route's error budget
// burns (model's burnAlerts), from the counted requests rather than the
// last few minutes of them. Pure but for the slow-burn timers its caller
// keeps, so the watch and the backtest share it.

const DAY = 86_400_000;

type Firing = TripBurn & { alert: BurnAlert };

// How long a slow burn fires before it opens anything. It's a ticket, not a
// page, so waiting costs nothing, and it lets a fast burn that's starting
// trip first: a slow burn from an outage days ago in the 3-day window would
// otherwise fire on a new outage's first bad minute and open it at sev4.
export const SLOW_BURN_HOLD_MS = 5 * 60_000;

// Judges an SLO rule at `now` on each of `routes` it covers. An alert fires
// on a route when its burn rate is over the alert's threshold in both its
// windows, with at least minRequests in the long one; fewer, and that alert
// doesn't judge the route. A fast alert trips at once, at the rule's
// severity; the slow one once it has fired for SLOW_BURN_HOLD_MS, at
// SLOW_BURN_SEVERITY, timed in `held` (keyed "rule|route|slow", kept by the
// caller across checks). A fast burn anywhere wins the trip. The short
// windows are the debounce, and clear an alert soon after the burn stops.
// One route of an SLO rule at `now`: whether any alert judged it (had
// minRequests in its long window), the alert firing on it, if any (both its
// windows over its threshold, the fastest first), and what's left of its
// budget. Shared with the service page's budgets (budget.ts).
export function judgeRoute(
  rule: WatchRule,
  route: string,
  counts: CountsFn,
  now: number,
): { judged: boolean; firing?: Firing; left: number } {
  const c = rule.condition;
  if (c.metric !== "slo") throw new Error(`${rule.id} isn't an SLO rule`);
  const over = (ms: number) => counts(route, now - ms, now, c.latencyMs);
  let judged = false;
  let firing: Firing | undefined;
  const left = budgetLeftPercent(over(c.windowDays * DAY), c.objectivePercent);
  for (const alert of burnAlerts) {
    const long = over(alert.longMs);
    if (long.total < rule.minRequests) continue;
    judged = true;
    const threshold = burnThreshold(alert, c.windowDays);
    const rate = burnRate(long, c.objectivePercent);
    if (firing || rate <= threshold) continue;
    if (burnRate(over(alert.shortMs), c.objectivePercent) <= threshold) continue;
    firing = { alert, rate, threshold, longMs: alert.longMs, shortMs: alert.shortMs, budgetLeftPercent: left };
  }
  return { judged, firing, left };
}

export function evaluateSloRule(
  rule: WatchRule,
  routes: { route: string; method: string }[],
  counts: CountsFn,
  now: number,
  held: Map<string, number> = new Map(),
): RuleResult {
  if (!rule.enabled) return { status: "paused" };
  if (rule.condition.metric !== "slo") throw new Error(`${rule.id} isn't an SLO rule`);

  let anyOk = false;
  // The worst burn firing, and the worst that may open an incident.
  let worst: { route: string; method: string; burn: Firing } | undefined;
  let trip: typeof worst;
  let lowest: { route: string; left: number } | undefined;
  for (const { route, method } of routes) {
    if (!matchesTarget(rule.target, route)) continue;
    const { judged, firing, left } = judgeRoute(rule, route, counts, now);
    const key = `${rule.id}|${route}|slow`;
    if (firing?.alert.speed !== "slow") held.delete(key);
    else if (!held.has(key)) held.set(key, now);
    if (!judged) continue;
    if (!lowest || left < lowest.left) lowest = { route, left };
    if (!firing) {
      anyOk = true;
      continue;
    }
    const candidate = { route, method, burn: firing };
    if (!worst || outranks(firing, worst.burn)) worst = candidate;
    const opens = firing.alert.speed === "fast" || now - held.get(key)! >= SLOW_BURN_HOLD_MS;
    if (opens && (!trip || outranks(firing, trip.burn))) trip = candidate;
  }

  if (worst) {
    const shown = trip ?? worst;
    const { alert, ...burn } = shown.burn;
    return {
      status: "breaching",
      summary: `burning ${burnText(burn.rate)} over ${durationText(burn.longMs)} on ${shown.route} · ${budgetText(burn.budgetLeftPercent)} of budget left`,
      checks: trip ? 1 : undefined,
      trip: trip && {
        route: trip.route,
        method: trip.method,
        burn,
        ...(alert.speed === "slow" ? { severity: SLOW_BURN_SEVERITY } : {}),
      },
      budgetLeftPercent: lowest?.left,
    };
  }
  return {
    status: anyOk ? "ok" : "idle",
    summary: lowest && `${budgetText(lowest.left)} of budget left on ${lowest.route}`,
    budgetLeftPercent: lowest?.left,
  };
}

// A fast burn over a slow one; then the one furthest past its threshold.
function outranks(a: Firing, b: Firing): boolean {
  if (a.alert.speed !== b.alert.speed) return a.alert.speed === "fast";
  return a.rate / a.threshold > b.rate / b.threshold;
}
