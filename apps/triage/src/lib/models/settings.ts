import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isOpenWeights, providerIdSchema, providerIds, providers, type ProviderId } from "./providers";
import { type StageId, stageIdSchema, stageIds } from "./stages";

export { type StageId, stageIdSchema, stageIds } from "./stages";

// Which model each stage uses, and the endpoints of the configurable
// providers. Saved server-side, in .data/settings.json (gitignored), since
// the stages run on the server, the watch included. The file can hold keys,
// so only publicModelSettings ever leaves the server.

const stageModelSchema = z.object({ provider: providerIdSchema, model: z.string().trim().min(1).max(200) });
export type StageModel = z.infer<typeof stageModelSchema>;

const endpointSchema = z.object({
  baseUrl: z.url().optional(),
  apiKey: z.string().max(500).optional(),
});

const settingsSchema = z.object({
  stages: z.partialRecord(stageIdSchema, stageModelSchema).default({}),
  endpoints: z.partialRecord(providerIdSchema, endpointSchema).default({}),
});
type Settings = z.infer<typeof settingsSchema>;

const file = path.join(process.cwd(), ".data", "settings.json");

// Before anything is saved, every stage uses the env's model on Meta's API.
const defaultStage = (): StageModel => ({ provider: "meta", model: process.env.MODEL_ID ?? "muse-spark-1.3" });

async function read(): Promise<Settings> {
  try {
    return settingsSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { stages: {}, endpoints: {} };
    throw err;
  }
}

async function write(settings: Settings) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, file);
}

export type Endpoint = { baseUrl: string; apiKey?: string };

// A provider's endpoint as configured: saved values over the defaults, and
// the key from the env for hosted providers.
export function endpointOf(settings: Settings, id: ProviderId): Endpoint {
  const info = providers[id];
  const saved = info.configurable ? settings.endpoints[id] : undefined;
  const apiKey = info.keyEnv ? process.env[info.keyEnv] : saved?.apiKey;
  return { baseUrl: (saved?.baseUrl ?? info.baseUrl).replace(/\/+$/, ""), apiKey: apiKey || undefined };
}

export async function endpointFor(id: ProviderId): Promise<Endpoint> {
  return endpointOf(await read(), id);
}

export async function stageModel(stage: StageId): Promise<StageModel & Endpoint> {
  const settings = await read();
  const chosen = settings.stages[stage] ?? defaultStage();
  return { ...chosen, ...endpointOf(settings, chosen.provider) };
}

// Why a stage can't run as configured, or undefined when it can.
export function stageProblem(s: StageModel & Endpoint): string | undefined {
  const info = providers[s.provider];
  if (!s.baseUrl) return `${info.label} has no base URL. Set one in Settings.`;
  if (!info.local && info.configurable === false && !s.apiKey) {
    return `${info.keyEnv} is not set. Add it to apps/triage/.env.local and restart.`;
  }
  return undefined;
}

// What the browser sees: no keys, only whether one is set and where from.
export async function publicModelSettings() {
  const settings = await read();
  const stages = Object.fromEntries(stageIds.map((id) => [id, settings.stages[id] ?? defaultStage()])) as Record<
    StageId,
    StageModel
  >;
  return {
    stages,
    openWeights: stageIds.every((id) => isOpenWeights(stages[id].model)),
    providers: providerIds.map((id) => {
      const info = providers[id];
      const endpoint = endpointOf(settings, id);
      return {
        id,
        label: info.label,
        baseUrl: endpoint.baseUrl,
        defaultBaseUrl: info.baseUrl,
        local: info.local,
        configurable: info.configurable,
        keyEnv: info.keyEnv,
        hasKey: Boolean(endpoint.apiKey),
        glimmer: info.glimmer,
        spark: info.spark,
      };
    }),
  };
}
export type PublicModelSettings = Awaited<ReturnType<typeof publicModelSettings>>;

export const updateSchema = z.object({
  stages: z.partialRecord(stageIdSchema, stageModelSchema).optional(),
  // apiKey: a new key, "" to clear it, or absent to keep the saved one.
  endpoints: z.partialRecord(providerIdSchema, z.object({ baseUrl: z.url().or(z.literal("")).optional(), apiKey: z.string().max(500).optional() })).optional(),
});

export async function updateModelSettings(update: z.infer<typeof updateSchema>) {
  const settings = await read();
  for (const [id, s] of Object.entries(update.stages ?? {}) as [StageId, StageModel][]) settings.stages[id] = s;
  for (const [id, e] of Object.entries(update.endpoints ?? {}) as [ProviderId, { baseUrl?: string; apiKey?: string }][]) {
    if (!providers[id].configurable) continue;
    const next = { ...settings.endpoints[id] };
    if (e.baseUrl !== undefined) next.baseUrl = e.baseUrl || undefined;
    if (e.apiKey !== undefined) next.apiKey = e.apiKey || undefined;
    settings.endpoints[id] = next;
  }
  await write(settings);
  return publicModelSettings();
}
