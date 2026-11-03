import { createLiveSource } from "../live/live-source";
import type { MetricPoint } from "../schema";
import type { MetricSeries, SourceDescription, TelemetrySource } from "../source";
import { DEPENDENCY_METRIC, DEPENDENCY_UNIT, dependencyMetric, type StoredFinding } from "./model";
import { listAudits, listFindings } from "./store";

// What an investigation reads for an incident the dependency audit opened:
// the audits as metrics (one point per audit that ran), the service's
// source, git and deploy history as Shopfront's live source has them, and no
// logs, traces or database: an advisory is in the code, not in the traffic.
// describe().id is "deps:<service>", which routes the incident to the
// exposure stage instead of the telemetry investigation (agent.ts).

export const dependencySourceId = (service: string) => `deps:${service}`;
export const isDependencySource = (id: string | undefined) => id?.startsWith("deps:") ?? false;

const MINUTE = 60_000;

export type DependencySourceOptions = {
  now?: number;
  // Shopfront's live source; tests stub it.
  live?: (opts: { now: number }) => Promise<TelemetrySource>;
};

// The audits' series up to `now`: every runtime advisory found per audit,
// and 1 or 0 per audit for each advisory (1 while an audit found it).
export function dependencySeries(service: string, now: number): MetricSeries[] {
  const audits = listAudits(service, 500)
    .filter((a) => !a.error && Date.parse(a.at) <= now)
    .reverse();
  const findings = listFindings(service, { gone: true });
  const total: MetricSeries = {
    name: DEPENDENCY_METRIC,
    service,
    unit: DEPENDENCY_UNIT,
    description: `Advisories the audit of ${service}'s runtime dependencies found, one point per audit`,
    points: audits.map((a) => ({ t: a.at, value: a.runtime })),
  };
  const found = (f: StoredFinding, at: string) =>
    Date.parse(at) >= Date.parse(f.firstSeen) && Date.parse(at) <= Date.parse(f.goneAt ?? f.lastSeen);
  const per = findings.map(
    (f): MetricSeries => ({
      name: dependencyMetric(f.advisoryId),
      service,
      unit: DEPENDENCY_UNIT,
      description: `1 while the audit finds ${f.advisoryId} (${f.package}) in ${service}'s dependencies, one point per audit`,
      points: audits.map((a): MetricPoint => ({ t: a.at, value: found(f, a.at) ? 1 : 0 })),
    }),
  );
  return [total, ...per];
}

export async function createDependencySource(service: string, opts: DependencySourceOptions = {}): Promise<TelemetrySource> {
  const now = opts.now ?? Date.now();
  const live = await (opts.live ?? createLiveSource)({ now });
  const series = dependencySeries(service, now);
  const base = live.describe();
  const description: SourceDescription = {
    id: dependencySourceId(service),
    now: new Date(now).toISOString(),
    services: [{ name: service, dependsOn: [] }],
    metrics: series.map(({ name, service, unit, description }) => ({ name, service, unit, description })),
    flags: base.flags,
  };
  return {
    describe: () => description,
    async queryLogs() {
      return [];
    },
    async queryTraces() {
      return [];
    },
    async queryMetric({ name, windowMinutes }) {
      const s = series.find((x) => x.name === name);
      if (!s) return undefined;
      // Audits are hours apart: a window shorter than a day still shows the
      // last few, so the chart has a line.
      const since = now - Math.max(windowMinutes, 7 * 24 * 60) * MINUTE;
      return { ...s, points: s.points.filter((p) => Date.parse(p.t) > since) };
    },
    async dbDiagnostics() {
      return { query: "", rows: [], note: "A dependency advisory has no database side." };
    },
    readSource: (p) => live.readSource(p),
    listSourceFiles: () => live.listSourceFiles(),
    gitLog: (q) => live.gitLog(q),
    deployHistory: (q) => live.deployHistory(q),
  };
}
