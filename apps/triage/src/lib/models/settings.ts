import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isOpenWeights, isSparkOpen, providerIdSchema, providerIds, providers, type ProviderId } from "./providers";
import { type NotificationEvent, notificationEvents, slackWebhookPattern } from "../notifications/types";
import { defaultTemplate, type Template, templateProblems, templateSchema } from "../investigation/postmortem/template";
import { defaultEffort, leadDefault, reasoningEffortSchema, type StageId, stageFallback, stageIdSchema, stageIds } from "./stages";

export { type StageId, stageIdSchema, stageIds } from "./stages";

// Which model each stage uses, and the endpoints of the configurable
// providers. Saved server-side, in .data/settings.json (gitignored), since
// the stages run on the server, the watch included. The file can hold keys,
// so only publicModelSettings ever leaves the server. It is the one file for
// the app's settings, so it also holds the non-model keys: the postmortem
// template, and the notifications (a Slack webhook URL, a secret like the
// keys, and which events send a message).
//
// fanout: whether investigations check their hypotheses in parallel, the
// Lead stage proposing and merging them (lib/investigation/fanout). Missing
// (off) on files saved before it existed.
//
// webSearch: whether the Fix stage, and Ask by default, may search the web
// on Meta's API. Missing means on.

// effort: Meta's reasoning effort for the stage. Missing on settings saved
// before it existed, and on presets, which leave each stage its default.
const stageModelSchema = z.object({
  provider: providerIdSchema,
  model: z.string().trim().min(1).max(200),
  effort: reasoningEffortSchema.optional(),
});
export type StageModel = z.infer<typeof stageModelSchema>;

const endpointSchema = z.object({
  baseUrl: z.url().optional(),
  apiKey: z.string().max(500).optional(),
});

const settingsSchema = z.object({
  stages: z.partialRecord(stageIdSchema, stageModelSchema).default({}),
  endpoints: z.partialRecord(providerIdSchema, endpointSchema).default({}),
  fanout: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  postmortemTemplate: templateSchema.optional(),
  notifications: z
    .object({
      slackWebhookUrl: z.string().regex(slackWebhookPattern).optional(),
      events: z.partialRecord(z.enum(notificationEvents), z.boolean()).optional(),
    })
    .optional(),
});
type Settings = z.infer<typeof settingsSchema>;

const file = path.join(process.cwd(), ".data", "settings.json");

// Before anything is saved, every stage uses the env's model on Meta's API,
// except the Lead, which starts on Wonder.
const defaultStage = (stage: StageId): StageModel =>
  stage === "lead" ? { ...leadDefault } : { provider: "meta", model: process.env.MODEL_ID ?? "muse-spark-1.3" };

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

// The stage's saved model, else the first saved one down its fallback chain
// (Postmortem uses Ask's, then Investigate's), else the env's. The effort is
// always the stage's own, saved or default, never one down the chain.
export function chosenModel(settings: Pick<Settings, "stages">, stage: StageId): Required<StageModel> {
  let chosen = defaultStage(stage);
  for (let s: StageId | undefined = stage; s; s = stageFallback[s]) {
    const saved = settings.stages[s];
    if (saved) {
      chosen = saved;
      break;
    }
  }
  return { provider: chosen.provider, model: chosen.model, effort: settings.stages[stage]?.effort ?? defaultEffort[stage] };
}

export async function stageModel(stage: StageId): Promise<Required<StageModel> & Endpoint> {
  const settings = await read();
  const chosen = chosenModel(settings, stage);
  return { ...chosen, ...endpointOf(settings, chosen.provider) };
}

// A stage's model as a run chose it rather than Settings (a re-run, and its
// fix and postmortem after), with its provider's endpoint; the stage's
// default effort when it named none. Undefined for a provider Triage
// doesn't know.
export async function choiceModel(
  stage: StageId,
  choice: { provider: string; model: string; effort?: z.infer<typeof reasoningEffortSchema> },
): Promise<(Required<StageModel> & Endpoint) | undefined> {
  const provider = providerIdSchema.safeParse(choice.provider);
  if (!provider.success) return undefined;
  const settings = await read();
  return {
    provider: provider.data,
    model: choice.model,
    effort: choice.effort ?? defaultEffort[stage],
    ...endpointOf(settings, provider.data),
  };
}

// The run's own model for the stage when it chose one, else Settings'.
export async function runStageModel(
  stage: StageId,
  choice: Parameters<typeof choiceModel>[1] | undefined,
): Promise<Required<StageModel> & Endpoint> {
  return (choice && (await choiceModel(stage, choice))) ?? stageModel(stage);
}

// The Lead's model when Settings has investigations fan out, else
// undefined: the single agent.
export async function fanoutLead(): Promise<(Required<StageModel> & Endpoint) | undefined> {
  return (await read()).fanout ? stageModel("lead") : undefined;
}

// Whether Fix searches the web, and Ask does unless the question says.
export async function webSearchOn(): Promise<boolean> {
  return (await read()).webSearch ?? true;
}

// Why an investigation can't start as configured: its stage's problem, or
// the Lead's when it fans out. Undefined when it can.
export async function investigationProblem(): Promise<string | undefined> {
  const lead = await fanoutLead();
  return stageProblem(await stageModel("investigate")) ?? (lead && stageProblem(lead));
}

// Why a stage can't run as configured, or undefined when it can.
export function stageProblem(s: StageModel & Endpoint): string | undefined {
  const info = providers[s.provider];
  if (!s.baseUrl) {
    return info.baseUrlEnv
      ? `${info.baseUrlEnv} is not set. Add your ${info.label} deployment's URL (ending in /v1) to apps/triage/.env.local and restart.`
      : `${info.label} has no base URL. Set one in Settings.`;
  }
  if (!info.local && info.configurable === false && !s.apiKey) {
    return `${info.keyEnv} is not set. Add it to apps/triage/.env.local and restart.`;
  }
  return undefined;
}

// What the browser sees: no keys, only whether one is set and where from.
export async function publicModelSettings() {
  const settings = await read();
  const stages = Object.fromEntries(stageIds.map((id) => [id, chosenModel(settings, id)])) as Record<
    StageId,
    Required<StageModel>
  >;
  const fanout = settings.fanout ?? false;
  return {
    stages,
    fanout,
    webSearch: settings.webSearch ?? true,
    // The Lead counts only while it runs.
    openWeights: stageIds.every((id) => (id === "lead" && !fanout) || isOpenWeights(stages[id].model)),
    // Any running stage on Muse Spark Open: Settings then shows "Built with
    // Muse Spark Open", as its license asks.
    builtWithSparkOpen: stageIds.some((id) => (id !== "lead" || fanout) && isSparkOpen(stages[id].model)),
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
        baseUrlEnv: info.baseUrlEnv,
        coldStart: Boolean(info.coldStart),
        hasKey: Boolean(endpoint.apiKey),
        glimmer: info.glimmer,
        sparkOpen: info.sparkOpen,
        spark: info.spark,
      };
    }),
  };
}
export type PublicModelSettings = Awaited<ReturnType<typeof publicModelSettings>>;

export const updateSchema = z.object({
  stages: z.partialRecord(stageIdSchema, stageModelSchema).optional(),
  fanout: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  // apiKey: a new key, "" to clear it, or absent to keep the saved one.
  endpoints: z.partialRecord(providerIdSchema, z.object({ baseUrl: z.url().or(z.literal("")).optional(), apiKey: z.string().max(500).optional() })).optional(),
});

export async function updateModelSettings(update: z.infer<typeof updateSchema>) {
  const settings = await read();
  for (const [id, s] of Object.entries(update.stages ?? {}) as [StageId, StageModel][]) settings.stages[id] = s;
  if (update.fanout !== undefined) settings.fanout = update.fanout;
  if (update.webSearch !== undefined) settings.webSearch = update.webSearch;
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

// The team's postmortem template as saved, else the built-in sections.
export async function readTemplate(): Promise<Template> {
  return (await read()).postmortemTemplate ?? defaultTemplate;
}

// Saves a template after checking it. Throws a TemplateError listing what is
// wrong with it.
export class TemplateError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

export async function writeTemplate(template: Template): Promise<Template> {
  const parsed = templateSchema.safeParse(template);
  if (!parsed.success) throw new TemplateError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const problems = templateProblems(parsed.data);
  if (problems.length) throw new TemplateError(problems);
  const settings = await read();
  settings.postmortemTemplate = parsed.data;
  await write(settings);
  return parsed.data;
}

// Back to the built-in sections.
export async function clearTemplate(): Promise<void> {
  const settings = await read();
  delete settings.postmortemTemplate;
  await write(settings);
}

// The notification settings as saved, for the server only: they include the
// webhook URL. An event never saved is on.
export async function readNotificationSettings(): Promise<{
  slackWebhookUrl?: string;
  events: Record<NotificationEvent, boolean>;
}> {
  const saved = (await read()).notifications;
  const events = Object.fromEntries(notificationEvents.map((e) => [e, saved?.events?.[e] ?? true])) as Record<
    NotificationEvent,
    boolean
  >;
  return { slackWebhookUrl: saved?.slackWebhookUrl, events };
}

// slackWebhookUrl: a new URL, "" to remove it, or absent to keep the saved
// one. Events left out keep their setting.
export async function writeNotificationSettings(update: {
  slackWebhookUrl?: string;
  events?: Partial<Record<NotificationEvent, boolean>>;
}): Promise<void> {
  const settings = await read();
  const next = { ...settings.notifications };
  if (update.slackWebhookUrl !== undefined) next.slackWebhookUrl = update.slackWebhookUrl || undefined;
  if (update.events) next.events = { ...next.events, ...update.events };
  settings.notifications = next;
  await write(settings);
}
