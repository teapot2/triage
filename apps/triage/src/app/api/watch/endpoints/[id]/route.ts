import { uptimeState } from "@/lib/investigation/uptime";
import { publicCheck, readChecks } from "@/lib/investigation/uptime/checks";
import { formatUptime, uptimeOver } from "@/lib/investigation/uptime/history";
import { readHourly, readSamples, readSamplesSince } from "@/lib/investigation/uptime/samples";

const HOUR = 3_600_000;

// The windows the page shows uptime over, longest last.
const windows = [
  { label: "24 h", hours: 24 },
  { label: "7 d", hours: 24 * 7 },
  { label: "30 d", hours: 24 * 30 },
];

// One check for its page: the configuration (its auth header by name, the
// value stays here), its live state (undefined until the loop has read the
// list), its last 50 results, newest last, and its uptime per window.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const check = (await readChecks()).find((c) => c.id === id);
  if (!check) return Response.json({ error: `unknown uptime check: ${id}` }, { status: 404 });
  const state = uptimeState().find((s) => s.id === id);
  const samples = (await readSamples(id)).slice(-50);
  return Response.json({ check: publicCheck(check), state, samples, uptime: await uptime(id, Date.now()) });
}

// Hourly summaries over the longest window, and the raw results after the
// last summarised hour (the hours not summarised yet). `since` marks a
// window the history doesn't cover from its start.
async function uptime(id: string, now: number) {
  const iso = (t: number) => new Date(t).toISOString();
  const startOf = (hours: number) => (Math.floor(now / HOUR) - hours + 1) * HOUR;
  const hourly = await readHourly(id, iso(startOf(windows.at(-1)!.hours)), iso(now + HOUR));
  const last = hourly.at(-1);
  const raw = await readSamplesSince(id, iso(last ? Date.parse(last.hour) + HOUR : startOf(windows.at(-1)!.hours)));
  const first = hourly[0]?.hour ?? raw[0]?.at;
  return windows.map(({ label, hours }) => {
    const figure = uptimeOver(hourly, raw, now, hours);
    return {
      label,
      percent: figure && formatUptime(figure),
      checks: figure?.checks ?? 0,
      down: figure?.down ?? 0,
      since: first && Date.parse(first) > startOf(hours) ? first : undefined,
    };
  });
}
