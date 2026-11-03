import type { ChartPoint } from "../investigation/schema";
import { matchesTarget, type WatchRule } from "../investigation/watch-rule-model";
import type { LiveSlo, LiveSloRoute } from "../live/types";
import { judgeRoute } from "./judge";
import { burnRate } from "./model";
import type { CountsFn } from "./rollups";

// What the service page shows of each SLO rule: every route it covers with
// requests in its window, its budget, its burn over the last hour and six,
// and the lowest route's burndown. Pure; the snapshot passes the counts.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Points across an SLO window's burndown: every 6 hours over 30 days.
const BURNDOWN_POINTS = 120;

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

export function sloBudgets(
  rules: WatchRule[],
  routes: { route: string; method: string }[],
  counts: CountsFn,
  now: number,
): LiveSlo[] {
  return rules.flatMap((rule): LiveSlo[] => {
    const c = rule.condition;
    if (!rule.enabled || c.metric !== "slo") return [];
    const start = now - c.windowDays * DAY;
    const over = (route: string, from: number, to = now) => counts(route, from, to, c.latencyMs);
    const covered = routes
      .filter(({ route }) => matchesTarget(rule.target, route))
      .flatMap(({ route, method }): LiveSloRoute[] => {
        const requests = over(route, start).total;
        if (requests === 0) return [];
        const { firing, left } = judgeRoute(rule, route, counts, now);
        return [
          {
            method,
            route,
            requests,
            budgetLeftPercent: round(left),
            burn1h: round(burnRate(over(route, now - HOUR), c.objectivePercent), 2),
            burn6h: round(burnRate(over(route, now - 6 * HOUR), c.objectivePercent), 2),
            ...(firing ? { alert: firing.alert.speed } : {}),
          },
        ];
      })
      .sort((a, b) => a.budgetLeftPercent - b.budgetLeftPercent);
    return [
      {
        ruleId: rule.id,
        name: rule.name,
        objectivePercent: c.objectivePercent,
        windowDays: c.windowDays,
        ...(c.latencyMs === undefined ? {} : { latencyMs: c.latencyMs }),
        routes: covered,
        burndown: covered[0] ? burndown(covered[0].route, over, start, now, c.objectivePercent) : [],
      },
    ];
  });
}

// The route's budget over the window as it stands now, spent bad request by
// bad request: at each point, 100% less what the bad requests up to then
// cost, against every request in the window. It falls with each outage and
// ends at the budget left now.
function burndown(
  route: string,
  over: (route: string, from: number, to?: number) => { total: number; good: number },
  start: number,
  now: number,
  objectivePercent: number,
): ChartPoint[] {
  const { total } = over(route, start);
  const allowed = total * (1 - objectivePercent / 100);
  const step = (now - start) / BURNDOWN_POINTS;
  let begun = false;
  return Array.from({ length: BURNDOWN_POINTS + 1 }, (_, i) => {
    const t = Math.round(start + i * step);
    const so = over(route, start, t);
    begun ||= so.total > 0;
    const value = begun ? round(100 - ((so.total - so.good) / allowed) * 100) : null;
    return { t: new Date(t).toISOString(), value } as ChartPoint;
  });
}
