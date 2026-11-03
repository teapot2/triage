import type { StatusTone } from "@/components/ui/badge";
import type { Claim, Evidence, Fanout, Hypothesis, Incident } from "./schema";

// How much a hypothesis deserves to be trusted, in words, worked out from the
// incident's record and never from the model's say-so: what kinds of
// evidence its causal chain cites, whether a later step (a mitigation that
// recovered the metric, a regression test that failed before the fix and
// passes with it) bore it out, and whether everything else was ruled out.
// The model's numeric confidence stays beside it; this is the part Triage
// can't grade itself on. Pure, so the page, the prompts and the exports
// share it, and old records get it for free.

export type ConfidenceGrade = "contradicted" | "speculation" | "pattern_match" | "supported" | "validated" | "validated_exclusive";

export const gradeLabels: Record<ConfidenceGrade, string> = {
  contradicted: "Contradicted",
  speculation: "Speculation",
  pattern_match: "Pattern match",
  supported: "Supported by evidence",
  validated: "Validated",
  validated_exclusive: "Validated, alternatives ruled out",
};

export const gradeTone: Record<ConfidenceGrade, StatusTone> = {
  contradicted: "muted",
  speculation: "muted",
  pattern_match: "warning",
  supported: "info",
  validated: "success",
  validated_exclusive: "success",
};

type Lane = Fanout["hypotheses"][number];

// What happened at runtime (a log line, a trace, a query against the
// database, a metric), against what the code or its history says could
// happen (the source, a deploy or config change).
const runtimeKinds = new Set<Evidence["kind"]>(["log", "span", "db", "metric"]);
const codeKinds = new Set<Evidence["kind"]>(["source", "commit"]);
// The dependency audit's advisory (dependencies/exposure.ts) counts as
// runtime: the package manager read the installed tree, so it shows the
// vulnerable version is what the service runs, not only what it could.
const fromAudit = (e: Evidence) => e.kind === "web" && e.tool === "dependency_audit";
const observed = (e: Evidence) => runtimeKinds.has(e.kind) || fromAudit(e);
const noun = (e: Evidence) => (fromAudit(e) ? "the dependency audit" : kindNouns[e.kind]);

// How each kind reads in a reason: "cited by a trace and the source".
const kindNouns: Record<Evidence["kind"], string> = {
  log: "a log",
  span: "a trace",
  db: "a database check",
  metric: "a metric",
  source: "the source",
  commit: "a change",
  web: "a web page",
  incident: "an earlier incident",
};

// "a", "a and b", "a, b and c".
const inWords = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

function evidenceById(incident: Incident): Map<string, Evidence> {
  const all = [...incident.evidence, ...(incident.questions ?? []).flatMap((q) => q.evidence)];
  return new Map(all.map((e) => [e.id, e]));
}

// The evidence a claim cites that the record has. A cited ID with nothing
// behind it counts for nothing.
const citedBy = (claims: Claim[], byId: Map<string, Evidence>): Evidence[] =>
  claims.flatMap((c) => c.evidenceIds.flatMap((id) => byId.get(id) ?? []));

// The fan-out lane that checked this hypothesis: the same ID, else the same
// title. The lead often renames hypotheses when it merges, so a lane may
// have no match in the report.
export function laneOf(hypothesis: Pick<Hypothesis, "id" | "title">, incident: Incident): Lane | undefined {
  const lanes = incident.run?.fanout?.hypotheses ?? [];
  const title = hypothesis.title.trim().toLowerCase();
  return lanes.find((l) => l.id === hypothesis.id) ?? lanes.find((l) => l.title.trim().toLowerCase() === title);
}

// The verdict's hypothesis, when the verdict named a root cause.
export function verdictHypothesis(incident: Incident): Hypothesis | undefined {
  const verdict = incident.report?.verdict;
  if (verdict?.kind !== "root_cause") return undefined;
  return incident.report?.hypotheses.find((h) => h.id === verdict.hypothesisId);
}

// Whether the sandbox proved the fix: its regression test failed on the
// original code and passes on the patched code. A fix stage that recorded
// itself proves the fix only once it says so; the bundled examples carry
// the sandbox runs without a fix stage.
export function regressionProven(incident: Incident): boolean {
  const { fix, fixRun, validation } = incident;
  if (!fix || (fixRun && fixRun.status !== "proven")) return false;
  const name = fix.regressionTest.name;
  // The run's named test, else its exit code when the test is named
  // differently in the runner's output.
  const outcome = (ref: "original" | "patched") => {
    const run = validation?.find((r) => r.ref === ref && r.tests.length > 0);
    if (!run) return undefined;
    const test = run.tests.find((t) => t.name === name);
    return test ? test.status === "passed" : run.exitCode === 0;
  };
  return outcome("original") === false && outcome("patched") === true;
}

// Whether an applied mitigation brought the alert's metric back.
export const mitigationRecovered = (incident: Incident) =>
  incident.mitigation?.state === "applied" && incident.mitigation.recovery?.status === "recovered";

// `fits` is a pattern match's reason in a few words, for when proof that
// came after (a recovery, a proven fix) supplies the runtime signal it lacked.
type Graded = { grade: ConfidenceGrade; reason: string; fits?: string };

// The grade on the evidence alone, before anything after the diagnosis
// (a recovery, a proven fix) or the other hypotheses count.
function evidenceGrade(hypothesis: Hypothesis, incident: Incident, byId: Map<string, Evidence>): Graded {
  const { symptom, propagation, rootCause } = hypothesis.causalChain;
  // The alert's own series shows there is a problem, not what caused it.
  const counts = (e: Evidence) => !(e.kind === "metric" && e.metric === incident.trigger.metric);
  const chain = citedBy([symptom, propagation, rootCause], byId).filter(counts);
  const cause = citedBy([propagation, rootCause], byId).filter(counts);
  const runtime = cause.filter(observed);
  const code = chain.filter((e) => codeKinds.has(e.kind));
  const lane = laneOf(hypothesis, incident);

  if (chain.length === 0) {
    return {
      grade: "speculation",
      reason: citedBy([symptom, propagation, rootCause], byId).length
        ? "cites nothing beyond the alert's own metric"
        : "cites no evidence the record has",
    };
  }
  // The code says it could happen; nothing shows it did.
  if (runtime.length === 0 && citedBy([rootCause], byId).some((e) => codeKinds.has(e.kind))) {
    const nouns = [...new Set(code.map((e) => e.kind))].map((k) => kindNouns[k]);
    return {
      grade: "pattern_match",
      reason: "the source or change history fits it, but no runtime signal shows it happening",
      fits: `${inWords(nouns)} ${nouns.length > 1 ? "fit" : "fits"} it`,
    };
  }
  // An uptime check sees only its own results: no source or history to cite.
  const external = incident.uptime !== undefined && code.length === 0;
  const kinds = [...new Set([...runtime, ...code].map(noun))];
  if (runtime.length > 0 && (code.length > 0 || external)) {
    return {
      grade: "supported",
      reason: external ? `cited by ${inWords(kinds)} from the uptime check` : `cited by ${inWords(kinds)}`,
    };
  }
  if (lane?.finding === "supported") return { grade: "supported", reason: "its fan-out lane found it supported" };
  // Signals that fit, without the mechanism behind them.
  if (runtime.length > 0) {
    return {
      grade: "pattern_match",
      reason: "runtime signals fit it, but no source or change is cited to explain it",
      fits: "runtime signals fit it",
    };
  }
  return { grade: "speculation", reason: "only the symptom is cited; nothing backs the cause" };
}

function grade(hypothesis: Hypothesis, incident: Incident, byId: Map<string, Evidence>, others: boolean): Graded {
  // The report ruled it out: contradicted, whatever its chain cites, so a
  // row under "Ruled out" never reads as supported. The reason says whether
  // the rejection rests on evidence the record has.
  if (hypothesis.status === "rejected") {
    const cited = hypothesis.rejectedBecause && citedBy([hypothesis.rejectedBecause], byId).length > 0;
    return {
      grade: "contradicted",
      reason: cited ? "ruled out on the evidence it cites" : "ruled out by the report; its reason cites no evidence",
    };
  }
  if (laneOf(hypothesis, incident)?.finding === "refuted") {
    return { grade: "contradicted", reason: "its fan-out lane refuted it" };
  }
  const base = evidenceGrade(hypothesis, incident, byId);
  // Only the verdict's own hypothesis can be borne out by what came after:
  // the mitigation and the fix acted on it, not on the others. A pattern
  // match can be too: a recovered metric or a test that failed and then
  // passed is the runtime signal it was missing.
  const provable = base.grade === "supported" || base.grade === "pattern_match";
  if (!provable || verdictHypothesis(incident)?.id !== hypothesis.id) return base;
  const proof = [
    ...(mitigationRecovered(incident) ? ["the mitigation recovered the metric"] : []),
    ...(regressionProven(incident) ? ["the regression test failed before the fix and passes with it"] : []),
  ];
  if (proof.length === 0) return base;
  const reason = `${base.fits ?? base.reason}; ${inWords(proof)}`;
  if (!others) return { grade: "validated", reason };
  const rest = (incident.report?.hypotheses ?? []).filter((h) => h.id !== hypothesis.id);
  // "Alternatives ruled out" needs alternatives: a report with only the one
  // hypothesis ruled nothing out.
  const exclusive = rest.length > 0 && rest.every((h) => grade(h, incident, byId, false).grade === "contradicted");
  return exclusive
    ? { grade: "validated_exclusive", reason: `${reason}; every alternative was ruled out` }
    : { grade: "validated", reason };
}

// The hypothesis' grade and why, in one short sentence for a tooltip.
export function gradeHypothesis(hypothesis: Hypothesis, incident: Incident): { grade: ConfidenceGrade; reason: string } {
  const { grade: g, reason } = grade(hypothesis, incident, evidenceById(incident), true);
  return { grade: g, reason: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.` };
}
