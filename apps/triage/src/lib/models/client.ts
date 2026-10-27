import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type ProviderId, providers } from "./providers";
import type { Endpoint, StageModel } from "./settings";

// A chat model for one provider and model ID, ready for the AI SDK.
export function languageModel(s: StageModel & Endpoint) {
  const client = createOpenAICompatible({
    name: s.provider,
    baseURL: s.baseUrl,
    apiKey: s.apiKey,
    // OpenRouter shows the app's name on its activity page.
    headers: s.provider === "openrouter" ? { "X-Title": "Triage" } : undefined,
  });
  return client.chatModel(s.model);
}

// A local server that isn't running fails fast instead of hanging Settings.
const LIST_TIMEOUT_MS = 5_000;

// The models a provider offers, filtered to the chat models Triage can use.
export async function listModels(provider: ProviderId, endpoint: Endpoint): Promise<string[]> {
  const info = providers[provider];
  let res: Response;
  try {
    res = await fetch(`${endpoint.baseUrl}/models`, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      info.local
        ? `Couldn't reach ${info.label} at ${endpoint.baseUrl}. Is its server running?`
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
