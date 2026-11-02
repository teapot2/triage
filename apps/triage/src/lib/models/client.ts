import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ModelCallError, type RetryOptions, retryingFetch } from "./fetch";
import { policyFor, RunTimeoutError, STALL_MS } from "./policy";
import { type ProviderId, providers } from "./providers";
import type { Endpoint, StageModel } from "./settings";
import type { StageId } from "./stages";
import { errorMessage } from "../errors";

// A chat model for one provider and model ID, ready for the AI SDK.
//
// Meta's API goes through its Responses API: its Chat Completions keeps the
// model's reasoning private, while Responses returns a summary of it
// (modelOptions asks for one). Every other provider is plain Chat
// Completions, which returns open-weights models' raw thinking as is.
//
// Every request goes through retryingFetch: a time limit per attempt and
// jittered retries on 429s, 5xx and network errors (policy.ts). `onRetry`
// lets a run count them.
export function languageModel(s: StageModel & Endpoint, { onRetry }: Pick<RetryOptions, "onRetry"> = {}) {
  const fetch = retryingFetch(policyFor(s.provider), { onRetry });
  if (s.provider === "meta") return createOpenAI({ baseURL: s.baseUrl, apiKey: s.apiKey, fetch }).responses(s.model);
  const client = createOpenAICompatible({
    name: s.provider,
    baseURL: s.baseUrl,
    apiKey: s.apiKey,
    // OpenRouter shows the app's name on its activity page.
    headers: s.provider === "openrouter" ? { "X-Title": "Triage" } : undefined,
    // A streamed call (Ask, the postmortem) reports its tokens only when
    // asked to (stream_options.include_usage).
    includeUsage: true,
    fetch,
  });
  return client.chatModel(s.model);
}

// Request settings for every agent, beside modelOptions(): the SDK's own
// retries off, since retryingFetch does them (both would make up to 12
// attempts), and for a streamed stage the stall limit between chunks of
// the model's output (a stream that stalls before any is retryingFetch's
// to catch). generateText doesn't support a chunk limit and warns if
// given one.
export function callSettings({ stream = false }: { stream?: boolean } = {}) {
  return { maxRetries: 0, ...(stream && { timeout: { chunkMs: STALL_MS } }) };
}

// The SDK's stream limits, as it words them when one trips. A stream that
// one cut off ends in an abort part whose reason reads "TimeoutError: …".
const STREAM_TIMEOUT = /(First chunk|Chunk) timeout of (\d+)ms exceeded/;

// A failed model call or run as the sentence saved on the incident: the
// retrying fetch's and the run budget's messages as they are, the SDK's
// stream limits in words, anything else as its first line.
export function modelErrorText(err: unknown, provider?: ProviderId): string {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof ModelCallError || e instanceof RunTimeoutError) return e.message;
  }
  const message = errorMessage(err).split("\n")[0];
  const stream = STREAM_TIMEOUT.exec(message);
  if (stream) {
    const who = provider ? providers[provider].label : "The model";
    const seconds = Math.round(Number(stream[2]) / 1000);
    return stream[1] === "First chunk"
      ? `${who} didn't start its answer within ${seconds} s.`
      : `${who} stopped sending its answer for ${seconds} s.`;
  }
  return message.slice(0, 500);
}

// Whether a failure was the API or the clock rather than the request
// itself: retries used up, a run past its budget, a stalled stream.
export function isTransientFailure(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof ModelCallError || e instanceof RunTimeoutError) return true;
  }
  return STREAM_TIMEOUT.test(errorMessage(err));
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
// - reasoningEffort: the stage's effort, sent as reasoning.effort. Left out
//   when none is given, so Meta uses the model's own default.
// - promptCacheKey: routes calls that share a prefix to the same cache, so
//   input Meta has seen bills at its cached rate (88% off). One key per
//   stage and incident (cacheKey()): each step of a stage's tool loop
//   resends everything before it, and an incident's questions share the
//   evidence they're asked over.
// - parallelToolCalls: several tool calls in one response, which the SDK
//   then runs at once. Meta's default is on; it's sent anyway so a stage
//   that must go one call at a time (the fix stage) can turn it off. Spark
//   1.3 and Wonder 1.0 both honor it (checked Oct 31: three calls with it
//   on, one with it off), and accept it on calls without tools.
export function modelOptions(
  s: Pick<StageModel, "provider" | "effort">,
  cache?: { key: string },
  { parallel = true }: { parallel?: boolean } = {},
) {
  if (s.provider !== "meta") return undefined;
  return {
    openai: {
      forceReasoning: true,
      systemMessageMode: "system",
      reasoningSummary: "auto",
      store: false,
      include: ["reasoning.encrypted_content"],
      parallelToolCalls: parallel,
      ...(s.effort && { reasoningEffort: s.effort }),
      ...(cache && { promptCacheKey: cache.key }),
    },
  };
}

// The prompt cache key for a stage's calls on one incident.
export const cacheKey = (stage: StageId, incidentId: string) => ({ key: `triage:${stage}:${incidentId}` });

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
