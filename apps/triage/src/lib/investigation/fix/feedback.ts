import { parsePatch } from "../../diff";

// A fix a reviewer denied, with what they asked for instead. On a rerun the
// model gets every one, oldest first, and may not submit one again.
export type DeniedFix = { reason: string; patch: string };

// What the model is told about the denied fixes: the feedback to follow and
// the patch not to repeat, one block per attempt, oldest first. Empty with
// nothing denied.
export function feedbackBlock(feedback: DeniedFix[]): string {
  if (feedback.length === 0) return "";
  return feedback
    .map((f, i) => {
      const which = i === feedback.length - 1 ? "the previous fix" : `an earlier fix (attempt ${i + 1})`;
      return `A reviewer denied ${which} with this feedback: '${f.reason}'.
Its patch:
${f.patch}
Follow the feedback. A patch identical to a denied one is rejected.`;
    })
    .join("\n\n");
}

// The code a patch changes, without its regression test: the same edits
// with a different test are still the fix the reviewer denied.
const codeChanges = (patch: string) =>
  JSON.stringify(
    parsePatch(patch)
      .filter((f) => !/\.test\.ts$/.test(f.path))
      .map((f) => [f.path, f.hunks.map((h) => h.lines.map((l) => `${l.kind}:${l.text}`))]),
  );

// The 1-based attempt whose patch this one repeats, byte for byte or in the
// code it changes; 0 when it repeats none.
export function repeatsDenied(patch: string, feedback: DeniedFix[]): number {
  const code = codeChanges(patch);
  const i = feedback.findIndex((f) => f.patch === patch || codeChanges(f.patch) === code);
  return i + 1;
}
