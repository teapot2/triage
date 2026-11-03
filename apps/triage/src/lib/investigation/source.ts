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
  // How to read the rows, when the columns need it: slow_queries says what
  // its window columns count (see slowQueriesNote).
  note?: string;
}

// pg_stat_statements keeps totals since the server's statistics were last
// reset, so a statement that ran hours before the alert can top the list.
// slow_queries counts each statement's calls and time over the `minutes`
// before `now` too, from a sample the watch took (live-source.ts), and
// says so in this note; without a sample, only the totals, and the note
// says that instead.
export function slowQueriesNote(now: string | number, minutes: number | undefined): string {
  const totals = "calls, mean_ms and max_ms are totals since the server's statistics were last reset";
  if (minutes === undefined) return `${totals}; no earlier sample to count the window before the alert from`;
  const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `window_calls and window_ms count the ${minutes} min before ${at}; ${totals}`;
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
  // The commit deployed; on a rollback, the commit rolled back.
  sha: string;
  deployedAt: string;
  // A runtime config change (e.g. a flag flipped) rather than a code deploy;
  // `message` says what changed, since there is no commit to look up. A
  // rollback undid `sha`, so it is nothing to roll back again.
  kind?: "deploy" | "config" | "rollback";
  message?: string;
  // The branch the deploy came from, when the pipeline says.
  branch?: string;
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
  // The flags whose state at `now` the telemetry establishes (see
  // deriveFlagStates), for the alert brief and the mitigation rule. A
  // source with no flag logs to read, an endpoint checked from outside say,
  // leaves it out, and a caller treats that as every flag unknown.
  flags?: Record<string, boolean>;
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

// What a log line says about a flag: the `flags: loaded` Shopfront logs at
// boot carries every flag's state as a `flag.FF_X` attribute, and each
// `ops: FF_X turned on|off` is one flip. `at` is epoch milliseconds.
export type FlagEvent =
  | { at: number; kind: "loaded"; flags: Record<string, boolean> }
  | { at: number; kind: "flip"; flag: string; enabled: boolean };

const flagsLoaded = "flags: loaded";
const flagFlip = /^ops: (FF_[A-Z0-9_]+) turned (on|off)\b/;

// The flag event a log message records, read the way a LogGroup carries it:
// the loaded line with its attributes folded into the text as JSON, a flip
// with the flag's name in its words. Anything else is no event.
export function flagEventFromMessage(message: string, at: string | number): FlagEvent | undefined {
  const time = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(time)) return undefined;
  if (message.startsWith(flagsLoaded)) {
    const json = message.slice(flagsLoaded.length).trim();
    try {
      return { at: time, kind: "loaded", flags: flagsFromAttributes(json ? JSON.parse(json) : {}) };
    } catch {
      return undefined;
    }
  }
  const m = flagFlip.exec(message);
  return m ? { at: time, kind: "flip", flag: m[1], enabled: m[2] === "on" } : undefined;
}

// The `flag.FF_X` attributes of a loaded line as flag states; a value that
// isn't a boolean (or "true"/"false") says nothing.
export function flagsFromAttributes(attrs: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith("flag.")) continue;
    const name = key.slice("flag.".length);
    if (value === true || value === "true") out[name] = true;
    else if (value === false || value === "false") out[name] = false;
  }
  return out;
}

// The flags' states after these events, in time order: the newest loaded
// line sets every flag it names, and each flip after it changes one. With
// no loaded line the flips alone decide, a flag's last flip winning. A flag
// with neither is left out: its state is unknown, not off.
export function deriveFlagStates(events: FlagEvent[]): Record<string, boolean> {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  let start = 0;
  const states: Record<string, boolean> = {};
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    if (e.kind !== "loaded") continue;
    Object.assign(states, e.flags);
    start = i + 1;
    break;
  }
  for (const e of ordered.slice(start)) if (e.kind === "flip") states[e.flag] = e.enabled;
  return states;
}
