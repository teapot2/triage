import type { SandboxRun } from "../schema";
import { isNewMigrationPath, JOURNAL } from "./data-change";
import { planMigration } from "./migration";
import {
  createSandbox,
  readSandboxFile,
  removeSandbox,
  runTests,
  runTypecheck,
  unifiedDiff,
  writeSandboxFile,
} from "./sandbox";

// Stage 4: prove a proposed fix in a sandbox before anyone is asked to
// approve it. The regression test has to fail on the code as it is (so it
// reproduces the bug), then pass with the edits applied, and the patched
// app has to typecheck. Anything else is a problem the model gets back.
// A migration in the fix is copied in but never run: the tests only read
// the database, so the data half of a fix stays unproven (data-change.ts).
// A new one is numbered and added to Drizzle's journal here (migration.ts).

export type Edit = { file: string; find: string; replace: string };
export type RegressionTest = { file: string; name: string; content: string };

export type Proof =
  // edits: as applied, with a new migration renamed to its number; journal:
  // set when Triage registered a new migration in Drizzle's journal.
  | { ok: true; runs: SandboxRun[]; patch: string; files: string[]; edits: Edit[]; journal?: string }
  | { ok: false; runs: SandboxRun[]; problems: string[] };

// The 1-based line each occurrence of `find` starts on.
function matchLines(text: string, find: string): number[] {
  const lines: number[] = [];
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) {
    lines.push(text.slice(0, at).split("\n").length);
  }
  return lines;
}

// A file with its line numbers, for a model to point at its own mistake.
export function numbered(text: string, maxLines = 80): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, maxLines).map((l, i) => `${String(i + 1).padStart(3)}  ${l}`);
  if (lines.length > maxLines) shown.push(`…(${lines.length - maxLines} more lines)`);
  return shown.join("\n");
}

// Exact-match edits: each `find` must appear once in the file as it stands
// after the edits before it. Returns the new contents by file. An ambiguous
// `find` says where it matched, so the model can extend it to a line that
// only one of the places has.
export function applyEdits(
  current: Map<string, string>,
  edits: Edit[],
): { files: Map<string, string>; problems: string[] } {
  const files = new Map(current);
  const problems: string[] = [];
  edits.forEach((e, i) => {
    const text = files.get(e.file);
    // A new migration is the one file an edit may create: an empty `find`
    // and the whole file as `replace`.
    if (text === undefined && e.find === "" && isNewMigrationPath(e.file)) return void files.set(e.file, e.replace);
    if (text === undefined) return problems.push(`edit ${i + 1}: ${e.file} is not a file you read`);
    const at = text.indexOf(e.find);
    if (e.find === "" || at === -1) return problems.push(`edit ${i + 1}: \`find\` text not found in ${e.file}; copy it exactly from the file`);
    const matches = matchLines(text, e.find);
    if (matches.length > 1) {
      return problems.push(
        `edit ${i + 1}: \`find\` text appears ${matches.length} times in ${e.file}, starting on lines ${matches.join(" and ")}. ` +
          "Extend it with a neighbouring line that only the place you mean has (for example its function signature).",
      );
    }
    files.set(e.file, text.slice(0, at) + e.replace + text.slice(at + e.find.length));
  });
  return { files, problems };
}

export async function proveFix(opts: {
  appDir: string;
  name: string;
  edits: Edit[];
  test: RegressionTest;
  onStage?: (stage: "original" | "patched" | "typecheck") => void;
}): Promise<Proof> {
  const { appDir, name, test } = opts;
  const problems: string[] = [];
  if (!/^src\/.+\.test\.ts$/.test(test.file)) problems.push(`test.file must be under src/ and end in .test.ts, got ${test.file}`);

  const dir = await createSandbox(appDir, name);
  try {
    const before = new Map<string, string>();
    for (const file of new Set(opts.edits.map((e) => e.file))) {
      const text = await readSandboxFile(dir, file).catch(() => undefined);
      if (text !== undefined) before.set(file, text);
    }
    const journalText = await readSandboxFile(dir, JOURNAL).catch(() => undefined);
    const plan = planMigration(opts.edits, new Set(before.keys()), journalText, Date.now());
    problems.push(...plan.problems);
    const edits = plan.edits;
    const touched = [...new Set(edits.map((e) => e.file))];
    if (touched.includes(test.file)) problems.push("the edits must not touch the test file; put the test in test.content");
    const exists = await readSandboxFile(dir, test.file).then(
      () => true,
      () => false,
    );
    if (exists) problems.push(`${test.file} already exists; pick a new file name`);
    const applied = applyEdits(before, edits);
    problems.push(...applied.problems);
    if (problems.length) return { ok: false, runs: [], problems };
    if (plan.journal !== undefined) {
      before.set(JOURNAL, journalText!);
      applied.files.set(JOURNAL, plan.journal);
    }

    const runs: SandboxRun[] = [];
    const named = (r: { tests: { name: string; status: string }[] }) => r.tests.find((t) => t.name === test.name);
    const tail = (output: string) => output.split("\n").slice(-25).join("\n");

    // 1. The test against the code as it is: it must fail, on its assertion.
    await writeSandboxFile(dir, test.file, test.content);
    opts.onStage?.("original");
    const { run: original, loadError } = await runTests(dir, test.file, { label: "Original code", ref: "original" });
    runs.push(original);
    // A test that won't load comes back with the file itself, numbered, so
    // the error's line points at something the model can see.
    if (loadError) {
      return {
        ok: false,
        runs,
        problems: [
          `the test file did not run: ${loadError}\n${tail(original.output)}\n\nYour test file (${test.file}):\n${numbered(test.content)}`,
        ],
      };
    }
    if (!named(original)) {
      return { ok: false, runs, problems: [`no test named "${test.name}" ran; test.name must match the test's title exactly`] };
    }
    if (original.exitCode === 0) {
      return {
        ok: false,
        runs,
        problems: ["the test passes on the current code, so it does not reproduce the bug; make it exercise the failing path"],
      };
    }

    // 2. With the edits: it must pass.
    for (const [file, text] of applied.files) await writeSandboxFile(dir, file, text);
    opts.onStage?.("patched");
    const { run: patched } = await runTests(dir, test.file, { label: "Patched code", ref: "patched" });
    runs.push(patched);
    if (patched.exitCode !== 0 || named(patched)?.status !== "passed") {
      return { ok: false, runs, problems: [`the test still fails with the edits applied:\n${tail(patched.output)}`] };
    }

    // 3. The patched app, test included, must typecheck.
    opts.onStage?.("typecheck");
    const types = await runTypecheck(dir, { label: "Patched code: typecheck", ref: "patched" });
    runs.push(types);
    if (types.exitCode !== 0) {
      return { ok: false, runs, problems: [`the patched code does not typecheck:\n${tail(types.output)}`] };
    }

    const patch = await unifiedDiff(name, [
      ...[...applied.files].map(([file, after]) => ({ file, before: before.get(file) ?? null, after })),
      { file: test.file, before: null, after: test.content },
    ]);
    const journal = plan.journal !== undefined ? JOURNAL : undefined;
    return { ok: true, runs, patch, files: [...touched, ...(journal ? [journal] : []), test.file], edits, journal };
  } finally {
    await removeSandbox(dir);
  }
}
