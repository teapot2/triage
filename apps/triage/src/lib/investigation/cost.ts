import { contextShare } from "../models/context";
import { costOf } from "../models/pricing";
import { type StageId, stageIds } from "../models/stages";
import { noTokens, type TokenCounts } from "../models/usage";
import type { Incident } from "./schema";

// What an incident's model calls used and cost, stage by stage: the
// investigation, every fix attempt, every question and the postmortem.
// Safe to import in the browser.

export type UsageTotal = {
  tokens: TokenCounts;
  // In US dollars. Undefined when a record with tokens ran on a model
  // Triage has no price for, rather than a total that leaves it out.
  cost: number | undefined;
  // Whether any record counted its cached input and reasoning: those from
  // before they were recorded leave both at 0, which isn't a 0% share.
  detailed: boolean;
  // The fullest context of any record, 0 to 1, each against its own
  // model's window. Undefined when none ran on a model with a known one.
  context?: number;
};

export type IncidentUsage = UsageTotal & { stages: Partial<Record<StageId, UsageTotal>> };

type UsageRecord = Partial<TokenCounts> & { provider?: string; model?: string; context?: TokenCounts; webSearches?: number };

const counted = (r: UsageRecord) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) > 0;

function add(total: UsageTotal, r: UsageRecord) {
  total.tokens.inputTokens += r.inputTokens ?? 0;
  total.tokens.cachedInputTokens += r.cachedInputTokens ?? 0;
  total.tokens.outputTokens += r.outputTokens ?? 0;
  total.tokens.reasoningTokens += r.reasoningTokens ?? 0;
  total.detailed ||= r.cachedInputTokens !== undefined;
  const cost = r.model ? costOf(r, r.provider, r.model) : undefined;
  total.cost = total.cost === undefined || cost === undefined ? undefined : total.cost + cost;
  const share = r.model ? contextShare({ ...r, model: r.model }) : undefined;
  if (share !== undefined) total.context = Math.max(total.context ?? 0, share);
}

// Undefined when nothing on the incident recorded tokens (a bundled
// example, or a run still on its first call). A fan-out's lead (scout and
// merge) counts in the investigation, at its own model's price; the Lead
// stage never has a total of its own.
export function incidentUsage(incident: Incident): IncidentUsage | undefined {
  const fanout = incident.run?.fanout;
  const records: Partial<Record<StageId, UsageRecord[]>> = {
    investigate: incident.run
      ? [incident.run, ...(fanout ? [{ ...fanout, provider: fanout.leadProvider, model: fanout.leadModel }] : [])]
      : [],
    fix: [...(incident.fixAttempts ?? []).map((a) => a.fixRun), ...(incident.fixRun ? [incident.fixRun] : [])],
    ask: incident.questions ?? [],
    postmortem: incident.postmortem ? [incident.postmortem] : [],
  };
  const usage: IncidentUsage = { tokens: noTokens(), cost: 0, detailed: false, stages: {} };
  for (const stage of stageIds) {
    for (const r of (records[stage] ?? []).filter(counted)) {
      const total = (usage.stages[stage] ??= { tokens: noTokens(), cost: 0, detailed: false });
      add(total, r);
      add(usage, r);
    }
  }
  return Object.keys(usage.stages).length ? usage : undefined;
}

// The share of input served from the prompt cache, 0 to 1.
export const cachedShare = (t: TokenCounts) => (t.inputTokens ? Math.min(t.cachedInputTokens / t.inputTokens, 1) : 0);

// "$0.19", "$0.004", "<$0.001": cents once there are any, otherwise enough
// digits to tell a cheap run from a free one.
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  return "<$0.001";
}
