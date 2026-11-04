import type { TokenCounts } from "./usage";

// How many tokens a model's context window holds, where Triage is sure of
// it: Meta's API (dev.meta.ai/docs/models) and OpenRouter's /api/v1/models,
// both read October 2026, and Baseten's /v1/models (context_length, read
// November 2026). OpenRouter only routes a request to an upstream that fits
// it, so its listed context_length is the limit.
//
// Everything else shows no meter rather than a guess: a hosted open-weights
// deployment or a local server runs with whatever context it was started
// with (Triage's Modal deployment of Glimmer runs 65,536 of its 131,072).
// Safe to import in the browser.
const limits: Record<string, Record<string, number>> = {
  meta: {
    "muse-spark-1.3": 1_048_576,
    "muse-wonder-1.0": 1_048_576,
  },
  openrouter: {
    "meta/muse-spark-1.3": 1_048_576,
    "meta/muse-wonder": 1_048_576,
    "meta/muse-spark-open": 1_048_576,
    "meta/muse-glimmer-30b": 131_072,
  },
  baseten: {
    "meta-models/muse-spark-open": 1_048_576,
    "meta-models/muse-spark-open-1026": 1_048_576,
  },
};

export const contextLimit = (provider: string | undefined, model: string): number | undefined =>
  provider === undefined ? undefined : limits[provider]?.[model];

// A record that called a model, with its fullest call (see fuller()).
export type ContextRecord = { context?: TokenCounts; provider?: string; model: string };

// How full a record's context got, 0 to 1, against its model's window.
// Undefined when no call has finished yet or the limit isn't known.
export function contextShare(r: ContextRecord): number | undefined {
  const limit = contextLimit(r.provider, r.model);
  return r.context && limit ? r.context.inputTokens / limit : undefined;
}

// The fullest of several records by share, each against its own model.
export function fullestContext<T extends ContextRecord>(records: T[]): T | undefined {
  let best: { r: T; share: number } | undefined;
  for (const r of records) {
    const share = contextShare(r);
    if (share !== undefined && (!best || share > best.share)) best = { r, share };
  }
  return best?.r;
}
