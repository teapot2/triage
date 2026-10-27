import { type ModelMessage, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { languageModel } from "../../models/client";
import { stageModel, stageProblem } from "../../models/settings";
import type { InvestigationRecorder } from "../recorder";
import type { Fix, FixRun, Incident, SandboxRun } from "../schema";
import type { TelemetrySource } from "../source";
import { proveFix } from "./prove";

// Stage 3: after a root-cause verdict, the model writes a fix and a
// regression test for it, and Stage 4 proves them in a sandbox (see
// prove.ts). A failed proof goes back to the model with the reasons, so the
// human is only asked to approve a fix that has already been shown to work.

const MAX_STEPS = 16;
const MAX_SUBMISSIONS = 4;
const MAX_NUDGES = 2;
const NUDGE = "You have not submitted a proven fix yet. Read what you need, then call submit_fix.";

const instructions = `You are Triage, an SRE. You diagnosed a production incident; now fix it and prove the fix.

How a fix is checked, in a sandbox copy of the app (never production):
1. Your regression test is added and run against the current code. It must FAIL there, on an assertion: that proves it reproduces the bug.
2. Your edits are applied and the test runs again. It must PASS.
3. The patched app must typecheck.
If a check fails, submit_fix says why. Fix the problem and submit again.

The fix:
- Fix the root cause in the code with the smallest correct change. Turning a feature flag off is a mitigation, not a fix: the flagged code path itself must be correct.
- Make it hold on every exit path, including thrown errors: whatever the code acquires (connections, handles, locks) is released however it returns, for example with try/finally.
- Read a file with read_source before editing it. Each edit replaces one snippet: \`find\` is copied verbatim from the file (same indentation and line breaks) and appears exactly once. Similar code often repeats, so include a line only your target has, such as its function signature.
- Change nothing beyond the bug.
- The summary becomes the pull request's description: say what changes and why, in a full sentence.

The regression test:
- Vitest and TypeScript: \`import { describe, it, expect, beforeAll, afterAll } from "vitest"\`. Put it at src/<path>.test.ts next to the code it covers, as a new file. Import app code with the @/ alias for src/.
- It runs in its own process against the app's real Postgres, using the app's own database client and settings. Only read data, or remove what the test creates.
- Call the failing code path directly (functions, not HTTP). If that path is behind a feature flag, turn the flag on in the test.
- Observe what the code does through public state (return values, counts a library exposes) rather than monkey-patching internals, and avoid \`any\`.
- Fail fast: assert on the state that breaks (counts, return values) instead of waiting for a timeout, and stay well under 10 seconds. Close or release anything the test opens, even when an assertion fails, or the process hangs.
- Write it as an ordinary, readable file: one statement per line, indented, as a person would.
- test.name is the test's title exactly, saying what must hold (e.g. "returns the default when the row is missing").

Finish by calling submit_fix.`;

function prompt(incident: Incident, sourceFiles: string[]): string {
  const report = incident.report!;
  const verdict = report.verdict;
  const leading = verdict.kind === "root_cause" ? report.hypotheses.find((h) => h.id === verdict.hypothesisId) : undefined;
  const chain = leading?.causalChain;
  return `Incident: ${incident.title}
Diagnosis: ${report.summary ?? ""}
Root cause: ${leading?.title ?? "unknown"}
- Symptom: ${chain?.symptom.text ?? ""}
- Propagation: ${chain?.propagation.text ?? ""}
- Root cause: ${chain?.rootCause.text ?? ""}
Files the investigation read: ${sourceFiles.join(", ") || "none"}

Write the fix and its regression test, then call submit_fix.`;
}

const editSchema = z.object({
  file: z.string().describe("Path relative to the app root, e.g. src/lib/example.ts"),
  find: z.string().describe("Exact snippet to replace, copied verbatim; must appear once"),
  replace: z.string(),
});

const submitSchema = z.object({
  summary: z.string().max(400).describe("What the fix changes and why, in one or two plain sentences"),
  risk: z.enum(["low", "medium", "high"]),
  touchesData: z.boolean().describe("True if the fix changes stored data or the schema"),
  edits: z.array(editSchema).min(1),
  test: z.object({
    file: z.string().describe("New file, src/<path>.test.ts"),
    name: z.string().describe("The test's title, exactly as written in it()"),
    content: z.string().describe("The whole test file"),
  }),
});

type Accepted = { fix: Fix; validation: SandboxRun[] };

// A summary short enough to say nothing ("fix") can't serve as a PR
// description.
const MIN_SUMMARY_WORDS = 8;
// A test on one long line can't be reviewed, or debugged from an error's
// line number.
const MAX_TEST_LINE = 160;

function formatProblems(input: z.infer<typeof submitSchema>): string[] {
  const problems: string[] = [];
  const words = input.summary.trim().split(/\s+/).filter(Boolean).length;
  if (words < MIN_SUMMARY_WORDS) {
    problems.push(
      `summary is ${words} ${words === 1 ? "word" : "words"} ("${input.summary.trim()}"). It becomes the PR description: say what changes and why in a full sentence.`,
    );
  }
  const lines = input.test.content.split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  if (lines.length < 5 || longest > MAX_TEST_LINE) {
    problems.push(
      `test.content is ${lines.length} ${lines.length === 1 ? "line" : "lines"} with the longest at ${longest} characters. Write it as an ordinary file: one statement per line, indented, no line over ${MAX_TEST_LINE} characters.`,
    );
  }
  return problems;
}

// Never throws: the outcome is recorded on the incident. A proven fix moves
// the incident to awaiting_approval.
export async function runFixStage(recorder: InvestigationRecorder, source: TelemetrySource, appDir: string) {
  const startedAt = new Date().toISOString();
  const stage = await stageModel("fix");
  let fixRun: FixRun = { status: "writing", attempt: 0, startedAt, provider: stage.provider, model: stage.model };
  const setFixRun = (patch: Partial<FixRun>) => {
    fixRun = { ...fixRun, ...patch };
    recorder.update({ fixRun });
  };
  setFixRun({});
  const problem = stageProblem(stage);
  if (problem) {
    setFixRun({ status: "failed", finishedAt: new Date().toISOString(), error: problem });
    return;
  }

  let accepted: Accepted | undefined;
  let lastProblems: string[] = [];
  const reject = (problems: string[]) => {
    lastProblems = problems;
    setFixRun({ status: "writing", rejections: [...(fixRun.rejections ?? []), problems[0].split("\n")[0]] });
    return { accepted: false, problems };
  };
  let lastRuns: SandboxRun[] = [];
  const allowed = new Set(await source.listSourceFiles());

  const tools = {
    read_source: tool({
      description: "Read an application source file, whole. Paths are relative to the app root.",
      inputSchema: z.object({ path: z.string().describe("e.g. src/db/client.ts") }),
      execute: async ({ path }) => {
        const file = await source.readSource(path);
        if (!file) throw new Error(`File not found: ${path}. Known files: ${[...allowed].join(", ")}`);
        return { path: file.path, content: file.content };
      },
    }),
    submit_fix: tool({
      description:
        "Submit the fix and its regression test. They are proven in a sandbox: the test must fail on the current code, pass with the edits, and the patched app must typecheck. If it is rejected, fix the listed problems and submit again.",
      inputSchema: submitSchema,
      execute: async (input) => {
        if (fixRun.attempt >= MAX_SUBMISSIONS) {
          return { accepted: false, problems: ["no submissions left"] };
        }
        // Cheap to fix and nothing to do with whether the fix works, so these
        // go back before the sandbox and don't use up a submission.
        const format = formatProblems(input);
        if (format.length) return { accepted: false, problems: format };
        setFixRun({ status: "testing", attempt: fixRun.attempt + 1 });
        const outside = input.edits.map((e) => e.file).filter((f) => !allowed.has(f));
        if (outside.length) {
          return reject([`edits may only touch application files you can read; not: ${[...new Set(outside)].join(", ")}`]);
        }
        const proof = await proveFix({ appDir, name: recorder.incident.id, edits: input.edits, test: input.test });
        lastRuns = proof.runs;
        if (!proof.ok) return reject(proof.problems);
        accepted = {
          fix: {
            summary: input.summary,
            patch: proof.patch,
            files: proof.files,
            regressionTest: { file: input.test.file, name: input.test.name },
            risk: input.risk,
            touchesData: input.touchesData,
          },
          validation: proof.runs,
        };
        return { accepted: true };
      },
    }),
  };

  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const agent = new ToolLoopAgent({
    model: languageModel(stage),
    instructions,
    tools,
    stopWhen: [() => steps >= MAX_STEPS, () => accepted !== undefined || fixRun.attempt >= MAX_SUBMISSIONS],
    prepareStep: () => {
      steps += 1;
      return {};
    },
  });

  try {
    const sourceFiles = [
      ...new Set(recorder.incident.evidence.flatMap((e) => (e.kind === "source" ? [e.file] : []))),
    ];
    const messages: ModelMessage[] = [{ role: "user", content: prompt(recorder.incident, sourceFiles) }];
    for (let attempt = 0; attempt <= MAX_NUDGES && !accepted && steps < MAX_STEPS && fixRun.attempt < MAX_SUBMISSIONS; attempt++) {
      if (attempt > 0) messages.push({ role: "user", content: NUDGE });
      const result = await agent.generate({ messages });
      messages.push(...result.responseMessages);
      inputTokens += result.usage.inputTokens ?? 0;
      outputTokens += result.usage.outputTokens ?? 0;
    }
  } catch (err) {
    console.error("[triage] fix stage failed", recorder.incident.id, err);
    lastProblems = [err instanceof Error ? err.message : String(err)];
  }

  const finished = { finishedAt: new Date().toISOString(), modelSteps: steps, inputTokens, outputTokens };
  if (accepted) {
    fixRun = { ...fixRun, ...finished, status: "proven", error: undefined };
    recorder.update({
      ...accepted,
      fixRun,
      status: "awaiting_approval",
      approval: { state: "pending", requestedAt: new Date().toISOString() },
    });
  } else {
    const why = lastProblems[0]?.split("\n")[0] ?? `no fix submitted in ${steps} model steps`;
    fixRun = { ...fixRun, ...finished, status: "failed", error: why };
    recorder.update({ fixRun, validation: lastRuns.length ? lastRuns : undefined });
  }
}
