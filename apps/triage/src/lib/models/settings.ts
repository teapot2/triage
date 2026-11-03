import { z } from "zod";
import { storedDocument } from "../documents";
import { isOpenWeights, isSparkOpen, providerIdSchema, providerIds, providers, type ProviderId } from "./providers";
import {
  type NotificationEvent,
  notificationEvents,
  slackAppTokenPattern,
  slackBotTokenPattern,
  slackChannelPattern,
  slackUserPattern,
  slackWebhookPattern,
} from "../notifications/types";
import { defaultTemplate, type Template, templateProblems, templateSchema } from "../investigation/postmortem/template";
import {
  defaultDependencySettings,
  type DependencySettings,
  dependencySettingsSchema,
} from "../investigation/dependencies/model";
import { defaultEffort, leadDefault, reasoningEffortSchema, type StageId, stageFallback, stageIdSchema, stageIds } from "./stages";

export { type StageId, stageIdSchema, stageIds } from "./stages";

// Which model each stage uses, and the endpoints of the configurable
// providers. Saved server-side, as the "settings" document in .data/triage.db
// (documents.ts; it used to be .data/settings.json), since the stages run on
// the server, the watch included. It can hold keys, so only
// publicModelSettings ever leaves the server. It is the one document for
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
      slackBot: z
        .object({
          botToken: z.string().regex(slackBotTokenPattern).optional(),
          appToken: z.string().regex(slackAppTokenPattern).optional(),
          channel: z.string().regex(slackChannelPattern).optional(),
          approvers: z.array(z.string().regex(slackUserPattern)).default([]),
        })
        .optional(),
    })
    .optional(),
});
type Settings = z.infer<typeof settingsSchema>;

// A settings.json that doesn't parse throws rather than reading as empty:
// the next save would drop the keys it held.
const settingsDocument = storedDocument("settings", "settings.json", (v) => settingsSchema.parse(v));

// Before anything is saved, every stage uses the env's model on Meta's API,
// except the Lead, which starts on Wonder.
const defaultStage = (stage: StageId): StageModel =>
  stage === "lead" ? { ...leadDefault } : { provider: "meta", model: process.env.MODEL_ID ?? "muse-spark-1.3" };

const empty = (): Settings => ({ stages: {}, endpoints: {} });

async function read(): Promise<Settings> {
  return settingsDocument.read() ?? empty();
}

// Reads, changes and saves the settings in one transaction, so two changes
// at once both land. fn changes the settings in place.
function change(fn: (settings: Settings) => void): void {
  settingsDocument.change((saved) => {
    const settings = saved ?? empty();
    fn(settings);
    return settings;
  });
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
  change((settings) => {
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
  });
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
  change((settings) => {
    settings.postmortemTemplate = parsed.data;
  });
  return parsed.data;
}

// Back to the built-in sections.
export async function clearTemplate(): Promise<void> {
  change((settings) => {
    delete settings.postmortemTemplate;
  });
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
  change((settings) => {
    const next = { ...settings.notifications };
    if (update.slackWebhookUrl !== undefined) next.slackWebhookUrl = update.slackWebhookUrl || undefined;
    if (update.events) next.events = { ...next.events, ...update.events };
    settings.notifications = next;
  });
}

export type SlackBot = { botToken?: string; appToken?: string; channel?: string; approvers: string[] };

// The Slack bot's settings as saved, for the server only: they include the
// tokens. Posting needs botToken and channel; the buttons need appToken too.
export async function readSlackBot(): Promise<SlackBot> {
  const saved = (await read()).notifications?.slackBot;
  return { ...saved, approvers: saved?.approvers ?? [] };
}

// Each field: a new value, "" to remove it, or absent to keep the saved one.
// approvers replaces the list when given.
export async function writeSlackBot(update: {
  botToken?: string;
  appToken?: string;
  channel?: string;
  approvers?: string[];
}): Promise<void> {
  change((settings) => {
    const next = { approvers: [], ...settings.notifications?.slackBot };
    for (const key of ["botToken", "appToken", "channel"] as const) {
      if (update[key] !== undefined) next[key] = update[key] || undefined;
    }
    if (update.approvers) next.approvers = update.approvers;
    settings.notifications = { ...settings.notifications, slackBot: next };
  });
}

// The dependency audit's settings (investigation/dependencies), a document
// of their own: "dependency-audit". Nothing saved reads as the defaults:
// on, every 6 h, incidents from high.
const dependencyDocument = storedDocument("dependency-audit", "dependency-audit.json", (v) => dependencySettingsSchema.parse(v));

export async function readDependencySettings(): Promise<DependencySettings> {
  return dependencyDocument.read() ?? defaultDependencySettings();
}

// Fields left out keep their saved value; serviceDir "" goes back to
// Shopfront's checkout.
export async function writeDependencySettings(update: Partial<DependencySettings>): Promise<DependencySettings> {
  return dependencyDocument.change((saved) => {
    const next = { ...(saved ?? defaultDependencySettings()), ...update };
    if (!next.serviceDir) delete next.serviceDir;
    return dependencySettingsSchema.parse(next);
  });
}
