import { z } from "zod";
import { providerLabels } from "./labels";

// Where Triage's models come from. Every provider is an OpenAI-compatible
// chat completions endpoint, so one client covers Meta's API, hosted open
// weights, and a model on your own machine.
//
// Keys for the hosted providers come from the server's environment. Local
// servers usually need none; when one does (llama-server --api-key), or for
// a custom endpoint, the key is saved server-side with the settings (settings.ts)
// and never sent back to the browser.

export const providerIds = [
  "meta",
  "openrouter",
  "baseten",
  "fireworks",
  "modal",
  "lmstudio",
  "ollama",
  "llamacpp",
  "custom",
] as const;
export const providerIdSchema = z.enum(providerIds);
export type ProviderId = z.infer<typeof providerIdSchema>;

export type ProviderInfo = {
  label: string;
  // Default base URL; for local and custom providers it can be changed in
  // Settings.
  baseUrl: string;
  // Env var that holds the base URL, for a hosted provider whose URL is your
  // own deployment's (Modal), so there's no default to fall back on.
  baseUrlEnv?: string;
  // Env var that holds the key, for hosted providers.
  keyEnv?: string;
  // The deployment scales to zero when idle (Modal), so its first request
  // can take minutes while a GPU starts and loads the model. Triage wakes it
  // (see wakeProvider) before relying on it.
  coldStart?: boolean;
  local: boolean;
  // Whether Settings lets you change the base URL and save a key.
  configurable: boolean;
  // Which of the provider's /models to offer. Everything, when absent.
  listFilter?: (id: string) => boolean;
  // Model IDs for the presets: Glimmer, Spark Open (Spark's open weights)
  // and Spark, where the provider has them.
  glimmer?: string;
  sparkOpen?: string;
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
    sparkOpen: "meta/muse-spark-open",
    spark: "meta/muse-spark-1.3",
  },
  // The hackathon grant: Muse Spark Open on Baseten's shared Model APIs. The
  // grant's key only answers for the dated model name, not Baseten docs'
  // "meta-models/muse-spark-open".
  baseten: {
    label: providerLabels.baseten,
    baseUrl: process.env.BASETEN_API_BASE_URL ?? "https://inference.baseten.co/v1",
    keyEnv: "BASETEN_API_KEY",
    local: false,
    configurable: false,
    listFilter: (id) => id.includes("muse"),
    sparkOpen: "meta-models/muse-spark-open-1026",
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
  // Glimmer on your own Modal deployment (infra/modal/glimmer.py): vLLM
  // behind an OpenAI-compatible URL that's yours, so it comes from the env
  // along with the key the deployment checks.
  modal: {
    label: providerLabels.modal,
    baseUrl: process.env.MODAL_BASE_URL ?? "",
    baseUrlEnv: "MODAL_BASE_URL",
    keyEnv: "MODAL_API_KEY",
    local: false,
    configurable: false,
    coldStart: true,
    glimmer: "muse-glimmer-30b",
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

// Muse Spark Open in particular, whose license (Muse Model License §2) asks
// a product that uses it to show "Built with Muse Spark Open".
export const isSparkOpen = (model: string) => /spark-open/i.test(model);
