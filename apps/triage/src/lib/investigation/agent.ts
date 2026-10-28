import { type ModelMessage, ToolLoopAgent } from "ai";
import { languageModel } from "../models/client";
import { stageModel, stageProblem } from "../models/settings";
import { runFixStage } from "./fix/agent";
import { liveAlert } from "./live/live-source";
import { InvestigationRecorder } from "./recorder";
import type { Scenario } from "./scenarios";
import { createScenarioSource } from "./scenarios";
import type { Incident } from "./schema";
import type { MetricSeries, TelemetrySource } from "./source";
import { saveIncident } from "./store";
import { createInvestigationTools } from "./tools";
import { describeRule, tripMetric, tripTitle, type WatchRule } from "./watch-rules";

const MAX_STEPS = 30;
// Steps left when only submit_report stays available.
const SUBMIT_RESERVE = 4;
// Times a run that stops with plain text is told to keep going.
const MAX_NUDGES = 2;
const NUDGE =
  "You have not submitted an accepted report yet. Keep investigating if needed, then call submit_report.";

const instructions = `You are Triage, an SRE investigating a production alert for a small team with no SRE.

Method:
1. Establish the symptom: query the alerting metric and related metrics (latency, error ratio, request rate, saturation).
2. Go broad before deep: check logs (errors first, then warnings and unusual info), traces of failing and slow requests, and the database.
3. Correlate in time: what changed right before the symptom? Check deploy_history and git_log, then read the source the changes touched.
4. Cover the whole dependency path, including services that look quiet. Ask what stopped emitting, not only what is loud.
5. Form competing hypotheses and test each against evidence. Reject the ones the evidence contradicts.

Rules:
- Every claim must cite evidence IDs exactly as tools returned them (ev_metric_1, ev_log_2, ...). Never invent an ID.
- For a root_cause verdict give at least 3 hypotheses: one leading, the others plausible or rejected, each rejection with rejectedBecause citing evidence.
- Confidence is a calibrated probability between 0 and 1; the hypotheses' confidences should roughly sum to 1.
- If every signal is at baseline, the verdict is healthy. Do not invent a cause. If evidence is insufficient, the verdict is inconclusive and lists what is missing.
- Keep claims short and specific: name the file, function, metric, or commit.
- The report's summary is for a human skimming the alert, not for you: plain English, under 40 words, no metric or tool names. Claims carry the specifics.
- Finish by calling submit_report. If it is rejected, fix the listed problems and submit again.`;

function prompt(incident: Incident, source: TelemetrySource): string {
  const d = source.describe();
  const services = d.services
    .map((s) => `${s.name}${s.dependsOn.length ? ` -> ${s.dependsOn.join(", ")}` : ""}`)
    .join("; ");
  const rule = incident.trigger.rule;
  return `Alert: ${incident.title}
Service: ${incident.service}
Metric: ${incident.trigger.metric} observed ${incident.trigger.observed} ${incident.trigger.unit} (threshold ${incident.trigger.threshold})${rule ? `\nWatch rule: ${rule.name}, ${rule.description}` : ""}
Alert time (treat as now): ${d.now}
Dependency path: ${services}

Investigate and submit your report.`;
}

export async function createScenarioIncident(scenario: Scenario): Promise<Incident> {
  const source = createScenarioSource(scenario);
  const alert = await source.queryMetric({ name: scenario.alert.metric, windowMinutes: 30 });
  if (!alert) throw new Error(`scenario ${scenario.id} has no series for ${scenario.alert.metric}`);
  return saveNewIncident(source, alert, {
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
  });
}

async function saveNewIncident(
  source: TelemetrySource,
  alert: MetricSeries,
  a: {
    title: string;
    service: string;
    severity: Incident["severity"];
    threshold: number;
    openedBy?: Incident["openedBy"];
    rule?: Incident["trigger"]["rule"];
  },
): Promise<Incident> {
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
      observed: alert.points[alert.points.length - 1].value,
      series: alert.points,
      rule: a.rule,
    },
    steps: [],
    evidence: [],
    run: { source: source.describe().id, provider: stage.provider, model: stage.model, startedAt: new Date().toISOString() },
  };
  await saveIncident(incident);
  return incident;
}

// Stage 2: investigate until a report passes validation, then persist the
// verdict. With `appDir` (the app's code on disk, so live runs only), a
// root-cause verdict goes on to Stages 3 and 4: write a fix and prove it.
// Never throws; failures are recorded on the incident.
export async function runInvestigation(
  incident: Incident,
  source: TelemetrySource,
  opts: { appDir?: string } = {},
): Promise<Incident> {
  const recorder = new InvestigationRecorder(incident, saveIncident);
  const tools = createInvestigationTools(source, recorder);

  // The investigate stage's model as configured in Settings now, recorded
  // on the run. A stage that can't run (no key, no URL) fails the run.
  const stage = await stageModel("investigate");
  recorder.update({ run: { ...recorder.incident.run!, provider: stage.provider, model: stage.model } });
  const problem = stageProblem(stage);
  if (problem) {
    recorder.update({ status: "failed", run: { ...recorder.incident.run!, finishedAt: new Date().toISOString(), error: problem } });
    await recorder.flush();
    return recorder.incident;
  }

  // Meta's API only supports tool_choice "auto" (other providers vary), so
  // the agent can't be forced to call tools. Instead: near the step cap only submit_report
  // stays available, and a run that ends in plain text without an accepted
  // report is nudged to continue.
  let stepsUsed = 0;
  const agent = new ToolLoopAgent({
    model: languageModel(stage),
    instructions,
    tools,
    stopWhen: [() => stepsUsed >= MAX_STEPS, () => recorder.report !== undefined],
    prepareStep: () => {
      stepsUsed += 1;
      return stepsUsed > MAX_STEPS - SUBMIT_RESERVE && !recorder.report
        ? { activeTools: ["submit_report" as const] }
        : {};
    },
  });

  try {
    const messages: ModelMessage[] = [{ role: "user", content: prompt(incident, source) }];
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt <= MAX_NUDGES && !recorder.report && stepsUsed < MAX_STEPS; attempt++) {
      if (attempt > 0) messages.push({ role: "user", content: NUDGE });
      const result = await agent.generate({ messages });
      messages.push(...result.responseMessages);
      inputTokens += result.usage.inputTokens ?? 0;
      outputTokens += result.usage.outputTokens ?? 0;
    }

    const report = recorder.report;
    recorder.update({
      status: !report ? "failed" : report.verdict.kind === "healthy" ? "healthy" : "diagnosed",
      run: {
        ...recorder.incident.run!,
        finishedAt: new Date().toISOString(),
        modelSteps: stepsUsed,
        inputTokens,
        outputTokens,
        rejectedReports: recorder.rejectedReports,
        error: report ? undefined : `No accepted report after ${stepsUsed} model steps`,
      },
    });
  } catch (err) {
    console.error("[triage] investigation failed", incident.id, err);
    recorder.update({
      status: "failed",
      run: {
        ...recorder.incident.run!,
        finishedAt: new Date().toISOString(),
        rejectedReports: recorder.rejectedReports,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
  if (opts.appDir && recorder.incident.status === "diagnosed" && recorder.report?.verdict.kind === "root_cause") {
    await runFixStage(recorder, source, opts.appDir);
  }
  await recorder.flush();
  return recorder.incident;
}
