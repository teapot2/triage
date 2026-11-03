import { type LanguageModel, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { errorMessage } from "../../errors";
import { cacheKey, callSettings, modelOptions, reasoningKind } from "../../models/client";
import { onEachCall, type TokenCounts } from "../../models/usage";
import { recordRunContext, recordThoughts } from "../agent";
import { runAgentLoop } from "../agent-loop";
import type { Stage } from "../fanout/run";
import type { EvidenceDraft, InvestigationRecorder } from "../recorder";
import {
  type Claim,
  claimSchema,
  type DependencyAdvisory,
  type Evidence,
  type Exposure,
  exposureVerdicts,
  findUnknownEvidenceIds,
  type Hypothesis,
  type InvestigationReport,
  reportProblems,
  reportSummarySchema,
  type ToolName,
} from "../schema";
import type { TelemetrySource } from "../source";
import { createInvestigationTools, forModel } from "../tools";

// The exposure stage: what a dependency incident runs in place of the
// telemetry investigation. An advisory is in the code, not in the traffic,
// so there is nothing to read in the logs; the question is whether the
// service's code reaches the vulnerable package. A short loop of the
// investigate stage's model greps and reads the service's source and gives
// a verdict (reachable, transitive_only, not_reachable) citing the files
// that import it. The report around it is built here, not by the model:
// the vulnerable version is the root cause whatever the exposure, and the
// three exposures are the hypotheses, the model's one leading and the other
// two ruled out by its rationale. That keeps the report valid every time
// and opens the fix gate (agent.ts) for the bump.

const MAX_STEPS = 14;
// Steps left when only submit_exposure stays available.
const SUBMIT_RESERVE = 2;
const MAX_NUDGES = 2;
const NUDGE = "You have not submitted an accepted exposure verdict yet. Keep checking if needed, then call submit_exposure.";

// What grep_source returns at most: matches with evidence IDs, then lines
// listed without them.
export const GREP_EVIDENCE = 15;
export const GREP_LINES = 40;
const LINE_CHARS = 200;

// The reason a dependency incident gets no mitigation, on noMitigation.
export const NO_DEPENDENCY_MITIGATION = "A vulnerable dependency has no flag or deploy to undo; the fix is the bump.";

const instructions = `You are Triage, checking whether a vulnerable dependency is exposed in a service's code.

The package manager's audit found the advisory below in the service's dependency tree. The vulnerable version is the root cause whatever you find. Your job is exposure: does the service's own code reach the vulnerable package?

Verdicts:
- reachable: the service's code imports the package, or calls a direct dependency on the vulnerable package's chain in a way that uses the vulnerable part (judge from the advisory's title and CWE).
- transitive_only: the package is in the tree, but nothing you found leads from the service's code to it (the direct dependency that pulls it in is never used, or not that way).
- not_reachable: the only code that would use it never runs in production (scripts, tests, build or tooling config).

Method:
1. grep_source for the package name: imports, requires, and package.json.
2. grep_source for each direct dependency at the head of the chains, to find where the service uses them.
3. read_source the files that import them, to see whether the vulnerable part is on a path the service runs in production.
4. Call submit_exposure.

Rules:
- The rationale cites evidence IDs exactly as tools returned them. A reachable verdict cites the importing lines (source evidence). Never invent an ID.
- The summary is for a human skimming the alert: plain English, under 40 words, no tool names or evidence IDs. Say which package is vulnerable, the advisory in a few words, and whether the service's code reaches it.
- If submit_exposure is rejected, fix the listed problems and submit again.`;

// "a>b>semver" → "a > b > semver"; the package alone is a direct dependency.
const chain = (path: string) => path.split(">").join(" > ");

function chainsText(a: DependencyAdvisory, max = 3): string {
  const paths = a.paths.length ? a.paths : [a.package];
  const shown = paths.slice(0, max).map((p) => (p === a.package ? `${p} (a direct dependency)` : chain(p)));
  return `${shown.join("; ")}${paths.length > max ? `; and ${paths.length - max} more` : ""}`;
}

const found = (a: DependencyAdvisory) => `${a.package}@${a.versions.join(", ")}`;

// The prompt: the advisory, the versions found and the chains to them.
export function exposurePrompt(service: string, a: DependencyAdvisory): string {
  return `Advisory: ${a.advisoryId}: ${a.title}
Severity: ${a.severity}${a.cwe.length ? `\nCWE: ${a.cwe.join(", ")}` : ""}
URL: ${a.url}
Service: ${service}
Package: ${a.package}, versions found ${a.versions.join(", ")}
Vulnerable: ${a.vulnerable}
Patched: ${a.patched ?? "no fixed version is published"}
Dependency type: ${a.dev ? "dev only (every chain starts at a devDependency)" : "runtime"}
Direct dependencies that pull it in: ${a.direct.length ? a.direct.join(", ") : a.package}
Chains from the service's own dependencies:
${(a.paths.length ? a.paths : [a.package]).map((p) => `- ${chain(p)}`).join("\n")}

Check whether ${service}'s code reaches ${a.package}, then submit your exposure verdict.`;
}

// The advisory itself, as the run's first evidence: a page, with its URL
// (the audit's link, or GitHub's for a GHSA id when the audit gave none).
function advisoryUrl(a: DependencyAdvisory): string {
  if (z.url().safeParse(a.url).success) return a.url;
  if (/^GHSA-/.test(a.advisoryId)) return `https://github.com/advisories/${a.advisoryId}`;
  return `https://www.npmjs.com/package/${encodeURIComponent(a.package)}`;
}

export function advisoryEvidence(a: DependencyAdvisory): EvidenceDraft {
  return {
    kind: "web",
    summary: `${a.advisoryId} (${a.severity}) in ${found(a)}: ${a.title}; vulnerable ${a.vulnerable}${a.patched ? `, patched ${a.patched}` : ""}`,
    url: advisoryUrl(a),
    title: `${a.advisoryId}: ${a.title}`,
    observedAt: a.lastFoundAt,
  };
}

// Recorded as a step of its own, so the timeline starts where the incident
// did: the audit that found the advisory.
function recordAdvisory(recorder: InvestigationRecorder, a: DependencyAdvisory): Evidence {
  const id = `audit_${crypto.randomUUID().slice(0, 8)}`;
  recorder.startStep(id, "dependency_audit", { advisoryId: a.advisoryId, package: a.package });
  const [evidence] = recorder.completeStep(id, "dependency_audit", `The audit found ${a.advisoryId} in ${found(a)}`, [
    advisoryEvidence(a),
  ]);
  recorder.queriedServices.add(recorder.service);
  return evidence;
}

export type GrepMatch = { file: string; line: number; text: string };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every line of the service's readable source matching `pattern` (a plain
// string, or a regular expression with `regex`), case-insensitively, in the
// files under `path` when given. Reads through the source, so it searches
// exactly what read_source can read.
export async function grepSource(
  source: Pick<TelemetrySource, "listSourceFiles" | "readSource">,
  q: { pattern: string; regex?: boolean; path?: string },
): Promise<{ matches: GrepMatch[]; files: number }> {
  let re: RegExp;
  try {
    re = new RegExp(q.regex ? q.pattern : escapeRegex(q.pattern), "i");
  } catch (err) {
    throw new Error(`Invalid regular expression ${q.pattern}: ${errorMessage(err)}`);
  }
  const prefix = q.path?.replace(/\\/g, "/").replace(/^\.?\//, "");
  const files = (await source.listSourceFiles()).filter((f) => !prefix || f.startsWith(prefix));
  const matches: GrepMatch[] = [];
  for (const f of files) {
    const file = await source.readSource(f);
    if (!file) continue;
    file.content.split("\n").forEach((text, i) => {
      if (re.test(text)) matches.push({ file: file.path, line: i + 1, text: text.replace(/\r$/, "") });
    });
  }
  return { matches, files: files.length };
}

const clipLine = (s: string) => (s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s);

// The stage's tools: list_files, grep_source and the investigation's
// read_source, each a recorded step, and submit_exposure.
function exposureTools(source: TelemetrySource, recorder: InvestigationRecorder, a: DependencyAdvisory, advisoryId: string) {
  const service = recorder.service;
  function recorded<I extends Record<string, unknown>, O>(
    name: ToolName,
    run: (input: I) => Promise<{ summary: string; evidence: EvidenceDraft[]; extra?: O }>,
  ) {
    return async (input: I, { toolCallId }: { toolCallId: string }) => {
      recorder.startStep(toolCallId, name, input);
      try {
        const result = await run(input);
        recorder.queriedServices.add(service);
        const evidence = recorder.completeStep(toolCallId, name, result.summary, result.evidence);
        return { summary: result.summary, evidence: evidence.map(forModel), ...result.extra };
      } catch (err) {
        recorder.failStep(toolCallId, errorMessage(err));
        throw err;
      }
    };
  }

  return {
    list_files: tool({
      description: "List the service's readable source files (paths relative to the app root), optionally only those under a directory.",
      inputSchema: z.object({ path: z.string().max(200).optional().describe('A directory prefix, e.g. "src/lib"') }),
      execute: recorded("list_files", async ({ path }: { path?: string }) => {
        const prefix = path?.replace(/\\/g, "/").replace(/^\.?\//, "");
        const files = (await source.listSourceFiles()).filter((f) => !prefix || f.startsWith(prefix));
        return { summary: `${files.length} files${prefix ? ` under ${prefix}` : ""}`, evidence: [], extra: { files } };
      }),
    }),

    grep_source: tool({
      description: `Search the service's source (and package.json) for a string, or a regular expression with regex: true, case-insensitively. Each of the first ${GREP_EVIDENCE} matching lines comes back as source evidence with an ID to cite; up to ${GREP_LINES} are listed.`,
      inputSchema: z.object({
        pattern: z.string().min(1).max(200).describe(`e.g. "${a.package}" or "from ['\\"]${a.package}"`),
        regex: z.boolean().optional().describe("Treat pattern as a regular expression"),
        path: z.string().max(200).optional().describe('Only files under this directory, e.g. "src"'),
      }),
      execute: recorded("grep_source", async (q: { pattern: string; regex?: boolean; path?: string }) => {
        const { matches, files } = await grepSource(source, q);
        const evidence: EvidenceDraft[] = matches.slice(0, GREP_EVIDENCE).map((m) => ({
          kind: "source",
          summary: `${m.file}:${m.line} matches "${q.pattern}"`,
          file: m.file,
          startLine: m.line,
          code: m.text,
        }));
        const more = matches.slice(GREP_EVIDENCE, GREP_LINES).map((m) => `${m.file}:${m.line}  ${clipLine(m.text.trim())}`);
        const cut = matches.length > GREP_LINES ? `; ${matches.length - GREP_LINES} more not shown, narrow the pattern or path` : "";
        const summary = matches.length
          ? `${matches.length} matching lines for "${q.pattern}" in ${new Set(matches.map((m) => m.file)).size} of ${files} files${cut}`
          : `No lines match "${q.pattern}" in ${files} files`;
        return { summary, evidence, extra: more.length ? { more } : undefined };
      }),
    }),

    read_source: createInvestigationTools(source, recorder, { submit: false }).read_source,

    submit_exposure: tool({
      description:
        "Submit the exposure verdict. It is checked: the rationale must cite evidence IDs the tools returned, and a reachable verdict must cite the importing lines (source evidence). If it is rejected, fix the listed problems and submit again.",
      inputSchema: z.object({
        verdict: z.enum(exposureVerdicts),
        rationale: claimSchema.describe("Why, in a sentence or two, citing the importing files' lines (or the advisory, when nothing imports it)"),
        summary: reportSummarySchema,
      }),
      execute: async ({ verdict, rationale, summary }) => {
        const exposure: Exposure = { verdict, rationale };
        const report = exposureReport(a, exposure, summary, advisoryId, [...recorder.queriedServices].sort());
        const problems = [...exposureProblems(exposure, recorder.evidence), ...reportProblems(report)];
        const unknown = findUnknownEvidenceIds(report, recorder.evidence);
        if (unknown.length) problems.push(`unknown evidence IDs cited: ${unknown.join(", ")}`);
        if (problems.length) {
          recorder.rejectedReports += 1;
          return { accepted: false, problems: [...new Set(problems)] };
        }
        recorder.update({ report });
        return { accepted: true };
      },
    }),
  };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// What the report's own checks can't see in the exposure.
export function exposureProblems(exposure: Exposure, evidence: Evidence[]): string[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const problems: string[] = [];
  const unknown = exposure.rationale.evidenceIds.filter((id) => !byId.has(id));
  if (unknown.length) problems.push(`unknown evidence IDs cited: ${unknown.join(", ")}`);
  if (words(exposure.rationale.text) < 4) problems.push("the rationale needs a sentence saying what the cited evidence shows");
  if (exposure.verdict === "reachable" && !exposure.rationale.evidenceIds.some((id) => byId.get(id)?.kind === "source")) {
    problems.push("a reachable verdict must cite the lines that import or call the package (source evidence from grep_source or read_source)");
  }
  return problems;
}

// Each exposure as a hypothesis about the advisory: its title and, for the
// ones not chosen, what it would have meant.
const exposureTitles: Record<Exposure["verdict"], (a: DependencyAdvisory) => string> = {
  reachable: (a) => `Vulnerable ${found(a)}, reachable from the service's code`,
  transitive_only: (a) => `Vulnerable ${found(a)}, in the tree but not reached by the service's code`,
  not_reachable: (a) => `Vulnerable ${found(a)}, only in code that never runs in production`,
};

const exposureClaims: Record<Exposure["verdict"], (a: DependencyAdvisory) => string> = {
  reachable: (a) =>
    `The service's code calls ${a.package}${a.direct.some((d) => d !== a.package) ? `, directly or through ${a.direct.join(", ")}` : " directly"}`,
  transitive_only: (a) => `${a.package} sits under ${a.direct.join(", ") || "another package"} with no call path from the service's code`,
  not_reachable: (a) => `Only scripts, tests or build tooling would use ${a.package}, none of which runs in production`,
};

const confidences: Record<Exposure["verdict"], number> = { reachable: 0.9, transitive_only: 0.8, not_reachable: 0.8 };

// The report a dependency incident's run saves: a root_cause verdict on the
// vulnerable version, with the exposure. Pure, so the tests can check it
// validates for every verdict.
export function exposureReport(
  a: DependencyAdvisory,
  exposure: Exposure,
  summary: string,
  advisoryId: string,
  servicesQueried: string[],
): InvestigationReport {
  const advisory = (text: string): Claim => ({ text, evidenceIds: [advisoryId] });
  const symptom = advisory(`The audit found ${a.advisoryId} (${a.severity}) in ${found(a)}, through ${chainsText(a)}`);
  const rootCause = advisory(
    `${found(a)} is inside the vulnerable range ${a.vulnerable}${a.patched ? `; ${a.patched} fixes it` : "; no fixed version is published"}`,
  );
  const leading = confidences[exposure.verdict];
  const others = exposureVerdicts.filter((v) => v !== exposure.verdict);
  const hypotheses: Hypothesis[] = [
    {
      id: "A",
      title: exposureTitles[exposure.verdict](a),
      confidence: leading,
      status: "leading",
      causalChain: { symptom, propagation: exposure.rationale, rootCause },
    },
    ...others.map(
      (v, i): Hypothesis => ({
        id: String.fromCharCode(66 + i),
        title: exposureTitles[v](a),
        confidence: Math.round(((1 - leading) / others.length) * 100) / 100,
        status: "rejected",
        causalChain: { symptom, propagation: advisory(exposureClaims[v](a)), rootCause },
        rejectedBecause: { text: `The exposure check found otherwise: ${exposure.rationale.text}`, evidenceIds: exposure.rationale.evidenceIds },
      }),
    ),
  ];
  return { summary, hypotheses, verdict: { kind: "root_cause", hypothesisId: "A" }, servicesQueried, exposure };
}

// Runs the stage on the incident `recorder` holds, until an exposure is
// accepted or the steps run out. The caller (runInvestigation) owns the
// run's record: the model, budget, tokens, steps and status.
export async function runExposureStage(o: {
  recorder: InvestigationRecorder;
  source: TelemetrySource;
  stage: Stage;
  model: LanguageModel;
  abortSignal: AbortSignal;
  tokens: TokenCounts;
  count: { steps: number };
}): Promise<void> {
  const { recorder } = o;
  const a = recorder.incident.dependency;
  if (!a) throw new Error("This dependency incident has no advisory recorded to check.");
  const advisory = recordAdvisory(recorder, a);
  const agent = new ToolLoopAgent({
    model: o.model,
    providerOptions: modelOptions(o.stage, cacheKey("investigate", recorder.incident.id)),
    ...callSettings(),
    ...recordThoughts(recorder, reasoningKind(o.stage.provider)),
    ...onEachCall((call) => recordRunContext(recorder, call)),
    instructions,
    tools: exposureTools(o.source, recorder, a, advisory.id),
    stopWhen: [() => o.count.steps >= MAX_STEPS, () => recorder.report !== undefined],
    prepareStep: () => {
      o.count.steps += 1;
      return o.count.steps > MAX_STEPS - SUBMIT_RESERVE && !recorder.report ? { activeTools: ["submit_exposure" as const] } : {};
    },
  });
  await runAgentLoop({
    agent,
    messages: [{ role: "user", content: exposurePrompt(recorder.service, a) }],
    abortSignal: o.abortSignal,
    steps: () => o.count.steps,
    maxSteps: MAX_STEPS,
    maxNudges: MAX_NUDGES,
    nudge: NUDGE,
    done: () => recorder.report !== undefined,
    tokens: o.tokens,
  });
}
