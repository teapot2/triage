import type { LanguageModelUsage } from "ai";

// The token counts Triage records on every model-calling record (a run, a
// fix run, a question, a postmortem). Cached input is part of the input,
// and reasoning part of the output, as Meta's API reports them
// (input_tokens_details.cached_tokens, output_tokens_details.reasoning_tokens).
// Safe to import in the browser.
export type TokenCounts = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export const noTokens = (): TokenCounts => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });

// Adds one generate() or stream()'s usage, every step of it, to a total.
export function addUsage(total: TokenCounts, usage: LanguageModelUsage): void {
  total.inputTokens += usage.inputTokens ?? 0;
  total.cachedInputTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.reasoningTokens += usage.outputTokenDetails?.reasoningTokens ?? 0;
}
