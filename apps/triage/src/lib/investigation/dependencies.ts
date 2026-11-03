import path from "node:path";
import { errorMessage } from "../errors";
import { investigationProblem, readDependencySettings, writeDependencySettings } from "../models/settings";
import { notify } from "../notifications/notify";
import { runInvestigation } from "./agent";
import { isArchived } from "./archive";
import { type AuditResult, runAudit } from "./dependencies/audit";
import { advisoryOf, createDependencyIncident, dependencyIncidentToReopen } from "./dependencies/incident";
import {
  type Audit,
  defaultDependencySettings,
  type DependencySettings,
  dependencyRuleId,
  noCounts,
  opensIncident,
  type SeverityCounts,
  type StoredFinding,
} from "./dependencies/model";
import { createDependencySource } from "./dependencies/source";
import { getFinding, latestAudit, listFindings, recordAudit, setFindingIncident } from "./dependencies/store";
import { shopfrontDir } from "./live/live-source";
import type { Incident, Verification } from "./schema";
import type { TelemetrySource } from "./source";
import { getIncident, listIncidents, patchIncident } from "./store";
import { reopened, resolved, Refused, verificationRefusal } from "./verify";

// The dependency loop: Triage audits the watched service's dependencies
// with its own package manager (dependencies/audit.ts) every intervalHours
// while the watch is on, and whenever someone presses Audit now. A runtime
// dependency's advisory at or over the severity floor opens one incident
// (dependencies/incident.ts), or reopens the one resolved within 30 days on
// the same advisory; later audits that still find it count on it. An audit
// that no longer finds it resolves the incident: as the verification of a
// merged fix (after: "dependencies"), or with a note when it went away
// another way. A failed audit (offline, a registry error) is recorded and
// shown; the findings stay as the last audit left them, and nothing opens.
// startWatch and stopWatch run this loop with the rule watch.

const TICK_MS = 60_000;
const HOUR = 3_600_000;

export type DependencyStatus = "paused" | "off" | "auditing" | "unaudited" | "clean" | "findings" | "alerting" | "error";

// What the Watch page and the sidebar show; the findings themselves come
// from GET /api/watch/dependencies.
export type DependencyState = {
  service: string;
  status: DependencyStatus;
  settings: DependencySettings;
  auditing: boolean;
  lastAudit?: Audit;
  // When the next scheduled audit is due, while the loop is on.
  nextAt?: string;
  // Findings now, by severity: runtime ones and dev ones apart.
  runtime: SeverityCounts;
  dev: SeverityCounts;
  // Incidents open on an advisory.
  open: number;
  // Why the last audit's findings opened nothing (no model to investigate
  // with), or why acting on them failed.
  error?: string;
};

type Internal = {
  version: number;
  enabled: boolean;
  timer?: ReturnType<typeof setInterval>;
  settings?: DependencySettings;
  inFlight?: Promise<Audit>;
  error?: string;
};

// What the loop reaches outside itself, swapped in tests (dependenciesForTests).
type Deps = {
  audit: (target: { service: string; dir: string }) => Promise<AuditResult>;
  now: () => number;
  notify: typeof notify;
  investigationProblem: () => Promise<string | undefined>;
  source: (service: string, now: number) => Promise<TelemetrySource>;
  investigate: (incident: Incident, source: TelemetrySource, appDir: string) => Promise<unknown>;
};
const realDeps: Deps = {
  audit: runAudit,
  now: () => Date.now(),
  notify,
  investigationProblem,
  source: (service, now) => createDependencySource(service, { now }),
  investigate: (incident, source, appDir) => runInvestigation(incident, source, { appDir }),
};
let deps = realDeps;

// On globalThis: one loop per server process, across dev hot reloads, the
// way uptime.ts keeps its own.
const VERSION = 1;
const g = globalThis as unknown as { triageDependencies?: Internal; triageDependenciesTick?: () => Promise<void> };
const fresh = (): Internal => ({ version: VERSION, enabled: false });
let state = (() => {
  const old = g.triageDependencies;
  if (old?.version === VERSION) return old;
  if (old?.timer) clearInterval(old.timer);
  g.triageDependencies = fresh();
  if (old?.enabled) setTimeout(() => startDependencies(), 0);
  return g.triageDependencies;
})();
g.triageDependenciesTick = tick;

// The service the audit watches: Shopfront's checkout, or the directory the
// settings name, filed under its folder's name.
export function auditTarget(settings: DependencySettings): { service: string; dir: string } {
  const dir = settings.serviceDir ? path.resolve(/* turbopackIgnore: true */ settings.serviceDir) : shopfrontDir;
  return { service: dir === shopfrontDir ? "shopfront" : path.basename(dir), dir };
}

async function settings(): Promise<DependencySettings> {
  state.settings = await readDependencySettings();
  return state.settings;
}

export function startDependencies() {
  if (state.timer) return;
  state.enabled = true;
  state.timer = setInterval(() => void g.triageDependenciesTick?.(), TICK_MS);
  void tick();
}

export function stopDependencies() {
  if (state.timer) clearInterval(state.timer);
  Object.assign(state, { timer: undefined, enabled: false });
}

export async function updateDependencySettings(update: Partial<DependencySettings>): Promise<DependencySettings> {
  state.settings = await writeDependencySettings(update);
  // A shorter interval may make an audit due now.
  if (state.enabled) void tick();
  return state.settings;
}

// Runs an audit now, whatever the schedule; one already running is joined
// rather than started twice.
export function auditNow(): Promise<Audit> {
  state.inFlight ??= audit().finally(() => (state.inFlight = undefined));
  return state.inFlight;
}

export function dependencyState(): DependencyState {
  if (!state.settings) void settings().catch((err) => console.error("[triage] dependency settings unreadable", err));
  const s = state.settings ?? defaultDependencySettings();
  const { service } = auditTarget(s);
  let last: Audit | undefined;
  let findings: StoredFinding[] = [];
  try {
    last = latestAudit(service);
    findings = listFindings(service);
  } catch (err) {
    console.error("[triage] dependency audits unreadable", err);
  }
  const runtime = noCounts();
  const dev = noCounts();
  for (const f of findings) (f.dev ? dev : runtime)[f.severity]++;
  const open = findings.filter((f) => f.incidentId && opensIncident(f, s.severityFloor)).length;
  const on = state.enabled && s.enabled;
  const nextAt = on ? new Date(last ? Date.parse(last.at) + s.intervalHours * HOUR : deps.now()).toISOString() : undefined;
  const status: DependencyStatus = state.inFlight
    ? "auditing"
    : !state.enabled
      ? "paused"
      : !s.enabled
        ? "off"
        : !last
          ? "unaudited"
          : last.error
            ? "error"
            : open
              ? "alerting"
              : findings.length
                ? "findings"
                : "clean";
  return { service, status, settings: s, auditing: !!state.inFlight, lastAudit: last, nextAt, runtime, dev, open, error: state.error };
}

async function tick() {
  if (!state.enabled || state.inFlight) return;
  try {
    const s = await settings();
    if (!s.enabled) return;
    const last = latestAudit(auditTarget(s).service);
    if (last && deps.now() - Date.parse(last.at) < s.intervalHours * HOUR) return;
    await auditNow();
  } catch (err) {
    console.error("[triage] dependency audit failed", err);
  }
}

// Audits, saves, and acts on what changed. Never throws for a failed audit:
// that is recorded on its row.
async function audit(): Promise<Audit> {
  const s = await settings();
  const target = auditTarget(s);
  const started = deps.now();
  let result: AuditResult;
  try {
    result = await deps.audit(target);
  } catch (err) {
    const { audit } = recordAudit({
      service: target.service,
      at: new Date(deps.now()).toISOString(),
      durationMs: deps.now() - started,
      counts: noCounts(),
      runtime: 0,
      error: errorMessage(err),
    });
    console.log(`[triage] dependency audit of ${target.service} failed: ${audit.error}`);
    return audit;
  }
  const at = new Date(deps.now()).toISOString();
  const changes = recordAudit(
    {
      service: target.service,
      at,
      durationMs: deps.now() - started,
      packageManager: result.packageManager,
      counts: result.counts,
      runtime: result.findings.filter((f) => !f.dev).length,
    },
    result.findings,
    result.raw,
  );
  console.log(
    `[triage] dependency audit of ${target.service}: ${result.findings.length} advisories, ${changes.appeared.length} new, ${changes.gone.length} gone`,
  );
  state.error = await act(s, target, [...changes.appeared, ...changes.still], at).then(
    () => undefined,
    errorMessage,
  );
  return changes.audit;
}

// Counts, opens or reopens an incident for each finding over the floor, and
// resolves the open ones whose advisory this audit no longer found. Opening
// needs the watch on; counting and resolving don't (Audit now after a fix).
async function act(s: DependencySettings, target: { service: string; dir: string }, found: StoredFinding[], at: string) {
  const problems: string[] = [];
  for (const f of found) {
    if (!opensIncident(f, s.severityFloor)) continue;
    await follow(f, target, at).catch((err: unknown) => problems.push(`${f.advisoryId}: ${errorMessage(err)}`));
  }
  const ids = new Set(found.map((f) => f.advisoryId));
  for (const incident of await openDependencyIncidents(target.service)) {
    if (ids.has(incident.dependency!.advisoryId)) continue;
    await settle(incident, at).catch((err: unknown) => problems.push(`${incident.id}: ${errorMessage(err)}`));
  }
  if (problems.length) throw new Error(problems.join("; "));
}

const isOpenIncident = (i: Incident) => i.status !== "resolved" && !isArchived(i);

async function openDependencyIncidents(service: string): Promise<Incident[]> {
  return (await listIncidents({ service })).filter((i) => i.dependency && i.trigger.rule?.id?.startsWith("deps:") && isOpenIncident(i));
}

// The audit found the advisory: on its open incident, one more audit (and,
// while a merged fix is verified, a point that it's still there); otherwise
// the one resolved within 30 days reopens, or a new one opens.
async function follow(f: StoredFinding, target: { service: string; dir: string }, at: string) {
  const ruleId = dependencyRuleId(f.service, f.advisoryId);
  const onRule = await listIncidents({ ruleId });
  const current = onRule.find(isOpenIncident);
  if (current) {
    await patchIncident(current.id, (i) => ({
      ...i,
      dependency: { ...advisoryOf(f, at, (i.dependency?.audits ?? 0) + 1) },
      verification: stillFound(i.verification, f, at),
    }));
    if (f.incidentId !== current.id) setFindingIncident(f.service, f.advisoryId, current.id);
    return;
  }
  const now = deps.now();
  const previous = dependencyIncidentToReopen(onRule, now);
  if (previous) {
    const incident = await patchIncident(previous.id, (i) => ({
      ...reopened(i, { at, by: "watch", why: `${f.advisoryId} found in ${f.package}@${f.versions[0]} again` }),
      dependency: advisoryOf(f, at, (i.dependency?.audits ?? 0) + 1),
    }));
    setFindingIncident(f.service, f.advisoryId, incident.id);
    console.log(`[triage] dependency audit reopened ${incident.id} for ${f.advisoryId}`);
    deps.notify("incident_reopened", incident);
    return;
  }
  if (!state.enabled) return;
  const problem = await deps.investigationProblem();
  if (problem) throw new Error(`${problem} No incident was opened.`);
  const source = await deps.source(f.service, now);
  const incident = await createDependencyIncident(f, source);
  setFindingIncident(f.service, f.advisoryId, incident.id);
  console.log(`[triage] dependency audit opened ${incident.id}: ${incident.title}`);
  deps.notify("incident_opened", incident);
  void deps.investigate(incident, source, target.dir);
}

// A merged fix's verification, told the audit still finds the advisory.
function stillFound(v: Verification | undefined, f: StoredFinding, at: string): Verification | undefined {
  if (v?.after !== "dependencies" || v.status !== "verifying") return v;
  return {
    ...v,
    series: [...v.series, { t: at, value: 1 }],
    checkedAt: at,
    note: `The last audit still finds ${f.package}@${f.versions.join(", ")}. Pull the merged fix into the service's checkout and install, then audit again.`,
  };
}

// The audit no longer finds the incident's advisory: it resolves, once its
// investigation has finished. A merged fix's verification resolves as such;
// otherwise the record says the dependency changed without a Triage PR.
async function settle(incident: Incident, at: string) {
  const saved = await patchIncident(incident.id, (i) => {
    if (!isOpenIncident(i) || !i.dependency) return i;
    const gone = { ...i, dependency: { ...i.dependency, goneAt: i.dependency.goneAt ?? at } };
    if (i.status === "investigating") return gone;
    const v = i.verification;
    const verifying = v?.after === "dependencies" && v.status === "verifying";
    const note = verifying
      ? undefined
      : i.approval?.prUrl
        ? `The audit no longer finds ${i.dependency.advisoryId}; the fix's PR (${i.approval.prUrl}) wasn't seen merged.`
        : `The audit no longer finds ${i.dependency.advisoryId}: the dependency changed without a Triage PR.`;
    return resolved(
      {
        ...gone,
        verification: {
          after: "dependencies",
          since: verifying ? v.since : at,
          windowMinutes: 1,
          metric: i.trigger.metric,
          threshold: 1,
          series: [...(verifying ? v.series : []), { t: at, value: 0 }],
          status: "resolved",
          startedAt: verifying ? v.startedAt : at,
          checkedAt: at,
          finishedAt: at,
          ...(note && { note }),
        },
      },
      at,
    );
  });
  if (saved.status !== "resolved") return;
  setFindingIncident(saved.service, saved.dependency!.advisoryId, saved.id);
  console.log(`[triage] dependency audit no longer finds ${saved.dependency!.advisoryId}; resolved ${saved.id}`);
  deps.notify("resolved", saved);
}

// After a dependency fix's PR is merged (fix/pr-merge.ts): records the
// verification and audits now. The audit that no longer finds the advisory
// resolves the incident; until then each audit notes it's still there.
// Throws Refused, as startVerification does, when one can't start.
export async function startDependencyVerification(incidentId: string, since: string): Promise<void> {
  const startedAt = new Date(deps.now()).toISOString();
  await patchIncident(incidentId, (i): Incident => {
    const refusal = verificationRefusal(i, "dependencies") ?? (i.dependency ? undefined : "it isn't a dependency incident");
    if (refusal) throw new Refused(refusal);
    return {
      ...i,
      verification: {
        after: "dependencies",
        since,
        windowMinutes: 1,
        metric: i.trigger.metric,
        threshold: 1,
        series: [],
        status: "verifying",
        startedAt,
      },
    };
  });
  void auditNow().catch((err) => console.error("[triage] dependency audit after a merge failed", err));
}

// The finding an incident was opened for, as the latest audit left it.
export async function findingOf(incidentId: string): Promise<StoredFinding | undefined> {
  const incident = await getIncident(incidentId);
  return incident?.dependency && getFinding(incident.service, incident.dependency.advisoryId);
}

// For tests: the loop as a new process starts it, on, with `replace`
// swapped in, auditing only when told to.
export const dependenciesForTests = {
  restart(replace: Partial<Deps> = {}, opts: { enabled?: boolean } = {}) {
    if (state.timer) clearInterval(state.timer);
    state = g.triageDependencies = { ...fresh(), enabled: opts.enabled ?? true };
    deps = { ...realDeps, ...replace };
  },
  audit: () => auditNow(),
};
