import { z } from "zod";
import { recentRequests } from "@/lib/investigation/live/live-source";
import { RETENTION_MS } from "@/lib/investigation/live/otlp-files";
import { backtestRule, isWatched } from "@/lib/investigation/watch-judge";
import { ruleSchema } from "@/lib/investigation/watch-rule-model";
import { liveService } from "@/lib/live/types";
import { backtestSloRule, loadHistory } from "@/lib/slo/backtest";
import { rolledThrough } from "@/lib/slo/rollups";

const bodySchema = z.object({ rule: ruleSchema });

const DAY = 24 * 60 * 60_000;
// An SLO rule replays this much of the request counts. Its alerts look back
// 3 days, which the minutes kept (4 days) still cover.
const SLO_RANGE_MS = DAY;

// How often a rule (saved or still a draft) would have opened an incident
// over the telemetry Triage keeps, the last 3 hours, or for an SLO rule over
// the last day of request counts: the watch's checks replayed, every 10
// seconds. Nothing is saved and no model runs.
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const { rule } = parsed.data;
  const to = Date.now();
  if (rule.condition.metric === "slo") {
    const from = to - SLO_RANGE_MS;
    const samples = (await recentRequests(RETENTION_MS)).filter(isWatched);
    const history = loadHistory(
      liveService,
      rule.condition.latencyMs,
      samples,
      rolledThrough(),
      from - rule.condition.windowDays * DAY,
    );
    return Response.json(backtestSloRule(rule, history, from, to));
  }
  const from = to - RETENTION_MS;
  // A window's worth before `from` too, so the first checks see full windows.
  const samples = (await recentRequests(RETENTION_MS + rule.windowSeconds * 1000))
    .filter(isWatched)
    .sort((a, b) => a.start - b.start);
  return Response.json(backtestRule(rule, samples, from, to));
}
