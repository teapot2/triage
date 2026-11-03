// What an SLO is and how its error budget burns, in numbers and words. No
// server imports, so the rule model, the rule editor and the service page
// can use it; counting requests is rollups.ts, judging a rule judge.ts.

// The latency an SLO can hold requests to. Fixed, so a new SLO (or one given
// another latency) is judged on the history already counted.
export const LATENCY_BUCKETS = [100, 250, 500, 1000, 2500] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

export const SLO_WINDOW_DAYS = [7, 28, 30] as const;
export type SloWindowDays = (typeof SLO_WINDOW_DAYS)[number];

// The objectives the rule editor offers; a rule saved by hand can hold any
// from 50 to 99.999.
export const SLO_OBJECTIVES = [99, 99.5, 99.9, 99.95, 99.99] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The SRE Workbook's multiwindow burn-rate alerts ("Alerting on SLOs"). Each
// fires when the budget burns fast enough over its long window to spend
// `budgetShare` of the whole SLO window's budget, and is still burning that
// fast over its short window, so it stops soon after the problem does.
// Stored as shares of the budget so they hold for any SLO window; over 30
// days they're the Workbook's 14.4x, 6x and 1x. Fast burns open an incident
// at the rule's severity; the slow burn, a ticket in the Workbook, at sev4.
export const burnAlerts = [
  { id: "fast-1h", speed: "fast", longMs: HOUR, shortMs: 5 * MINUTE, budgetShare: 0.02 },
  { id: "fast-6h", speed: "fast", longMs: 6 * HOUR, shortMs: 30 * MINUTE, budgetShare: 0.05 },
  { id: "slow-3d", speed: "slow", longMs: 3 * DAY, shortMs: 6 * HOUR, budgetShare: 0.1 },
] as const;
export type BurnAlert = (typeof burnAlerts)[number];

export const SLOW_BURN_SEVERITY = "sev4";

// The burn rate at which `alert` fires for an SLO over `windowDays`.
export const burnThreshold = (alert: BurnAlert, windowDays: number) =>
  Math.round(((alert.budgetShare * windowDays * DAY) / alert.longMs) * 100) / 100;

export type Counts = { total: number; good: number };

// How fast the budget is going: 1 spends exactly the budget over the SLO
// window, 14.4 spends 2% of a 30-day budget in an hour. 0 with no requests.
export function burnRate({ total, good }: Counts, objectivePercent: number): number {
  if (total === 0) return 0;
  return (total - good) / total / (1 - objectivePercent / 100);
}

// What's left of the budget over the SLO window, as a percentage of it.
// Below 0 once it's overspent; 100 with no requests.
export const budgetLeftPercent = (counts: Counts, objectivePercent: number) =>
  (1 - burnRate(counts, objectivePercent)) * 100;

// --- words -------------------------------------------------------------------

// "1 h", "30 min", "3 days"
export function durationText(ms: number): string {
  if (ms % DAY === 0) return ms === DAY ? "1 day" : `${ms / DAY} days`;
  if (ms % HOUR === 0) return `${ms / HOUR} h`;
  return `${Math.round(ms / MINUTE)} min`;
}

// "120×", "14.4×", "6×", "0.87×"
export function burnText(rate: number): string {
  const n = rate >= 100 ? Math.round(rate) : rate >= 10 ? Number(rate.toFixed(1)) : Number(rate.toPrecision(2));
  return `${n}×`;
}

// "71%", "-12%"
export const budgetText = (percent: number) => `${Math.round(percent)}%`;

// "0.1% of requests, about 43 min of full outage in 30 days": what an
// objective leaves to spend.
export function allowanceText(objectivePercent: number, windowDays: number): string {
  const share = Number((100 - objectivePercent).toPrecision(3));
  const minutes = ((100 - objectivePercent) / 100) * windowDays * 24 * 60;
  const outage =
    minutes < 10 ? `${Number(minutes.toFixed(1))} min` : minutes < 60 ? `${Math.round(minutes)} min` : `${Number((minutes / 60).toFixed(1))} h`;
  return `${share}% of requests, about ${outage} of full outage in ${windowDays} days`;
}

// "14.4× over 1 h and 5 min": an alert, for an SLO over windowDays.
export const alertText = (alert: BurnAlert, windowDays: number) =>
  `${burnText(burnThreshold(alert, windowDays))} over ${durationText(alert.longMs)} and ${durationText(alert.shortMs)}`;

// "99.9% of requests succeed within 500 ms over 30 days"
export function sloText(c: { objectivePercent: number; windowDays: number; latencyMs?: number }): string {
  const within = c.latencyMs === undefined ? "" : ` within ${c.latencyMs} ms`;
  return `${c.objectivePercent}% of requests succeed${within} over ${c.windowDays} days`;
}
