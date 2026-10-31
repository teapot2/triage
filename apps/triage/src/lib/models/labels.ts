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
