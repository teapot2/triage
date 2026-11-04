import type { Evidence, Incident, InvestigationReport } from "./schema";
import { flagEventFromMessage, type TelemetrySource } from "./source";
import { errorMessage } from "../errors";

type Commit = Extract<Evidence, { kind: "commit" }>;

// A root cause that rests on a feature flag the logs say is off at the
// alert. Code behind a flag that is off isn't running, so it can't be what
// is wrong now; the alert brief says so, and this holds the report to it.
// Seen live on 2026-11-04: a Page latency false page (dev-server cold
// renders) was blamed on FF_STOCK_DIRECT_QUERY's direct stock query,
// citing the record that turned it on at 02:00 beside the one that turned
// it off at 02:03, 32 minutes before the alert.
//
// The leading hypothesis depends on an off flag when its root-cause claim
// cites a deploy_history record that turned that flag on, or when its title
// or root-cause claim names the flag. Kept narrow so a right answer is never
// sent back:
// - Only flags the source says are off. A source that can't say (no flag
//   logs, an endpoint checked from outside) leaves every flag unknown, and
//   an unknown flag is never checked.
// - Not a flag that was on while the alert's bad requests came in: they
//   may still be ones the flag slowed or broke. For an SLO alert that knows
//   the minutes it is burning on (trigger.burn.burning), that is a flag
//   turned off after they began. Otherwise it is a flag turned off shortly
//   before the alert: GRACE_MS, or an SLO alert's short window when longer.
//   Not its long window: the alert fires only while its short window burns
//   too, so a flag off before that isn't what it fires on. On 2026-11-04 an
//   API SLO's 6× alert (6 h and 30 min) at 03:51 was blamed on
//   FF_STOCK_DIRECT_QUERY, turned off at 03:25 after an earlier outage,
//   while it burned on the price list gap from 03:32; the 6 h grace let the
//   report through.
// - A claim that also cites a code deploy blames the deploy; a flag flipped
//   near it is context (bad-deploy's FF_LIST_PRICES went on and off half an
//   hour before release 0dfdbac broke the product API).
// - A title or claim that says a flag is off or ruled out ("turned off at
//   02:03", "disabled", "ruled out") passes. That is how a claim says the
//   flag isn't the running cause, and also how it says that what the flag
//   left behind still is (pool connections it checked out and never gave
//   back, rows it wrote), which turning a flag off doesn't undo. It errs
//   toward passing: an unrelated "off" passes too.
// - Source code that checks the flag (isEnabled("FF_X")) is not a signal:
//   one file holds both the flag's path and the default one (Shopfront's
//   stock.ts does), so citing it doesn't say which path is blamed.
const saysOffOrRuledOut = /\b(?:off|disabled|ruled out|unrelated|not (?:enabled|on|running|active))\b/i;

// The longest window a watch rule judges requests over (windowSeconds tops
// out at 900), and the window db_diagnostics counts.
export const GRACE_MS = 15 * 60_000;

export interface FlagContext {
  // What the logs say each flag is at the alert: the source's
  // describe().flags. A flag missing from it is unknown.
  flags?: Record<string, boolean>;
  // The alert time: the source's describe().now.
  alertAt: string;
  // When each flag was last turned off at or before the alert, from the
  // source's deploy history; the run's evidence fills in what it lacks.
  turnedOffAt?: Record<string, string>;
  // A flag turned off less than this before the alert isn't checked.
  graceMs?: number;
  // An SLO alert's burning minutes (trigger.burn.burning). When known, a
  // flag turned off after they began isn't checked, and one turned off
  // before is, however recently: they take the grace's place.
  burning?: { from: string; to: string };
}

const flip = (e: Evidence) => {
  if (e.kind !== "commit" || e.tool !== "deploy_history" || !e.observedAt) return undefined;
  const ev = flagEventFromMessage(e.message, e.observedAt);
  return ev?.kind === "flip" ? { ...ev, record: e as Commit } : undefined;
};
const isCodeDeploy = (e: Evidence): e is Commit =>
  e.kind === "commit" && e.tool === "deploy_history" && !e.sha.startsWith("config") && e.deployKind !== "rollback";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (text: string, flag: string) => new RegExp(`\\b${escape(flag)}\\b`, "i").test(text);
const hhmm = (iso: string) => iso.slice(11, 16);

// Whether a flag turned off at `offAt` may still be behind the alert: it was
// on during the minutes an SLO alert is burning on, when they're known, or
// else it went off within the grace before the alert.
const behindAlert = (offAt: number, alertAt: number, ctx: FlagContext) =>
  ctx.burning ? offAt > Date.parse(ctx.burning.from) : alertAt - offAt < (ctx.graceMs ?? GRACE_MS);

export function offFlagProblems(report: InvestigationReport, evidence: Evidence[], ctx: FlagContext): string[] {
  const { verdict } = report;
  if (verdict.kind !== "root_cause") return [];
  const off = Object.entries(ctx.flags ?? {}).flatMap(([flag, on]) => (on === false ? [flag] : []));
  if (!off.length) return [];
  const h = report.hypotheses.find((x) => x.id === verdict.hypothesisId);
  if (!h || h.status !== "leading") return [];

  const text = `${h.title}\n${h.causalChain.rootCause.text}`;
  if (saysOffOrRuledOut.test(text)) return [];
  const ids = new Set(h.causalChain.rootCause.evidenceIds);
  const cited = evidence.filter((e) => ids.has(e.id));
  // A code deploy, cited as its deploy record or as a commit with its sha.
  const deployed = new Set(evidence.filter(isCodeDeploy).map((e) => e.sha));
  if (cited.some((e) => e.kind === "commit" && e.deployKind !== "rollback" && deployed.has(e.sha))) return [];

  const alertAt = Date.parse(ctx.alertAt);
  const flips = evidence.flatMap((e) => flip(e) ?? []);
  return off.flatMap((flag) => {
    const turnedOn = cited.flatMap((e) => flip(e) ?? []).find((f) => f.flag === flag && f.enabled);
    if (!turnedOn && !names(text, flag)) return [];
    const offRecord = flips
      .filter((f) => f.flag === flag && !f.enabled && f.at <= alertAt)
      .sort((a, b) => b.at - a.at)[0];
    const offAt = ctx.turnedOffAt?.[flag] ?? offRecord?.record.observedAt;
    if (offAt && behindAlert(Date.parse(offAt), alertAt, ctx)) return [];

    const why = turnedOn ? `it cites ${turnedOn.record.id}, where ${flag} was turned on` : `it names ${flag}`;
    const cite = offRecord && offAt && offRecord.at === Date.parse(offAt) ? ` (${offRecord.record.id})` : "";
    const before = ctx.burning
      ? `the minutes the alert is burning on (${hhmm(ctx.burning.from)} to ${hhmm(ctx.burning.to)})`
      : `the alert at ${hhmm(ctx.alertAt)}`;
    const when = offAt ? `it was turned off at ${hhmm(offAt)}${cite}, before ${before}` : `it was off at the alert (${hhmm(ctx.alertAt)})`;
    return [
      `The root cause of ${h.id} depends on ${flag} (${why}), but the logs show ${when}; code behind it isn't running now. Rule it out, or name what is causing this now. If something it left behind while it was on is still the cause (resources it still holds, data it wrote), say so, and that ${flag} is off.`,
    ];
  });
}

// The check's context for a run on `source`: the flags and the alert time
// from describe(), and, when a flag is off, when its last flip off came
// from the deploy history (a day back, as deploy_history reads by default).
// An SLO alert brings the minutes it is burning on when it knows them, and
// its grace is its short window when that's longer.
export async function flagContext(source: TelemetrySource, trigger: Pick<Incident["trigger"], "burn">): Promise<FlagContext> {
  const { flags, now } = source.describe();
  const graceMs = Math.max(GRACE_MS, trigger.burn?.shortMs ?? 0);
  const burning = trigger.burn?.burning;
  const base = { flags, alertAt: now, graceMs, ...(burning && { burning }) };
  if (!Object.values(flags ?? {}).includes(false)) return base;
  const turnedOffAt: Record<string, string> = {};
  try {
    const alertAt = Date.parse(now);
    const records = await source.deployHistory({ sinceMinutes: 1440 });
    for (const r of [...records].sort((a, b) => Date.parse(a.deployedAt) - Date.parse(b.deployedAt))) {
      const f = r.kind === "config" ? flagEventFromMessage(r.message ?? "", r.deployedAt) : undefined;
      if (f?.kind !== "flip" || f.at > alertAt) continue;
      // Off now though its last flip turned it on: a restart turned it off,
      // at a time the history doesn't give. Taken as the alert time, so the
      // grace leaves it unchecked.
      turnedOffAt[f.flag] = f.enabled ? now : new Date(f.at).toISOString();
    }
  } catch (err) {
    // The evidence still says when, if the run fetched it.
    console.warn(`flag history unavailable: ${errorMessage(err)}`);
  }
  return { ...base, turnedOffAt };
}
