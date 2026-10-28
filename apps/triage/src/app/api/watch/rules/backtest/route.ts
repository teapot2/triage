import { z } from "zod";
import { recentRequests } from "@/lib/investigation/live/live-source";
import { RETENTION_MS } from "@/lib/investigation/live/otlp-files";
import { backtestRule, isWatched } from "@/lib/investigation/watch-judge";
import { ruleSchema } from "@/lib/investigation/watch-rule-model";

const bodySchema = z.object({ rule: ruleSchema });

// How often a rule (saved or still a draft) would have opened an incident
// over the telemetry Triage keeps, the last 3 hours: the watch's checks
// replayed, every 10 seconds. Nothing is saved and no model runs.
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const { rule } = parsed.data;
  const to = Date.now();
  const from = to - RETENTION_MS;
  // A window's worth before `from` too, so the first checks see full windows.
  const samples = (await recentRequests(RETENTION_MS + rule.windowSeconds * 1000))
    .filter(isWatched)
    .sort((a, b) => a.start - b.start);
  return Response.json(backtestRule(rule, samples, from, to));
}
