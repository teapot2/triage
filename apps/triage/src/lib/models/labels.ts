// Provider names for display, safe to import in the browser (providers.ts
// reads the server's env).
export const providerLabels: Record<string, string> = {
  meta: "Meta Model API",
  openrouter: "OpenRouter",
  fireworks: "Fireworks",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp server",
  custom: "Other OpenAI-compatible",
};

// "muse-glimmer-30b via OpenRouter", or the model alone for old runs.
export const modelLabel = (model: string, provider?: string) =>
  provider ? `${model} via ${providerLabels[provider] ?? provider}` : model;
