import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type ProviderId, providers } from "./providers";
import type { Endpoint, StageModel } from "./settings";

// A chat model for one provider and model ID, ready for the AI SDK.
//
// Meta's API goes through its Responses API: its Chat Completions keeps the
// model's reasoning private, while Responses returns a summary of it
// (modelOptions asks for one). Every other provider is plain Chat
// Completions, which returns open-weights models' raw thinking as is.
export function languageModel(s: StageModel & Endpoint) {
  if (s.provider === "meta") return createOpenAI({ baseURL: s.baseUrl, apiKey: s.apiKey }).responses(s.model);
  const client = createOpenAICompatible({
    name: s.provider,
    baseURL: s.baseUrl,
    apiKey: s.apiKey,
    // OpenRouter shows the app's name on its activity page.
    headers: s.provider === "openrouter" ? { "X-Title": "Triage" } : undefined,
  });
  return client.chatModel(s.model);
}

// Provider options to pass with every call to languageModel(s), for Meta's
// Responses API:
// - forceReasoning: the SDK only knows OpenAI's model names as reasoning
//   models, and would otherwise drop the summary request for Muse models.
// - systemMessageMode "system": instructions as a system message, as on
//   Chat Completions, rather than the "developer" role it'd pick.
// - reasoningSummary "auto": a summary of each call's reasoning. Meta
//   returns none for some calls (short reasoning); those show only text.
// - store false, with the encrypted reasoning included: nothing is kept on
//   Meta's side, and each call's reasoning is passed back with the next.
export function modelOptions(s: Pick<StageModel, "provider">) {
  if (s.provider !== "meta") return undefined;
  return {
    openai: {
      forceReasoning: true,
      systemMessageMode: "system",
      reasoningSummary: "auto",
      store: false,
      include: ["reasoning.encrypted_content"],
    },
  };
}

// What a model's reasoning is, where it returns one: Meta's API summarizes
// it; everything else here returns open-weights models' raw thinking.
export const reasoningKind = (provider: ProviderId) => (provider === "meta" ? "summary" : "raw");

// A local server that isn't running fails fast instead of hanging Settings.
const LIST_TIMEOUT_MS = 5_000;
// How long a scaled-to-zero deployment gets to answer: a cold Modal start
// (GPU, weights from the cache, vLLM's load) took about 5 minutes, and the
// first after a deploy longer, while it also downloads the weights.
export const WAKE_TIMEOUT_MS = 15 * 60_000;

// Nothing answered at the base URL, as opposed to an answer that was an
// error. Settings shows a local server like this as not running.
export class Unreachable extends Error {}

// The models a provider offers, filtered to the chat models Triage can use.
// `timeoutMs` is longer to wait out a cold start (wakeProvider).
export async function listModels(
  provider: ProviderId,
  endpoint: Endpoint,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<string[]> {
  const info = providers[provider];
  let res: Response;
  try {
    // Modal answers a request still waiting after 150 s with a 303 to come
    // back for the result; fetch follows it, which for a GET is the same
    // request again.
    res = await fetch(`${endpoint.baseUrl}/models`, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new Unreachable(
      info.local
        ? `Couldn't reach ${info.label} at ${endpoint.baseUrl}. Is its server running?`
        : info.coldStart && timeoutMs < WAKE_TIMEOUT_MS
          ? `Couldn't reach ${info.label} at ${endpoint.baseUrl}. It may be starting up: Test connection under Providers waits for it.`
          : `Couldn't reach ${info.label} at ${endpoint.baseUrl}.`,
    );
  }
  if ((res.status === 401 || res.status === 403) && !endpoint.apiKey) {
    throw new Error(
      info.keyEnv
        ? `${info.label} needs ${info.keyEnv} to list its models. Add it to apps/triage/.env.local and restart.`
        : `${info.label} needs an API key to list its models.`,
    );
  }
  if (!res.ok) throw new Error(`${info.label} answered HTTP ${res.status} for its model list.`);
  const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const ids = (json?.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  return ids.filter(info.listFilter ?? (() => true)).sort();
}

// Makes sure a scaled-to-zero deployment is up before model calls rely on
// it: listing its models is a GET, which waits through Modal's 150 s
// redirects (a model call is a POST, which a redirect turns into a GET, so
// it can't). Instant when it's already warm; a no-op for other providers.
export async function wakeProvider(s: StageModel & Endpoint): Promise<void> {
  if (!providers[s.provider].coldStart) return;
  await listModels(s.provider, s, WAKE_TIMEOUT_MS);
}
