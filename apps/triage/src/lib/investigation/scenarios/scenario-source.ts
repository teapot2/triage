import type { Incident, MetricPoint } from "../schema";
import type {
  CommitRecord,
  DbCheck,
  DbResult,
  DeployRecord,
  LogGroup,
  MetricSeries,
  SpanRecord,
  TelemetrySource,
} from "../source";

// A recorded incident: telemetry as it looked when the alert fired. The
// source answers queries by filtering it, so the agent still has to choose
// what to look at.
export interface Scenario {
  id: string;
  label: string;
  description: string;
  now: string;
  alert: {
    title: string;
    service: string;
    severity: Incident["severity"];
    metric: string;
    threshold: number;
  };
  services: { name: string; dependsOn: string[] }[];
  logs: LogGroup[];
  spans: SpanRecord[];
  metrics: MetricSeries[];
  db: Record<DbCheck, DbResult>;
  files: Record<string, string>;
  commits: CommitRecord[];
  deploys: DeployRecord[];
  // The alert's metric after the mitigation, for the simulated apply.
  recovery?: MetricPoint[];
  // Ground truth for grading a run (grade.ts). Never reaches the model:
  // createScenarioSource doesn't read it.
  expected?: Expected;
}

export interface Expected {
  verdict: "root_cause" | "no_root_cause";
  // Shopfront paths; the diagnosis must name or cite one of them.
  rootCauseFiles: string[];
  // Each inner list is one point the diagnosis must make, in any of these
  // words (case-insensitive).
  mustMention: string[][];
  // The flag to turn off, or the sha to roll back.
  mitigation?: { kind: "flag_off" | "rollback"; target: string };
}

const levelRank = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export function createScenarioSource(s: Scenario): TelemetrySource {
  const now = Date.parse(s.now);
  const since = (minutes: number) => now - minutes * 60_000;

  return {
    describe: () => ({
      id: `scenario:${s.id}`,
      now: s.now,
      services: s.services,
      metrics: s.metrics.map(({ name, service, unit, description }) => ({ name, service, unit, description })),
    }),

    async queryLogs({ service, minLevel, contains, windowMinutes }) {
      return s.logs
        .filter((l) => !service || l.service === service)
        .filter((l) => !minLevel || levelRank[l.level] >= levelRank[minLevel])
        .filter((l) => !contains || l.message.toLowerCase().includes(contains.toLowerCase()))
        .filter((l) => Date.parse(l.lastSeen) >= since(windowMinutes))
        .sort((a, b) => b.count - a.count);
    },

    async queryTraces({ service, route, status, minDurationMs, windowMinutes, limit }) {
      return s.spans
        .filter((sp) => windowMinutes === undefined || Date.parse(sp.startedAt) >= since(windowMinutes))
        .filter((sp) => !service || sp.service === service)
        .filter((sp) => !route || sp.route === route || sp.name.includes(route))
        .filter((sp) => !status || sp.status === status)
        .filter((sp) => minDurationMs === undefined || sp.durationMs >= minDurationMs)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, limit);
    },

    async queryMetric({ name, windowMinutes }) {
      const m = s.metrics.find((x) => x.name === name);
      if (!m) return undefined;
      return { ...m, points: m.points.filter((p) => Date.parse(p.t) >= since(windowMinutes)) };
    },

    async dbDiagnostics(check) {
      return s.db[check];
    },

    async readSource(path) {
      const content = s.files[path.replace(/^\.?\//, "")];
      return content === undefined ? undefined : { path, content };
    },

    async listSourceFiles() {
      return Object.keys(s.files).sort();
    },

    async gitLog({ path, limit }) {
      return s.commits
        .filter((c) => !path || c.files.some((f) => f === path || f.startsWith(`${path}/`)))
        .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))
        .slice(0, limit);
    },

    async deployHistory({ service, sinceMinutes }) {
      return s.deploys
        .filter((d) => !service || d.service === service)
        .filter((d) => Date.parse(d.deployedAt) >= since(sinceMinutes))
        .sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt));
    },
  };
}

// Deterministic per-minute series ending at `now`, so scenarios stay stable
// across runs without storing every point by hand.
export function minuteSeries(
  now: string,
  minutes: number,
  value: (minutesAgo: number, wobble: number) => number,
): MetricPoint[] {
  const end = Date.parse(now);
  return Array.from({ length: minutes }, (_, i) => {
    const minutesAgo = minutes - 1 - i;
    const wobble = Math.sin(i * 1.7) * 0.5 + Math.sin(i * 0.6) * 0.5;
    return {
      t: new Date(end - minutesAgo * 60_000).toISOString(),
      value: Math.round(value(minutesAgo, wobble) * 100) / 100,
    };
  });
}

export function minutesBefore(now: string, minutes: number): string {
  return new Date(Date.parse(now) - minutes * 60_000).toISOString();
}
