import type { UptimeSample } from "./model";

// The uptime figure an endpoint's page shows for 24 h, 7 d and 30 d, counted
// from hourly summaries plus the raw samples not summarised yet. Pure, and
// a number people quote, so it never counts a check twice and never rounds
// up.

const HOUR = 3_600_000;

// What this needs of an hourly summary; the stored rollup has more.
export type HourCounts = { hour: string; checks: number; down: number };

export type UptimeFigure = { percent: number; checks: number; down: number; hours: number };

// The UTC hour a time falls in, as hours since the epoch.
const hourOf = (t: number) => Math.floor(t / HOUR);

// Uptime over the current UTC hour and the `hours - 1` before it. Each hour
// counts its summary when it has one, its raw samples otherwise: the two can
// overlap, and the summary is the settled count. Slow still answered, so
// only down counts against it. Undefined when nothing was checked.
export function uptimeOver(hourly: HourCounts[], raw: UptimeSample[], now: number, hours: number): UptimeFigure | undefined {
  const last = hourOf(now);
  const first = last - hours + 1;
  const inWindow = (h: number) => h >= first && h <= last;

  // Keyed by hour, so two summaries of one hour can't both count; the later
  // one in the list wins.
  const summarised = new Map<number, HourCounts>();
  for (const s of hourly) {
    const h = hourOf(Date.parse(s.hour));
    if (inWindow(h)) summarised.set(h, s);
  }

  let checks = 0;
  let down = 0;
  for (const s of summarised.values()) {
    checks += s.checks;
    down += s.down;
  }
  for (const s of raw) {
    const t = Date.parse(s.at);
    // NaN fails every comparison, so an unreadable time is skipped too.
    if (!(t <= now) || !inWindow(hourOf(t)) || summarised.has(hourOf(t))) continue;
    checks++;
    if (s.outcome === "down") down++;
  }

  if (checks <= 0) return undefined;
  return { percent: ((checks - down) / checks) * 100, checks, down, hours };
}

// "100%", "99.95%", "99.90%". Floored in whole hundredths from the counts,
// not the float percent, so 99.95 can't come out 99.94 and any down result
// shows at most "99.99%".
export function formatUptime(f: UptimeFigure): string {
  if (f.down <= 0) return "100%";
  const up = Math.max(0, f.checks - f.down);
  // up < checks here, so this is at most 9999.
  const hundredths = Math.floor((up * 10_000) / f.checks);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}%`;
}
