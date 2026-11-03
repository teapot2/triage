import type { DependencyAdvisory, Exposure, Incident, MetricPoint } from "../schema";
import {
  type CommitRecord,
  type DbCheck,
  type DbResult,
  type DeployRecord,
  deriveFlagStates,
  type FlagEvent,
  flagEventFromMessage,
  type LogGroup,
  type MetricSeries,
  type SpanRecord,
  type TelemetrySource,
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
  // The advisory a dependency scenario's incident carries: it routes the
  // run to the exposure stage (dependencies/exposure.ts).
  dependency?: DependencyAdvisory;
  // Ground truth for grading a run (grade.ts). Never reaches the model:
  // createScenarioSource doesn't read it.
  expected?: Expected;
}

export interface Expected {
  // root_cause: a defect to find. no_root_cause: nothing is wrong (a
  // control). no_defect: the alert is real but nothing is broken, a traffic
  // rush say, so any verdict hits as long as its words make every point and
  // no change in the window gets blamed with a mitigation.
  verdict: "root_cause" | "no_root_cause" | "no_defect";
  // Shopfront paths; the diagnosis must name or cite one of them. Empty
  // when no file is to blame.
  rootCauseFiles: string[];
  // Each inner list is one point the diagnosis must make, in any of these
  // words (case-insensitive).
  mustMention: string[][];
  // The flag to turn off, or the sha to roll back; "none" when proposing
  // any mitigation is the mistake.
  mitigation?: { kind: "flag_off" | "rollback"; target: string } | "none";
  // A dependency scenario's exposure verdict.
  exposure?: Exposure["verdict"];
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
      flags: deriveFlagStates(scenarioFlagEvents(s).filter((e) => e.at <= now)),
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

const flipWords = /turned (on|off)\b/;

// The flag events a scenario records, from both places it keeps them: its
// log groups, each standing for its last occurrence, and its config deploy
// records (`config:FF_X`, "... turned on|off"). A flip recorded in both is
// applied twice, which changes nothing.
export function scenarioFlagEvents(s: Scenario): FlagEvent[] {
  const fromLogs = s.logs.flatMap((l) => {
    const e = flagEventFromMessage(l.message, l.lastSeen);
    return e ? [e] : [];
  });
  const fromDeploys = s.deploys.flatMap((d): FlagEvent[] => {
    const m = d.sha.startsWith("config:") ? flipWords.exec(d.message ?? "") : null;
    if (!m) return [];
    return [{ at: Date.parse(d.deployedAt), kind: "flip", flag: d.sha.slice("config:".length), enabled: m[1] === "on" }];
  });
  return [...fromLogs, ...fromDeploys];
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
