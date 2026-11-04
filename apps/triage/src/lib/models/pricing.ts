import type { TokenCounts } from "./usage";

// What a model call costs, in US dollars per million tokens. Safe to import
// in the browser.
export type Price = { input: number; cachedInput: number; output: number };

// Meta's Standard-mode prices (dev.meta.ai/docs/pricing-rate-limits, read
// October 2026); Contributor mode is the "-contributor" models. The page
// prices neither reasoning nor cache writes on their own: reasoning tokens
// are counted in the output, and priced as output here.
const metaPrices: [RegExp, Price][] = [
  [/^muse-spark-1\.[23]-contributor$/, { input: 0.1, cachedInput: 0.002, output: 0.2 }],
  [/^muse-wonder-1\.0(\D|$)/, { input: 4, cachedInput: 0.2, output: 20 }],
  [/^muse-spark-1\.[1-3](\D|$)/, { input: 1.25, cachedInput: 0.15, output: 4.25 }],
];

// Baseten's Model APIs (the pricing its /v1/models returns, read November
// 2026, and baseten.co/pricing as captured on 2026-10-23): Muse Spark Open
// at Meta's Spark list price. The model id is the dated
// one the hackathon grant answers for (meta-models/muse-spark-open-1026).
const basetenPrices: [RegExp, Price][] = [[/muse-spark-open/, { input: 1.25, cachedInput: 0.15, output: 4.25 }]];

// The providers that run on your own machine (providers.ts marks them
// local; it reads the server's env, so isn't imported here).
const localProviders = new Set(["lmstudio", "ollama", "llamacpp"]);

// A model's price where Triage knows it: Meta's API, Muse Spark Open on
// Baseten, and nothing for a model on your own machine. Undefined for the
// other hosted open-weights providers (their prices change and aren't
// published per model in one place), Modal, which bills GPU time rather
// than tokens, and a custom endpoint. A run with no provider is from
// before there were others: Meta.
export function priceFor(provider: string | undefined, model: string): Price | undefined {
  if (provider === "meta" || provider === undefined) return metaPrices.find(([re]) => re.test(model))?.[1];
  if (provider === "baseten") return basetenPrices.find(([re]) => re.test(model))?.[1];
  if (localProviders.has(provider)) return { input: 0, cachedInput: 0, output: 0 };
  return undefined;
}

// Meta's web search, per search on top of the tokens: $2.50 per 1,000.
const WEB_SEARCH_USD = 2.5 / 1000;

// What one record's tokens and web searches cost, or undefined when its
// model has no price. Records from before cached input was recorded are
// priced as all uncached.
export function costOf(
  tokens: Partial<TokenCounts> & { webSearches?: number },
  provider: string | undefined,
  model: string,
): number | undefined {
  const price = priceFor(provider, model);
  if (!price) return undefined;
  const input = tokens.inputTokens ?? 0;
  const cached = Math.min(tokens.cachedInputTokens ?? 0, input);
  const searches = (tokens.webSearches ?? 0) * WEB_SEARCH_USD;
  return ((input - cached) * price.input + cached * price.cachedInput + (tokens.outputTokens ?? 0) * price.output) / 1e6 + searches;
}
