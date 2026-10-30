import { type ModelMessage, tool, ToolLoopAgent } from "ai";
import { languageModel, modelOptions } from "../../models/client";
import { stageModel, stageProblem } from "../../models/settings";
import { cite, incidentBlock } from "../context";
import { type Incident, type Postmortem, postmortemSchema } from "../schema";
import { getIncident, patchIncident } from "../store";
import { forModel } from "../tools";
import { citedEvidenceIds, MAX_FACTORS, MIN_FACTORS, type PostmortemSubmission, postmortemProblems } from "./rules";

// Stage "postmortem": the blameless postmortem's judgment (summary, impact,
// contributing factors, what went well and badly, luck, action items),
// written by one model over the incident's record. No tools but the one it
// submits with, which checks the submission like submit_report does and
// hands the problems back. Runs after the route's response.

const MAX_STEPS = 3;
// Times a run that stops with plain text, without an accepted submission,
// is told to submit.
const MAX_NUDGES = 1;
const NUDGE = "You have not submitted an accepted postmortem yet. Fix any problems listed, then call submit_postmortem.";

const instructions = `You are Triage, an SRE. Write the team's blameless postmortem for the incident below, from its record.

Rules:
- Blameless: ask how the system allowed the failure, never who caused it. A deploy "shipped", a flag "was turned on"; nobody is named. Avoid "blame", "fault of", "should have", "failed to", "careless" and "negligent": say what the system did or did not do.
- Cite every factual claim: put the evidence IDs it rests on in that claim's evidenceIds, plain (ev_log_3, not [ev_log_3]). Cite only IDs listed below. Never invent one.
- summary: three plain sentences, under 80 words, on what happened, the impact and how long it lasted. No evidence IDs.
- impact: who was affected and how.
- contributingFactors: ${MIN_FACTORS} to ${MAX_FACTORS} conditions that each had to hold for the incident to happen, where the evidence supports them: the code path, the input that triggered it, capacity (a pool size, a limit), detection (an alert that was missing or late).
- wentWell and wentBadly: detection, response and tooling.
- lucky: what could have made it worse and did not.
- actionItems: mix the four kinds (fix_this, prevent_class, detect_sooner, mitigate_faster), with a priority each. Never repeat the fix itself ("merge the PR", "approve the fix", or the fix's own words): it is added separately.
- Under 400 words in all.
- Submit with submit_postmortem. If it is rejected, fix the listed problems and submit again.`;

// The tool's input: the record's judgment, every field required.
const submissionSchema = postmortemSchema
  .omit({
    status: true,
    startedAt: true,
    finishedAt: true,
    error: true,
    provider: true,
    model: true,
    inputTokens: true,
    outputTokens: true,
    citedIds: true,
    unknownIds: true,
  })
  .required();

// The incident's times in order, as a timeline the model can quote.
function timelineBlock(incident: Incident): string {
  const events: [string | undefined, string][] = [
    [incident.detectedAt, `Alert fired, incident opened${incident.openedBy ? ` by ${incident.openedBy === "watch" ? "Triage's watch" : "a person"}` : ""}`],
    [incident.run?.startedAt, "Investigation started"],
    [incident.run?.finishedAt, `Investigation finished${incident.run?.error ? ` with an error: ${incident.run.error}` : ""}`],
  ];
  const m = incident.mitigation;
  if (m) {
    events.push([m.proposedAt, `Mitigation proposed: ${m.title}`]);
    events.push([m.decidedAt, `Mitigation ${m.state === "denied" ? "denied" : "approved"}`]);
    events.push([m.appliedAt, `Mitigation ${m.state === "failed" ? "failed" : "applied"}`]);
    events.push([m.recovery?.recoveredAt, `Alert metric back under ${m.recovery?.threshold} (recovered)`]);
  }
  for (const [n, a] of (incident.fixAttempts ?? []).entries()) {
    events.push([a.fixRun.startedAt, `Fix stage started (fix ${n + 1})`]);
    events.push([a.fixRun.finishedAt, `Fix stage finished (fix ${n + 1}): ${a.fixRun.status} after ${a.fixRun.attempt} attempts`]);
    events.push([a.approval.requestedAt, `Approval requested (fix ${n + 1})`]);
    events.push([a.approval.decidedAt, `Fix ${n + 1} denied${a.approval.reason ? `, feedback: ${a.approval.reason}` : ""}`]);
  }
  const f = incident.fixRun;
  if (f) {
    const rejections = f.rejections?.length ? `, rejected: ${f.rejections.join("; ")}` : "";
    events.push([f.startedAt, "Fix stage started"]);
    events.push([f.finishedAt, `Fix stage finished: ${f.status} after ${f.attempt} attempts${rejections}`]);
  }
  const a = incident.approval;
  if (a) {
    events.push([a.requestedAt, "Approval of the fix requested"]);
    events.push([a.decidedAt, `Fix ${a.state}${a.reason ? `, reason: ${a.reason}` : ""}`]);
  }
  for (const q of incident.questions ?? []) events.push([q.askedAt, `Question asked: ${q.text}`]);
  return events
    .filter((e): e is [string, string] => e[0] !== undefined)
    .sort((x, y) => Date.parse(x[0]) - Date.parse(y[0]))
    .map(([t, what]) => `${t} ${what}`)
    .join("\n");
}

function mitigationBlock(incident: Incident): string {
  const m = incident.mitigation;
  if (!m) return "None proposed.";
  const lines = [
    `${m.title} (${m.kind} of ${m.target}, risk ${m.risk}): ${m.state}`,
    `Why: ${cite(m.why)}`,
    `Undo: ${m.undo}`,
  ];
  if (m.error) lines.push(`Error: ${m.error}`);
  if (m.recovery) {
    const r = m.recovery;
    lines.push(`Recovery: ${r.status} (${r.metric} under ${r.threshold})${r.note ? `, ${r.note}` : ""}`);
  }
  return lines.join("\n");
}

function fixBlock(incident: Incident): string {
  const { fix, fixRun, validation } = incident;
  if (!fix) return fixRun?.declinedBecause ? `Declined: ${fixRun.declinedBecause}` : fixRun ? `No fix (${fixRun.status}).` : "None written.";
  const lines = [
    fix.summary,
    `Files: ${fix.files.join(", ")}; risk ${fix.risk}${fix.touchesData ? "; touches data" : ""}`,
    `Regression test: ${fix.regressionTest.name} (${fix.regressionTest.file})`,
  ];
  for (const run of validation ?? []) {
    const failed = run.tests.filter((t) => t.status === "failed").length;
    lines.push(`Sandbox, ${run.label}: exit ${run.exitCode}, ${run.tests.length - failed} passed, ${failed} failed${run.repro ? `; ${run.repro.request} -> ${run.repro.status} in ${run.repro.latencyMs} ms` : ""}`);
  }
  if (fixRun) lines.push(`Fix stage: ${fixRun.status} after ${fixRun.attempt} attempts`);
  return lines.join("\n");
}

// The approval, without who decided it: the postmortem names nobody.
function approvalBlock(incident: Incident): string {
  const a = incident.approval;
  if (!a) return "None requested.";
  const pr = a.prState ? `; PR ${a.prState}${a.prUrl ? ` ${a.prUrl}` : ""}` : "";
  return `${a.state}${a.reason ? `, reason: ${a.reason}` : ""}${pr}`;
}

function prompt(incident: Incident): string {
  const evidence = [...incident.evidence, ...(incident.questions ?? []).flatMap((q) => q.evidence)]
    .map((e) => JSON.stringify(forModel(e)))
    .join("\n");
  return `${incidentBlock(incident, undefined)}

Timeline:
${timelineBlock(incident)}

Mitigation:
${mitigationBlock(incident)}

Fix:
${fixBlock(incident)}

Approval:
${approvalBlock(incident)}

Evidence you may cite:
${evidence || "(none)"}

Write the postmortem and submit it.`;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 500);

// Writes the postmortem of an incident whose record is status writing (the
// route saves it so). Never throws: failures land on the record.
export async function writePostmortem(incidentId: string): Promise<void> {
  const finish = (patch: Partial<Postmortem>) =>
    patchIncident(incidentId, (i) =>
      i.postmortem?.status === "writing"
        ? { ...i, postmortem: { ...i.postmortem, ...patch, finishedAt: new Date().toISOString() } }
        : i,
    );

  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const incident = await getIncident(incidentId);
    if (incident?.postmortem?.status !== "writing") return;
    const stage = await stageModel("postmortem");
    const problem = stageProblem(stage);
    if (problem) throw new Error(problem);

    let accepted: PostmortemSubmission | undefined;
    let lastProblems: string[] = [];
    let stepsUsed = 0;
    const agent = new ToolLoopAgent({
      model: languageModel(stage),
      providerOptions: modelOptions(stage),
      instructions,
      tools: {
        submit_postmortem: tool({
          description:
            "Submit the postmortem. It is checked: 2 to 5 contributing factors, every cited evidence ID must exist, nobody named or blamed, and no action item repeating the fix. If it is rejected, fix the listed problems and submit again.",
          inputSchema: submissionSchema,
          execute: async (input) => {
            const submission = submissionSchema.parse(input);
            lastProblems = postmortemProblems(submission, incident);
            if (lastProblems.length > 0) return `Rejected:\n${lastProblems.map((p) => `- ${p}`).join("\n")}`;
            accepted = submission;
            return "Accepted.";
          },
        }),
      },
      stopWhen: [() => stepsUsed >= MAX_STEPS, () => accepted !== undefined],
      prepareStep: () => {
        stepsUsed += 1;
        return {};
      },
    });

    const messages: ModelMessage[] = [{ role: "user", content: prompt(incident) }];
    for (let pass = 0; pass <= MAX_NUDGES && !accepted && stepsUsed < MAX_STEPS; pass++) {
      if (pass > 0) messages.push({ role: "user", content: NUDGE });
      const result = await agent.generate({ messages });
      messages.push(...result.responseMessages);
      inputTokens += result.usage.inputTokens ?? 0;
      outputTokens += result.usage.outputTokens ?? 0;
    }

    if (accepted) {
      await finish({
        ...accepted,
        status: "ready",
        error: undefined,
        citedIds: citedEvidenceIds(accepted),
        unknownIds: [],
        inputTokens,
        outputTokens,
      });
    } else {
      const error = lastProblems.length
        ? `Rejected: ${lastProblems.join("; ")}`
        : `No postmortem submitted after ${stepsUsed} model steps`;
      await finish({ status: "failed", error: error.slice(0, 1000), inputTokens, outputTokens });
    }
  } catch (err) {
    console.error("[triage] postmortem failed", incidentId, err);
    await finish({ status: "failed", error: errorText(err), inputTokens, outputTokens }).catch((saveErr) =>
      console.error("[triage] saving the failed postmortem failed", incidentId, saveErr),
    );
  }
}
