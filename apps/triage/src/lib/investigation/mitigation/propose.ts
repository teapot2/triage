import type { Evidence, InvestigationReport, Mitigation } from "../schema";

type Commit = Extract<Evidence, { kind: "commit" }>;

const flagCheck = /isEnabled\(\s*["'`](FF_[A-Z0-9_]+)["'`]\s*\)/;

const isDeploy = (e: Evidence): e is Commit => e.kind === "commit" && e.tool === "deploy_history";
const isConfig = (e: Commit) => e.sha.startsWith("config:");
// A deploy that can be rolled back: a code deploy, not a flag flip and not a
// rollback (its sha is the commit it already undid).
const isRollbackable = (e: Commit) => !isConfig(e) && e.deployKind !== "rollback";
// Connections still checked out: turning the flag off stops new leaks but
// frees none of these, so the flag-off also recycles them. Only a pool
// metric well above its baseline shows connections being held; database
// diagnostics, or a pool metric at its usual level, cite the database
// without saying the pool is full.
const isPoolEvidence = (e: Evidence) =>
  e.kind === "metric" &&
  e.metric.startsWith("db.client.connection") &&
  e.observed >= 2 * e.baseline &&
  e.observed >= 5;

const recycleStep = "Recycle pooled connections held longer than 5 s (what a restart would do)";

type Candidate = { kind: Mitigation["kind"]; target: string; from: Evidence; turnedOn?: boolean; branch?: string };
// The flags' states now, as the source read them from the logs (`flags:
// loaded` at boot plus the flips since); a flag missing from it is unknown.
type FlagStates = Record<string, boolean>;

const flagOf = (e: Commit) => e.sha.slice("config:".length);

// The leading hypothesis' causal chain, as the evidence items it cites (the
// set the alert chart's deploy markers come from). A deploy counts when the
// chain cites it or a commit with its sha; cited ones come first.
function cited(report: InvestigationReport, evidence: Evidence[]): { items: Evidence[]; deploys: Commit[] } {
  const { verdict } = report;
  if (verdict.kind !== "root_cause") return { items: [], deploys: [] };
  const h = report.hypotheses.find((x) => x.id === verdict.hypothesisId);
  if (!h) return { items: [], deploys: [] };
  const { symptom, propagation, rootCause } = h.causalChain;
  const ids = new Set([symptom, propagation, rootCause].flatMap((c) => c.evidenceIds));
  const items = evidence.filter((e) => ids.has(e.id));
  const shas = new Set(items.flatMap((e) => (e.kind === "commit" ? [e.sha] : [])));
  const bySha = evidence.filter(isDeploy).filter((e) => !ids.has(e.id) && shas.has(e.sha));
  return { items, deploys: [...items.filter(isDeploy), ...bySha] };
}

// First match wins: a flag turned on, then a flag the blamed code checks,
// then a flag turned on after the blamed deploy, then the deploy itself. A
// flag the logs say is off now is skipped at every step: the code behind it
// isn't running, so turning it off would change nothing (the blamed code
// may check a flag that was never on, or one turned off again before the
// alert). Skipping it falls through to the next rule. An unknown flag is
// proposed as before.
function candidate(
  items: Evidence[],
  deploys: Commit[],
  evidence: Evidence[],
  alertAt?: string,
  flags?: FlagStates,
): Candidate | undefined {
  const off = (flag: string) => flags?.[flag] === false;
  const flagOn = deploys.find((e) => isConfig(e) && e.message.includes("turned on") && !off(flagOf(e)));
  if (flagOn) return { kind: "flag_off", target: flagOf(flagOn), from: flagOn, turnedOn: true };
  for (const e of items) {
    const flag = e.kind === "source" ? flagCheck.exec(e.code)?.[1] : undefined;
    if (flag && !off(flag)) return { kind: "flag_off", target: flag, from: e };
  }
  const deploy = deploys.find(isRollbackable);
  if (!deploy) return undefined;
  // Code shipped dark and switched on later: the diagnosis may blame the
  // deploy, but turning the flag back off is the smaller, safer step, so a
  // flag turned on between the blamed deploy and the alert (anywhere in the
  // evidence) wins over the rollback. Not one flipped after the alert, which
  // can't have caused it; of several, the first after the deploy.
  const at = (e: Evidence) => Date.parse(e.observedAt ?? "");
  const until = alertAt ? Date.parse(alertAt) : Infinity;
  const later = evidence
    .filter(isDeploy)
    .filter((e) => isConfig(e) && e.message.includes("turned on") && at(e) >= at(deploy) && at(e) <= until)
    .filter((e) => !off(flagOf(e)))
    .sort((a, b) => at(a) - at(b))[0];
  if (later) return { kind: "flag_off", target: flagOf(later), from: later, turnedOn: true };
  return { kind: "rollback", target: deploy.sha, from: deploy, branch: deploy.branch };
}

const templates = {
  flag_off: (flag: string, service: string) => ({
    title: `Turn off ${flag}`,
    steps: [`Turn off ${flag} on ${service}`],
    undo: `Turn ${flag} back on from Shopfront's ops page`,
    risk: "very_low" as const,
  }),
  rollback: (sha: string, service: string) => ({
    title: `Roll back ${service} to the deploy before ${sha}`,
    steps: [`Roll back ${sha} on ${service}`],
    undo: `Redeploy ${sha}`,
    risk: "low" as const,
  }),
};

function why(c: Candidate, service: string, recycles: boolean): string {
  if (c.kind === "rollback") return `The symptom began after ${c.target} was deployed to ${service}.`;
  const change = c.turnedOn
    ? `The symptom began after ${c.target} was turned on`
    : `The code the diagnosis blames only runs while ${c.target} is on`;
  return recycles ? `${change}; turning it off stops new leaks, and recycling the held connections frees the pool.` : `${change}.`;
}

// Why proposeMitigation proposed nothing, for the page: what the diagnosis
// cites that can't be undone, or that it cites no change at all.
export function whyNoMitigation(report: InvestigationReport, evidence: Evidence[], flags?: FlagStates): string {
  const { items, deploys } = cited(report, evidence);
  const checked = items.flatMap((e) => (e.kind === "source" ? (flagCheck.exec(e.code)?.[1] ?? []) : []));
  const flagsOff = [...new Set([...deploys.filter(isConfig).map(flagOf), ...checked])].filter((f) => flags?.[f] === false);
  const undone = [...new Set(deploys.filter((e) => e.deployKind === "rollback").map((e) => e.sha))];
  const parts = [
    ...(flagsOff.length ? [`${flagsOff.join(" and ")} ${flagsOff.length > 1 ? "are" : "is"} already off`] : []),
    ...(undone.length ? [`${undone.join(" and ")} ${undone.length > 1 ? "were" : "was"} already rolled back`] : []),
  ];
  if (parts.length) return `Nothing to undo: ${parts.join("; ")}.`;
  return "Nothing to undo: the diagnosis cites no flag flip or deploy. If the load itself is the cause, scale out or wait for the rate to settle.";
}

// A fast, reversible step to propose beside a root-cause verdict, chosen by
// rule from the evidence the diagnosis cites. Nothing when no cited change
// can be undone that way. `alertAt`, when given, is the latest a flag can
// have been turned on to count as the cause; `flags`, when given, is what
// the logs say each flag is now, and a flag they say is off is never
// proposed (see candidate).
export function proposeMitigation(
  report: InvestigationReport,
  evidence: Evidence[],
  service: string,
  now = new Date().toISOString(),
  alertAt?: string,
  flags?: FlagStates,
): Mitigation | undefined {
  const { items, deploys } = cited(report, evidence);
  const c = candidate(items, deploys, evidence, alertAt, flags);
  if (!c) return undefined;
  const pool = c.kind === "flag_off" ? items.filter(isPoolEvidence) : [];
  const t = templates[c.kind](c.target, service);
  return {
    kind: c.kind,
    target: c.target,
    ...(c.branch ? { branch: c.branch } : {}),
    ...t,
    steps: pool.length ? [...t.steps, recycleStep] : t.steps,
    why: { text: why(c, service, pool.length > 0), evidenceIds: [c.from.id, ...pool.map((e) => e.id)] },
    state: "proposed",
    proposedAt: now,
  };
}
