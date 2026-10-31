import type { Evidence, InvestigationReport, Mitigation } from "../schema";
import type { Expected } from "./scenario-source";

export interface Grade {
  hit: boolean;
  // Why it missed, one line per failed check; what matched when it hit.
  reasons: string[];
}

const basename = (file: string) => file.split("/").at(-1)!;

// Scores one run against its scenario's ground truth. A root cause hits when
// the leading hypothesis names (or cites) a root-cause file, makes every
// point in `mustMention`, and the proposed mitigation matches; no root cause
// hits on any verdict but root_cause. Pass the run's evidence so a cited
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
  if (verdict.kind !== "root_cause") return { hit: false, reasons: [`expected root_cause, got ${verdict.kind}`] };
  const leading = report.hypotheses.find((h) => h.id === verdict.hypothesisId);
  if (!leading) return { hit: false, reasons: [`verdict cites unknown hypothesis ${verdict.hypothesisId}`] };

  const { symptom, propagation, rootCause } = leading.causalChain;
  const claims = [symptom, propagation, rootCause];
  const text = [report.summary ?? "", leading.title, ...claims.map((c) => c.text)].join("\n").toLowerCase();
  const cited = new Set(claims.flatMap((c) => c.evidenceIds));
  const citedFiles = evidence.flatMap((e) => (e.kind === "source" && cited.has(e.id) ? [e.file] : []));

  const misses: string[] = [];
  const matched: string[] = [];

  const file = expected.rootCauseFiles.find(
    (f) => text.includes(f.toLowerCase()) || text.includes(basename(f).toLowerCase()) || citedFiles.includes(f),
  );
  if (file) matched.push(`names ${file}`);
  else misses.push(`doesn't name or cite ${expected.rootCauseFiles.join(" or ")}`);

  for (const words of expected.mustMention) {
    const word = words.find((w) => text.includes(w.toLowerCase()));
    if (word) matched.push(`mentions "${word}"`);
    else misses.push(`mentions none of ${words.map((w) => `"${w}"`).join(", ")}`);
  }

  const want = expected.mitigation;
  if (want) {
    if (!mitigation) misses.push(`no mitigation proposed, expected ${want.kind} ${want.target}`);
    else if (mitigation.kind !== want.kind || mitigation.target !== want.target) {
      misses.push(`mitigation ${mitigation.kind} ${mitigation.target}, expected ${want.kind} ${want.target}`);
    } else matched.push(`mitigation ${want.kind} ${want.target}`);
  }

  return misses.length ? { hit: false, reasons: misses } : { hit: true, reasons: matched };
}
