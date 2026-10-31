import type { UptimeSample } from "@/lib/investigation/uptime/model";
import type { HourlyRollup } from "@/lib/investigation/uptime/samples";
import { defineDataset } from "../dataset";

// An endpoint's history, as its page offers it: every raw result still kept,
// and the hourly summaries behind the uptime figures.

export const endpointResults = defineDataset<UptimeSample>({
  id: "endpoint-results",
  name: "Results (last 48 h)",
  columns: [
    { key: "checked_at", value: (s) => s.at },
    { key: "outcome", value: (s) => s.outcome },
    { key: "status", value: (s) => s.status },
    { key: "response_ms", value: (s) => s.ms },
    { key: "error", value: (s) => s.error },
  ],
  formats: ["csv", "json"],
});

export const endpointHourly = defineDataset<HourlyRollup>({
  id: "endpoint-hourly",
  name: "Hourly summary (90 days)",
  columns: [
    { key: "hour_start", value: (h) => h.hour },
    { key: "checks", value: (h) => h.checks },
    { key: "ok", value: (h) => h.ok },
    { key: "slow", value: (h) => h.slow },
    { key: "down", value: (h) => h.down },
    { key: "uptime_percent", value: (h) => uptimePercent(h) },
    { key: "avg_response_ms", value: (h) => Math.round(h.avgMs) },
    { key: "max_response_ms", value: (h) => h.maxMs },
  ],
  formats: ["csv", "json"],
});

// From the counts, floored to hundredths so it never flatters: 1 down in
// 3 checks is 66.66, not 66.67. Integer hundredths first, so no float error
// can tip it either way.
export function uptimePercent(h: Pick<HourlyRollup, "checks" | "down">): number | null {
  if (h.checks <= 0) return null;
  const up = Math.max(0, h.checks - h.down);
  return Math.floor((up * 10_000) / h.checks) / 100;
}
