import type { MetricPoint } from "./schema";

// What the investigation tools read from: a recorded scenario
// (scenarios/scenario-source.ts), the running Shopfront's telemetry
// (live/live-source.ts) or an uptime check's results (uptime/source.ts). Queries return raw telemetry; the tools turn
// results into evidence.

export interface LogGroup {
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  traceId?: string;
}

export interface SpanRecord {
  traceId: string;
  service: string;
  name: string;
  route?: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean>;
}

export interface MetricSeries {
  name: string;
  service: string;
  unit: string;
  description: string;
  points: MetricPoint[];
}

export type DbCheck = "activity" | "locks" | "slow_queries";

export interface DbResult {
  query: string;
  rows: Record<string, string | number | null>[];
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface CommitRecord {
  sha: string;
  author: string;
  message: string;
  files: string[];
  committedAt: string;
}

export interface DeployRecord {
  service: string;
  sha: string;
  deployedAt: string;
  // A runtime config change (e.g. a flag flipped) rather than a code deploy;
  // `message` says what changed, since there is no commit to look up.
  kind?: "deploy" | "config";
  message?: string;
}

export interface SourceDescription {
  id: string;
  now: string;
  services: { name: string; dependsOn: string[] }[];
  metrics: { name: string; service: string; unit: string; description: string }[];
  // An endpoint known only from Triage's own checks of it from outside
  // (uptime/source.ts): there is no database, code or deploy history
  // behind it to read, and the tools say so.
  external?: { url: string };
}

export interface TelemetrySource {
  describe(): SourceDescription;
  queryLogs(q: {
    service?: string;
    minLevel?: LogGroup["level"];
    contains?: string;
    windowMinutes: number;
  }): Promise<LogGroup[]>;
  queryTraces(q: {
    service?: string;
    route?: string;
    status?: "ok" | "error";
    minDurationMs?: number;
    // Spans that started in the last `windowMinutes`; unset, all that's kept.
    windowMinutes?: number;
    limit: number;
  }): Promise<SpanRecord[]>;
  queryMetric(q: { name: string; windowMinutes: number }): Promise<MetricSeries | undefined>;
  dbDiagnostics(check: DbCheck): Promise<DbResult>;
  readSource(path: string): Promise<SourceFile | undefined>;
  listSourceFiles(): Promise<string[]>;
  gitLog(q: { path?: string; limit: number }): Promise<CommitRecord[]>;
  deployHistory(q: { service?: string; sinceMinutes: number }): Promise<DeployRecord[]>;
}
