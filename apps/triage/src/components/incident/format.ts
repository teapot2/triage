// Built by hand from UTC parts, not Intl: these strings render on the server
// and again in the browser, and Node and the browser ship different locale
// data (e.g. "Oct 23, 09:30" vs "Oct 23 at 09:30"), which breaks hydration.

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

// "09:21:00"
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// "Oct 23, 09:30 UTC"
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// How long ago, short enough for the end of a sidebar row: "now", "12m",
// "3h", "2d", then the date ("Oct 23") after a week. Pair it with
// formatDateTime for the exact time.
export function formatAgo(iso: string, now: number): string {
  const d = new Date(iso);
  const minutes = Math.floor((now - d.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// "950", "73.6K", "1.2M"
export function formatCompact(n: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) return `${Number((n / size).toFixed(1))}${suffix}`;
  }
  return String(n);
}
