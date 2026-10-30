import type { Claim, Hypothesis, InvestigationReport } from "./schema";

// The hypotheses that didn't win, in the order AlsoConsidered shows them:
// the ones still possible first, then the ruled-out ones, each by
// confidence. citationOrder follows it, so footnotes number down the page.
export function otherHypotheses(report: InvestigationReport): Hypothesis[] {
  const { verdict } = report;
  const ruledOut = (h: Hypothesis) => Number(h.status === "rejected");
  return report.hypotheses
    .filter((h) => verdict.kind !== "root_cause" || h.id !== verdict.hypothesisId)
    .sort((a, b) => ruledOut(a) - ruledOut(b) || b.confidence - a.confidence);
}

// Evidence IDs in the order the panel shows them, so citations number like
// footnotes: 1, 2, 3 down the page.
export function citationOrder(report: InvestigationReport): string[] {
  const { verdict } = report;
  const claims: Claim[] = [];
  if (verdict.kind === "root_cause") {
    const h = report.hypotheses.find((x) => x.id === verdict.hypothesisId);
    if (h) claims.push(h.causalChain.symptom, h.causalChain.propagation, h.causalChain.rootCause);
  }
  if (verdict.kind === "healthy") claims.push(verdict.rationale);
  for (const h of otherHypotheses(report)) claims.push(h.rejectedBecause ?? h.causalChain.rootCause);
  return [...new Set(claims.flatMap((c) => c.evidenceIds))];
}
