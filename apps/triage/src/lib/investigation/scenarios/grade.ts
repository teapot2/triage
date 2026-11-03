import type { Evidence, InvestigationReport, Mitigation } from "../schema";
import type { Expected } from "./scenario-source";

export interface Grade {
  hit: boolean;
  // Why it missed, one line per failed check; what matched when it hit.
  reasons: string[];
}

type SourceEvidence = Extract<Evidence, { kind: "source" }>;

const basename = (file: string) => file.split("/").at(-1)!;

// Scores one run against its scenario's ground truth. A root cause hits when
// the leading hypothesis names (or cites) a root-cause file, makes every
// point in `mustMention`, and the proposed mitigation matches; no root cause
// hits on any verdict but root_cause; no defect (the alert is real but
// nothing is broken, a traffic rush say) hits on any verdict whose words
// make every point in `mustMention`, as long as no mitigation is proposed
// and the root cause blames no source file: what's graded there is not
// blaming the change in the window. Pass the run's evidence so a cited
// source file counts even when the text doesn't name it.
export function grade(
  report: InvestigationReport,
  mitigation: Mitigation | undefined,
  expected: Expected,
  evidence: Evidence[] = [],
): Grade {
  const { verdict } = report;
  if (expected.verdict === "no_root_cause") {
    return verdict.kind === "root_cause"
      ? { hit: false, reasons: [`expected no root cause, got root_cause (${verdict.hypothesisId})`] }
      : { hit: true, reasons: [`verdict ${verdict.kind}`] };
  }
  const leading = verdict.kind === "root_cause" ? report.hypotheses.find((h) => h.id === verdict.hypothesisId) : undefined;
  if (expected.verdict === "root_cause") {
    if (verdict.kind !== "root_cause") return { hit: false, reasons: [`expected root_cause, got ${verdict.kind}`] };
    if (!leading) return { hit: false, reasons: [`verdict cites unknown hypothesis ${verdict.hypothesisId}`] };
  }

  // The words the run answers with: the summary, then the leading
  // hypothesis (its title and chain), a healthy verdict's rationale, or
  // what an inconclusive one says is missing.
  const claims = leading ? [leading.causalChain.symptom, leading.causalChain.propagation, leading.causalChain.rootCause] : [];
  const texts = [report.summary ?? "", leading?.title ?? "", ...claims.map((c) => c.text)];
  if (verdict.kind === "healthy") texts.push(verdict.rationale.text);
  if (verdict.kind === "inconclusive") texts.push(...verdict.missing);
  const text = texts.join("\n").toLowerCase();
  const cited = new Set(claims.flatMap((c) => c.evidenceIds));
  const citedFiles = evidence.flatMap((e) => (e.kind === "source" && cited.has(e.id) ? [e.file] : []));

  const misses: string[] = [];
  const matched: string[] = [];
  if (expected.verdict === "no_defect") {
    // Nothing is broken, so a root cause that pins the slowdown on a source
    // file has found a defect that isn't there. Only the root-cause claim
    // (with the title and summary) can blame one: a file the symptom or
    // propagation cites is there to show what slowed, a static page's
    // source say, which clears it rather than blames it.
    const rootIds = new Set(leading?.causalChain.rootCause.evidenceIds ?? []);
    const rootText = [report.summary ?? "", leading?.title ?? "", leading?.causalChain.rootCause.text ?? ""].join("\n").toLowerCase();
    const blamed =
      evidence.find((e): e is SourceEvidence => e.kind === "source" && rootIds.has(e.id))?.file ??
      rootText.match(/src\/[\w./()[\]-]+\.tsx?/)?.[0];
    if (verdict.kind === "root_cause" && blamed) misses.push(`blames ${blamed}, expected no file`);
    else matched.push(`verdict ${verdict.kind}`);
  }

  if (expected.rootCauseFiles.length) {
    const file = expected.rootCauseFiles.find(
      (f) => text.includes(f.toLowerCase()) || text.includes(basename(f).toLowerCase()) || citedFiles.includes(f),
    );
    if (file) matched.push(`names ${file}`);
    else misses.push(`doesn't name or cite ${expected.rootCauseFiles.join(" or ")}`);
  }

  for (const words of expected.mustMention) {
    const word = words.find((w) => text.includes(w.toLowerCase()));
    if (word) matched.push(`mentions "${word}"`);
    else misses.push(`mentions none of ${words.map((w) => `"${w}"`).join(", ")}`);
  }

  const want = expected.mitigation;
  if (want === "none") {
    if (mitigation) misses.push(`mitigation ${mitigation.kind} ${mitigation.target} proposed, expected none`);
    else matched.push("no mitigation proposed");
  } else if (want) {
    if (!mitigation) misses.push(`no mitigation proposed, expected ${want.kind} ${want.target}`);
    else if (mitigation.kind !== want.kind || mitigation.target !== want.target) {
      misses.push(`mitigation ${mitigation.kind} ${mitigation.target}, expected ${want.kind} ${want.target}`);
    } else matched.push(`mitigation ${want.kind} ${want.target}`);
  }

  if (expected.exposure) {
    const got = report.exposure?.verdict;
    if (got === expected.exposure) matched.push(`exposure ${got}`);
    else misses.push(`exposure ${got ?? "missing"}, expected ${expected.exposure}`);
  }

  return misses.length ? { hit: false, reasons: misses } : { hit: true, reasons: matched };
}
