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
// last few minutes of them. Pure, so the watch and the backtest share it.

const DAY = 86_400_000;

type Firing = TripBurn & { alert: BurnAlert };

// Judges an SLO rule at `now` on each of `routes` it covers. An alert fires
// on a route when its burn rate is over the alert's threshold in both its
// windows, with at least minRequests in the long one; fewer, and that alert
// doesn't judge the route. A fast alert trips at the rule's severity, the
// slow one at SLOW_BURN_SEVERITY, and a fast burn anywhere wins the trip.
// No streaks: the short window is the debounce, and it clears the alert
// soon after the burn stops.
export function evaluateSloRule(
  rule: WatchRule,
  routes: { route: string; method: string }[],
  counts: CountsFn,
  now: number,
): RuleResult {
  if (!rule.enabled) return { status: "paused" };
  const c = rule.condition;
  if (c.metric !== "slo") throw new Error(`${rule.id} isn't an SLO rule`);
  const over = (route: string, ms: number) => counts(route, now - ms, now, c.latencyMs);

  let anyOk = false;
  let trip: { route: string; method: string; burn: Firing } | undefined;
  let lowest: { route: string; left: number } | undefined;
  for (const { route, method } of routes) {
    if (!matchesTarget(rule.target, route)) continue;
    let judged = false;
    let firing: Firing | undefined;
    const left = budgetLeftPercent(over(route, c.windowDays * DAY), c.objectivePercent);
    for (const alert of burnAlerts) {
      const long = over(route, alert.longMs);
      if (long.total < rule.minRequests) continue;
      judged = true;
      const threshold = burnThreshold(alert, c.windowDays);
      const rate = burnRate(long, c.objectivePercent);
      if (firing || rate <= threshold) continue;
      if (burnRate(over(route, alert.shortMs), c.objectivePercent) <= threshold) continue;
      firing = { alert, rate, threshold, longMs: alert.longMs, shortMs: alert.shortMs, budgetLeftPercent: left };
    }
    if (!judged) continue;
    if (!lowest || left < lowest.left) lowest = { route, left };
    if (!firing) anyOk = true;
    else if (!trip || outranks(firing, trip.burn)) trip = { route, method, burn: firing };
  }

  if (trip) {
    const { alert, ...burn } = trip.burn;
    return {
      status: "breaching",
      summary: `burning ${burnText(burn.rate)} over ${durationText(burn.longMs)} on ${trip.route} · ${budgetText(burn.budgetLeftPercent)} of budget left`,
      checks: 1,
      trip: {
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
