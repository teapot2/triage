import { effortLabels, type ReasoningEffort } from "./stages";

// Provider names for display, safe to import in the browser (providers.ts
// reads the server's env).
export const providerLabels: Record<string, string> = {
  meta: "Meta Model API",
  openrouter: "OpenRouter",
  baseten: "Baseten",
  fireworks: "Fireworks",
  modal: "Modal",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp server",
  custom: "Custom endpoint",
};

// "muse-glimmer-30b via OpenRouter", or the model alone for old runs, with
// the reasoning effort where one was set: "muse-spark-1.3 via Meta Model
// API, high effort".
export const modelLabel = (model: string, provider?: string, effort?: ReasoningEffort) =>
  (provider ? `${model} via ${providerLabels[provider] ?? provider}` : model) +
  (effort ? `, ${effortLabels[effort].toLowerCase()} effort` : "");

type Model = { model: string; provider?: string; effort?: ReasoningEffort };

// A fan-out's two models: "muse-spark-1.3 lanes, muse-wonder-1.0 lead (Meta
// Model API, high effort)", the provider and effort said once when they
// share them, else after each.
export function fanoutLabel(lanes: Model, lead: Model): string {
  const detail = (m: Model) => {
    const parts = [m.provider && (providerLabels[m.provider] ?? m.provider), m.effort && `${effortLabels[m.effort].toLowerCase()} effort`];
    const text = parts.filter(Boolean).join(", ");
    return text && ` (${text})`;
  };
  if (lanes.provider === lead.provider && lanes.effort === lead.effort) {
    return `${lanes.model} lanes, ${lead.model} lead${detail(lanes)}`;
  }
  return `${lanes.model} lanes${detail(lanes)}, ${lead.model} lead${detail(lead)}`;
}
