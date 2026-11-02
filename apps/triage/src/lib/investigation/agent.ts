import { type LanguageModel, type ModelMessage, ToolLoopAgent } from "ai";
import { cacheKey, callSettings, languageModel, modelErrorText, modelOptions, reasoningKind, wakeProvider } from "../models/client";
import { runBudget } from "../models/policy";
import { providers } from "../models/providers";
import { fanoutLead, stageModel, stageProblem } from "../models/settings";
import { recordedEffort } from "../models/stages";
import { fuller, noTokens, onEachCall, type TokenCounts } from "../models/usage";
import { runAgentLoop } from "./agent-loop";
import { runFanout, type Stage } from "./fanout/run";
import { runFixStage } from "./fix/agent";
import { liveAlert, p95, requestSamples } from "./live/live-source";
import { takeRunSnapshot } from "./live/run-snapshot";
import { liveService } from "../live/types";
import { proposeMitigation } from "./mitigation/propose";
import { readTelemetry, RETENTION_MS } from "./live/otlp-files";
import { uptimeNote } from "./context";
import { InvestigationRecorder, type ThoughtRecorder } from "./recorder";
import type { Scenario } from "./scenarios";
import { createScenarioSource } from "./scenarios";
import type { Incident, Thought } from "./schema";
import type { MetricSeries, TelemetrySource } from "./source";
import { saveIncident } from "./store";
import { createInvestigationTools } from "./tools";
import { beforeAnswer, type Part } from "./web-search";
import { describeRule, matchesTarget, readRules, tripMetric, tripTitle, type WatchRule } from "./watch-rules";

const MAX_STEPS = 30;
// Steps left when only submit_report stays available.
const SUBMIT_RESERVE = 4;
// Times a run that stops with plain text is told to keep going.
const MAX_NUDGES = 2;
const NUDGE =
  "You have not submitted an accepted report yet. Keep investigating if needed, then call submit_report.";

// The method and the report's rules are shared with the fan-out's scout
// and merge (fanout/prompts.ts).
export const investigationMethod = `Method:
1. Establish the symptom: query the alerting metric and related metrics (latency, error ratio, request rate, saturation).
2. Go broad before deep: check logs (errors first, then warnings and unusual info), traces of failing and slow requests, and the database.
3. Correlate in time: what changed right before the symptom? Check deploy_history and git_log, then read the source the changes touched.
4. Cover the whole dependency path, including services that look quiet. Ask what stopped emitting, not only what is loud.
5. Form competing hypotheses and test each against evidence. Reject the ones the evidence contradicts.

Make independent queries in the same turn: metrics, logs and traces for several services at once, then read the results together.`;

export const reportRules = `Rules:
- Every claim must cite evidence IDs exactly as tools returned them (ev_metric_1, ev_log_2, ...). Never invent an ID.
- For a root_cause verdict give at least 3 hypotheses: one leading, the others plausible or rejected, each rejection with rejectedBecause citing evidence.
- Confidence is a calibrated probability between 0 and 1; the hypotheses' confidences should roughly sum to 1.
- If every signal is at baseline, the verdict is healthy. Do not invent a cause. If evidence is insufficient, the verdict is inconclusive and lists what is missing.
- A breach with no fault behind it is also healthy: a false alarm, a one-off slow request that recovered (a dev server compiling a route on its first request), or too little traffic for the metric to mean anything. Put that in the healthy verdict's rationale. A root_cause verdict names a fault in the system (code, config, data, a dependency) that caused the breach.
- Keep claims short and specific: name the file, function, metric, or commit.
- The report's summary is for a human skimming the alert, not for you: plain English, under 40 words, no metric or tool names. Claims carry the specifics.
- Finish by calling submit_report. If it is rejected, fix the listed problems and submit again.`;

const instructions = `You are Triage, an SRE investigating a production alert for a small team with no SRE.

${investigationMethod}

${reportRules}`;

// The alert as every investigating agent reads it, then its `task`.
export function prompt(incident: Incident, source: TelemetrySource, task = "Investigate and submit your report."): string {
  const d = source.describe();
  const services = d.services
    .map((s) => `${s.name}${s.dependsOn.length ? ` -> ${s.dependsOn.join(", ")}` : ""}`)
    .join("; ");
  const rule = incident.trigger.rule;
  const note = uptimeNote(source);
  return `Alert: ${incident.title}
Service: ${incident.service}
Metric: ${incident.trigger.metric} observed ${incident.trigger.observed} ${incident.trigger.unit} (threshold ${incident.trigger.threshold})${rule ? `\nWatch rule: ${rule.name}, ${rule.description}` : ""}
Alert time (treat as now): ${d.now}${focusLine(incident.trigger.focus)}
Dependency path: ${services}
${note ? `\n${note}\n` : ""}
${task}`;
}

function focusLine(focus: Incident["trigger"]["focus"]): string {
  if (!focus) return "";
  return `\nFocus: a person selected ${focus.from} to ${focus.to}${focus.route ? ` on ${focus.route}` : ""} on the live telemetry page. Explain what happened in that range, even if nothing crossed a limit.`;
}

export async function createScenarioIncident(scenario: Scenario): Promise<Incident> {
  const incident = await scenarioIncident(scenario);
  await saveIncident(incident);
  return incident;
}

// The scenario's incident, not saved: the benchmark keeps its runs out of
// the incident list.
export async function scenarioIncident(scenario: Scenario): Promise<Incident> {
  const source = createScenarioSource(scenario);
  const alert = await source.queryMetric({ name: scenario.alert.metric, windowMinutes: 30 });
  if (!alert) throw new Error(`scenario ${scenario.id} has no series for ${scenario.alert.metric}`);
  return newIncident(source, alert, {
    title: scenario.alert.title,
    service: scenario.alert.service,
    severity: scenario.alert.severity,
    threshold: scenario.alert.threshold,
  });
}

// A live run someone starts raises the same alert the pool-leak scenario
// does, from the store's real latency. Below threshold it still runs, as a
// health check, unless `errorRatio` is over ERROR_LIMIT. (The watch opens
// its incidents from its rules instead: createRuleIncident.)
export const ERROR_LIMIT = 0.05;

export async function createLiveIncident(
  source: TelemetrySource,
  opts: { openedBy?: Incident["openedBy"]; errorRatio?: number } = {},
): Promise<Incident> {
  const alert = await source.queryMetric({ name: liveAlert.metric, windowMinutes: 30 });
  if (!alert || alert.points.length === 0) {
    throw new Error(
      `No requests to ${liveAlert.route} in the last 30 minutes. Start traffic from Shopfront's /ops page and check the collector is writing infra/telemetry.`,
    );
  }
  const firing = alert.points[alert.points.length - 1].value > liveAlert.threshold;
  const erroring = (opts.errorRatio ?? 0) > ERROR_LIMIT;
  return saveNewIncident(source, alert, {
    title: firing
      ? `p95 latency above ${liveAlert.threshold} ms on GET ${liveAlert.route}`
      : erroring
        ? `Error rate above ${ERROR_LIMIT * 100}% on GET ${liveAlert.route}`
        : `Health check: p95 latency on GET ${liveAlert.route}`,
    service: "shopfront",
    severity: firing || erroring ? "sev2" : "sev4",
    threshold: liveAlert.threshold,
    openedBy: opts.openedBy ?? "person",
  });
}

// An incident for a range a person selected on the live page: the route
// they picked, or the slowest one in the range, charted against its p95
// limit, with the range on the incident for the agent to focus on. Only
// the live service can be investigated, so it's always that one's routes.
export async function createRangeIncident(
  source: TelemetrySource,
  { service, ...focus }: { service: string; from: string; to: string; route?: string },
): Promise<Incident> {
  // The page only offers a range on the live service; this keeps a request
  // for another from opening a Shopfront incident.
  if (service !== liveService) throw new Error(`Triage can only investigate ${liveService} for now, not ${service}.`);
  const from = Date.parse(focus.from);
  const to = Date.parse(focus.to);
  const requests = requestSamples((await readTelemetry()).spans, from, to).filter((r) => r.service === liveService);
  if (focus.route && !requests.some((r) => r.route === focus.route)) {
    throw new Error(`No ${liveService} requests on ${focus.route} in the selected range to investigate.`);
  }
  const byRoute = Map.groupBy(requests, (r) => r.route);
  const route =
    focus.route ??
    [...byRoute.entries()].sort(([, a], [, b]) => p95(b.map((r) => r.durationMs)) - p95(a.map((r) => r.durationMs)))[0]?.[0];
  const inRange = route ? byRoute.get(route) : undefined;
  if (!route || !inRange) throw new Error(`No ${liveService} requests in the selected range to investigate.`);

  const rule = (await readRules()).find((r) => r.enabled && r.condition.metric === "p95" && matchesTarget(r.target, route));
  const threshold = rule?.condition.metric === "p95" ? rule.condition.aboveMs : liveAlert.threshold;
  // The chart reaches back past the start of the range, however long ago
  // it was selected (telemetry is kept for RETENTION_MS).
  const windowMinutes = Math.min(Math.max(30, Math.ceil((Date.now() - from) / 60_000) + 5), RETENTION_MS / 60_000);
  const alert = await source.queryMetric({ name: `http.server.request.duration.p95{route=${route}}`, windowMinutes });
  if (!alert || alert.points.length === 0) throw new Error(`No latency series for ${route} to open an incident from.`);
  const clock = (iso: string) => iso.slice(11, 19);
  return saveNewIncident(source, alert, {
    title: `Investigate ${inRange[0].method} ${route}, ${clock(focus.from)} to ${clock(focus.to)} UTC`,
    service: liveService,
    severity: "sev3",
    threshold,
    // What the range measured, not the minute the incident opened in.
    observed: Math.round(p95(inRange.map((r) => r.durationMs))),
    openedBy: "person",
    focus: { ...focus, route },
  });
}

// An incident a watch rule opened: titled by the rule and the route that
// tripped it, its chart that route's latency (or error ratio) against the
// rule's limit.
export async function createRuleIncident(
  source: TelemetrySource,
  trip: { rule: WatchRule; route: string; method: string },
): Promise<Incident> {
  const { metric, threshold } = tripMetric(trip.rule, trip.route);
  const alert = await source.queryMetric({ name: metric, windowMinutes: 30 });
  if (!alert || alert.points.length === 0) throw new Error(`No ${metric} series to open an incident from.`);
  return saveNewIncident(source, alert, {
    title: tripTitle(trip.rule, trip.method, trip.route),
    service: "shopfront",
    severity: trip.rule.severity,
    threshold,
    openedBy: "watch",
    rule: { id: trip.rule.id, name: trip.rule.name, description: describeRule(trip.rule) },
    route: trip.route,
  });
}

type NewIncident = {
  title: string;
  service: string;
  severity: Incident["severity"];
  threshold: number;
  // The latest point of the series unless given.
  observed?: number;
  openedBy?: Incident["openedBy"];
  rule?: Incident["trigger"]["rule"];
  route?: string;
  focus?: Incident["trigger"]["focus"];
  uptime?: Incident["uptime"];
};

// Saves a new incident charting `alert`, ready for runInvestigation. Shared
// by every way one opens, uptime/incident.ts included.
export async function saveNewIncident(source: TelemetrySource, alert: MetricSeries, a: NewIncident): Promise<Incident> {
  const incident = await newIncident(source, alert, a);
  await saveIncident(incident);
  return incident;
}

async function newIncident(source: TelemetrySource, alert: MetricSeries, a: NewIncident): Promise<Incident> {
  const stage = await stageModel("investigate");
  const incident: Incident = {
    id: `inc_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`,
    title: a.title,
    service: a.service,
    severity: a.severity,
    status: "investigating",
    detectedAt: source.describe().now,
    openedBy: a.openedBy ?? "person",
    trigger: {
      metric: alert.name,
      unit: alert.unit,
      threshold: a.threshold,
      observed: a.observed ?? alert.points[alert.points.length - 1].value,
      series: alert.points,
      rule: a.rule,
      route: a.route,
      focus: a.focus,
    },
    steps: [],
    evidence: [],
    run: {
      source: source.describe().id,
      provider: stage.provider,
      model: stage.model,
      reasoningEffort: recordedEffort(stage),
      startedAt: new Date().toISOString(),
    },
    uptime: a.uptime,
  };
  return incident;
}

// Stage 2: investigate until a report passes validation, then persist the
// verdict. With `appDir` (the app's code on disk, so live runs only), a
// root-cause verdict goes on to Stages 3 and 4: write a fix and prove it.
// Never throws; failures are recorded on the incident.
// The model's thinking, recorded as it happens: a thought starts with each
// model call (shown as "Thinking…") and fills in with its reasoning and any
// text when the call ends, before the tool calls it asked for run. The SDK's
// callId is shared by every call in one generate(), so each thought gets its
// own id; an agent's calls run one at a time, so the open one is the last.
// A call that searched the web answers after its last search; only the text
// before it is thinking aloud.
export function recordThoughts(recorder: ThoughtRecorder, kind: Thought["reasoningKind"]) {
  let open: string | undefined;
  const joined = (content: readonly Part[], type: string) =>
    content.flatMap((p) => (p.type === type && p.text?.trim() ? [p.text.trim()] : [])).join("\n\n") || undefined;
  return {
    onLanguageModelCallStart: () => {
      open = `th_${crypto.randomUUID().slice(0, 8)}`;
      recorder.startThought(open);
    },
    onLanguageModelCallEnd: ({ content }: { content: readonly Part[] }) => {
      if (!open) return;
      const text = joined(beforeAnswer(content), "text");
      recorder.endThought(open, { reasoning: joined(content, "reasoning"), reasoningKind: kind, text });
      open = undefined;
    },
  };
}

// A call of the stage's model, the single agent's or a fan-out lane's, as
// the run's context if it's the fullest yet.
export function recordRunContext(recorder: InvestigationRecorder, call: TokenCounts) {
  const run = recorder.incident.run!;
  recorder.update({ run: { ...run, context: fuller(run.context, call) } });
}

// `stage` and `save` are for the benchmark: a model other than Settings'
// one, and somewhere other than the incident store.
export async function runInvestigation(
  incident: Incident,
  source: TelemetrySource,
  opts: {
    appDir?: string;
    stage?: Stage;
    save?: (incident: Incident) => Promise<void>;
    // A fan-out investigation (fanout/run.ts): `lead` surveys and merges,
    // the stage's model checks each hypothesis. false: one agent. Left out,
    // as Settings has it ("Check hypotheses in parallel", with the Lead
    // stage's model); the benchmark always passes one, so Settings never
    // changes what it measures.
    fanout?: { lead: Stage } | false;
    // Tests: a scripted model in place of each provider's.
    languageModel?: (s: Stage) => LanguageModel;
    // A re-run of an incident (rerun.ts): its own fix model, the source as
    // the first run saw it (`baseDir`, copied over the app in the sandbox),
    // and no notification. A re-run takes no snapshot of its own.
    rerun?: { fix?: Stage; baseDir?: string };
  } = {},
): Promise<Incident> {
  const recorder = new InvestigationRecorder(incident, opts.save ?? saveIncident);
  const tools = createInvestigationTools(source, recorder);
  // A live run saves what a re-run couldn't read again (live/run-snapshot.ts)
  // as it starts, alongside the investigation.
  const snapshotting =
    opts.appDir && !opts.rerun
      ? takeRunSnapshot(incident.id, source).then((snapshot) => snapshot && recorder.update({ snapshot }))
      : undefined;

  // The investigate stage's model as configured in Settings now, recorded
  // on the run. A stage that can't run (no key, no URL) fails the run, and
  // so does a fan-out's lead.
  const stage = opts.stage ?? (await stageModel("investigate"));
  const lead = opts.fanout === undefined ? await fanoutLead() : opts.fanout ? opts.fanout.lead : undefined;
  recorder.update({
    run: { ...recorder.incident.run!, provider: stage.provider, model: stage.model, reasoningEffort: recordedEffort(stage) },
  });
  const problem = stageProblem(stage) ?? (lead && stageProblem(lead));
  if (problem) {
    recorder.update({ status: "failed", run: { ...recorder.incident.run!, finishedAt: new Date().toISOString(), error: problem } });
    await snapshotting;
    await recorder.flush();
    return recorder.incident;
  }

  let retries = 0;
  const model = (s: Stage) => opts.languageModel?.(s) ?? languageModel(s, { onRetry: () => retries++ });
  // Model steps across every agent of the run: a fan-out's scout, lanes and
  // merge, and the single agent, which a failed scout hands over to.
  const count = { steps: 0 };

  // The agent can't be forced to call submit_report (see runAgentLoop), so
  // near the step cap it's the only tool left, and a run that ends in plain
  // text without an accepted report is nudged to continue.
  const agent = new ToolLoopAgent({
    model: model(stage),
    providerOptions: modelOptions(stage, cacheKey("investigate", incident.id)),
    ...callSettings(),
    ...recordThoughts(recorder, reasoningKind(stage.provider)),
    ...onEachCall((call) => recordRunContext(recorder, call)),
    instructions,
    tools,
    stopWhen: [() => count.steps >= MAX_STEPS, () => recorder.report !== undefined],
    prepareStep: () => {
      count.steps += 1;
      return count.steps > MAX_STEPS - SUBMIT_RESERVE && !recorder.report
        ? { activeTools: ["submit_report" as const] }
        : {};
    },
  });

  try {
    // A host that scales to zero gets its GPU started before the first
    // model call, which would otherwise outwait its request timeout.
    const cold = [stage, ...(lead ? [lead] : [])].filter((s) => providers[s.provider].coldStart);
    if (cold.length) {
      recorder.update({ run: { ...recorder.incident.run!, wakingSince: new Date().toISOString() } });
      await Promise.all(cold.map(wakeProvider));
      recorder.update({ run: { ...recorder.incident.run!, wakingSince: undefined } });
    }
    // The run's time limit starts once the host is awake.
    const budget = runBudget("investigate");
    // The stage's model's tokens (the single agent's, or a fan-out's lanes'
    // and fallback's) go on the run; a fan-out's lead's on run.fanout, so
    // each is priced at its own model's rates.
    const tokens = noTokens();
    const leadTokens = noTokens();
    // The single agent, until a report is accepted or its steps run out.
    const alone = (messages: ModelMessage[]) =>
      runAgentLoop({
        agent,
        messages,
        abortSignal: budget,
        steps: () => count.steps,
        maxSteps: MAX_STEPS,
        maxNudges: MAX_NUDGES,
        nudge: NUDGE,
        done: () => recorder.report !== undefined,
        tokens,
      });
    if (lead) await runFanout({ incident, source, recorder, budget, tokens, leadTokens, count, lane: stage, lead, model, alone });
    else await alone([{ role: "user", content: prompt(incident, source) }]);

    const report = recorder.report;
    const fanout = recorder.incident.run!.fanout;
    recorder.update({
      status: !report ? "failed" : report.verdict.kind === "healthy" ? "healthy" : "diagnosed",
      run: {
        ...recorder.incident.run!,
        finishedAt: new Date().toISOString(),
        modelSteps: count.steps,
        ...tokens,
        ...(fanout && { fanout: { ...fanout, ...leadTokens } }),
        rejectedReports: recorder.rejectedReports,
        modelRetries: retries,
        error: report ? undefined : `No accepted report after ${count.steps} model steps`,
      },
    });
    if (report?.verdict.kind === "root_cause") {
      const mitigation = proposeMitigation(report, recorder.evidence, incident.service, undefined, incident.detectedAt);
      if (mitigation) recorder.update({ mitigation });
    }
  } catch (err) {
    console.error("[triage] investigation failed", incident.id, err);
    recorder.update({
      status: "failed",
      run: {
        ...recorder.incident.run!,
        wakingSince: undefined,
        finishedAt: new Date().toISOString(),
        rejectedReports: recorder.rejectedReports,
        modelRetries: retries,
        error: modelErrorText(err, stage.provider),
      },
    });
  }
  recorder.dropUnfinishedThoughts();
  if (opts.appDir && recorder.incident.status === "diagnosed" && recorder.report?.verdict.kind === "root_cause") {
    await runFixStage(recorder, source, opts.appDir, {
      ...(opts.rerun && { stage: opts.rerun.fix, baseDir: opts.rerun.baseDir, notify: false }),
    });
  }
  await snapshotting;
  await recorder.flush();
  return recorder.incident;
}
