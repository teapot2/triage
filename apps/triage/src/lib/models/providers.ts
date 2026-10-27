import { z } from "zod";
import { providerLabels } from "./labels";

// Where Triage's models come from. Every provider is an OpenAI-compatible
// chat completions endpoint, so one client covers Meta's API, hosted open
// weights, and a model on your own machine.
//
// Keys for the hosted providers come from the server's environment. Local
// servers usually need none; when one does (llama-server --api-key), or for
// a custom endpoint, the key is saved server-side in .data/settings.json
// and never sent back to the browser.

export const providerIds = ["meta", "openrouter", "fireworks", "lmstudio", "ollama", "llamacpp", "custom"] as const;
export const providerIdSchema = z.enum(providerIds);
export type ProviderId = z.infer<typeof providerIdSchema>;

export type ProviderInfo = {
  label: string;
  // Default base URL; for local and custom providers it can be changed in
  // Settings.
  baseUrl: string;
  // Env var that holds the key, for hosted providers.
  keyEnv?: string;
  local: boolean;
  // Whether Settings lets you change the base URL and save a key.
  configurable: boolean;
  // Which of the provider's /models to offer. Everything, when absent.
  listFilter?: (id: string) => boolean;
  // Model IDs for the presets: Glimmer, and Spark where the provider has it.
  glimmer?: string;
  spark?: string;
};

// Meta's API also lists image, speech and segmentation models, and
// "-contributor" variants that need data sharing turned on.
const metaChat = (id: string) => /^muse-(spark|wonder)/.test(id) && !id.endsWith("-contributor");

export const providers: Record<ProviderId, ProviderInfo> = {
  meta: {
    label: providerLabels.meta,
    baseUrl: process.env.MODEL_API_BASE_URL ?? "https://api.meta.ai/v1",
    keyEnv: "MODEL_API_KEY",
    local: false,
    configurable: false,
    listFilter: metaChat,
    spark: "muse-spark-1.3",
  },
  openrouter: {
    label: providerLabels.openrouter,
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    local: false,
    configurable: false,
    listFilter: (id) => id.startsWith("meta/") && !id.endsWith("-contributor"),
    glimmer: "meta/muse-glimmer-30b",
    spark: "meta/muse-spark-1.3",
  },
  fireworks: {
    label: providerLabels.fireworks,
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyEnv: "FIREWORKS_API_KEY",
    local: false,
    configurable: false,
    listFilter: (id) => id.includes("muse"),
    glimmer: "accounts/fireworks/models/muse-glimmer-30b",
  },
  lmstudio: {
    label: providerLabels.lmstudio,
    baseUrl: "http://localhost:1234/v1",
    local: true,
    configurable: true,
    glimmer: "muse-glimmer-30b",
  },
  ollama: {
    label: providerLabels.ollama,
    baseUrl: "http://localhost:11434/v1",
    local: true,
    configurable: true,
    glimmer: "muse-glimmer:30b",
  },
  llamacpp: {
    label: providerLabels.llamacpp,
    baseUrl: "http://localhost:8080/v1",
    local: true,
    configurable: true,
    glimmer: "muse-glimmer-30b",
  },
  custom: {
    label: providerLabels.custom,
    baseUrl: "",
    local: false,
    configurable: true,
  },
};

// Meta's open-weights models: a stage on one of these runs on weights you
// could host yourself.
export const isOpenWeights = (model: string) => /glimmer|spark-open/i.test(model);
