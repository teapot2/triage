import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Reads the OTLP JSON lines the collector's file exporters write
// (infra/otel-collector/config.yaml) and flattens them into rows. Each file
// is tailed: a read parses only what was appended since the last one, and
// rows older than RETENTION_MS are dropped, so querying stays cheap on a
// machine that has been running the demo for hours.

// The turbopackIgnore comments on every path here keep Turbopack from
// tracing these reads at compile time: it would otherwise treat the whole
// directory (rewritten every second) as a dependency of the route.
export const telemetryDir = path.resolve(
  /* turbopackIgnore: true */ process.env.TELEMETRY_DIR ??
    path.join(/* turbopackIgnore: true */ process.cwd(), "..", "..", "infra", "telemetry"),
);

export const RETENTION_MS = 3 * 60 * 60_000;
// On first load, skip to the last part of a huge file rather than parse it all.
const MAX_INITIAL_BYTES = 64 * 1024 * 1024;

export type Attrs = Record<string, string | number | boolean>;

export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  scope: string;
  name: string;
  // OTLP SpanKind: 1 internal, 2 server, 3 client, 4 producer, 5 consumer
  kind: number;
  start: number;
  end: number;
  error: boolean;
  statusMessage?: string;
  attributes: Attrs;
  events: { name: string; time: number; attributes: Attrs }[];
}

export interface LogRow {
  time: number;
  service: string;
  level: "debug" | "info" | "warn" | "error";
  body: string;
  attributes: Attrs;
  traceId?: string;
}

// Gauges and sums only: the live source derives latency from spans.
export interface MetricRow {
  name: string;
  service: string;
  unit: string;
  description: string;
  time: number;
  attributes: Attrs;
  value: number;
}

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
}
interface KeyValue {
  key: string;
  value?: AnyValue;
}

function anyValue(v?: AnyValue): string | number | boolean | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return JSON.stringify((v.arrayValue.values ?? []).map(anyValue));
  return undefined;
}

function attrs(kvs: KeyValue[] = []): Attrs {
  const out: Attrs = {};
  for (const kv of kvs) {
    const v = anyValue(kv.value);
    if (v !== undefined) out[kv.key] = v;
  }
  return out;
}

// Nanosecond strings to epoch ms; the sub-microsecond precision lost is fine.
const ms = (nanos?: string | number) => (nanos === undefined ? 0 : Number(nanos) / 1e6);

const serviceOf = (resource?: { attributes?: KeyValue[] }) =>
  String(attrs(resource?.attributes)["service.name"] ?? "unknown");

function levelOf(severityNumber?: number): LogRow["level"] {
  const n = severityNumber ?? 9;
  return n >= 17 ? "error" : n >= 13 ? "warn" : n >= 9 ? "info" : "debug";
}

/* eslint-disable @typescript-eslint/no-explicit-any -- OTLP JSON, checked field by field */
function parseTraces(j: any): SpanRow[] {
  return (j.resourceSpans ?? []).flatMap((rs: any) =>
    (rs.scopeSpans ?? []).flatMap((ss: any) =>
      (ss.spans ?? []).map(
        (s: any): SpanRow => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId || undefined,
          service: serviceOf(rs.resource),
          scope: ss.scope?.name ?? "",
          name: s.name,
          kind: s.kind ?? 1,
          start: ms(s.startTimeUnixNano),
          end: ms(s.endTimeUnixNano),
          error: s.status?.code === 2,
          statusMessage: s.status?.message || undefined,
          attributes: attrs(s.attributes),
          events: (s.events ?? []).map((e: any) => ({
            name: e.name,
            time: ms(e.timeUnixNano),
            attributes: attrs(e.attributes),
          })),
        }),
      ),
    ),
  );
}

function parseLogs(j: any): LogRow[] {
  return (j.resourceLogs ?? []).flatMap((rl: any) =>
    (rl.scopeLogs ?? []).flatMap((sl: any) =>
      (sl.logRecords ?? []).map(
        (r: any): LogRow => ({
          time: ms(r.timeUnixNano || r.observedTimeUnixNano),
          service: serviceOf(rl.resource),
          level: levelOf(r.severityNumber),
          body: String(anyValue(r.body) ?? ""),
          attributes: attrs(r.attributes),
          traceId: r.traceId || undefined,
        }),
      ),
    ),
  );
}

function parseMetrics(j: any): MetricRow[] {
  return (j.resourceMetrics ?? []).flatMap((rm: any) =>
    (rm.scopeMetrics ?? []).flatMap((sm: any) =>
      (sm.metrics ?? []).flatMap((m: any) => {
        const data = m.gauge ?? m.sum;
        if (!data) return [];
        return (data.dataPoints ?? []).map(
          (p: any): MetricRow => ({
            name: m.name,
            service: serviceOf(rm.resource),
            unit: m.unit ?? "",
            description: m.description ?? "",
            time: ms(p.timeUnixNano),
            attributes: attrs(p.attributes),
            value: Number(p.asDouble ?? p.asInt ?? 0),
          }),
        );
      }),
    ),
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

class JsonlTail<T> {
  private offset = 0;
  private rows: T[] = [];
  private loaded = false;
  private reading: Promise<T[]> | null = null;

  constructor(
    private readonly file: string,
    private readonly parse: (json: unknown) => T[],
    private readonly timeOf: (row: T) => number,
  ) {}

  // Concurrent tool calls share one read.
  read(): Promise<T[]> {
    this.reading ??= this.refresh().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async refresh(): Promise<T[]> {
    if (!this.loaded) {
      this.loaded = true;
      for (const backup of await this.backups()) await this.append(backup, 0, true);
    }
    let size: number;
    try {
      size = (await stat(/* turbopackIgnore: true */ this.file)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      size = 0;
    }
    // Smaller than last time: the exporter rotated it. What was read stays.
    if (size < this.offset) this.offset = 0;
    if (size > this.offset) this.offset = await this.append(this.file, this.offset, false);

    const cutoff = Date.now() - RETENTION_MS;
    if (this.rows.length > 0 && this.timeOf(this.rows[0]) < cutoff) {
      this.rows = this.rows.filter((r) => this.timeOf(r) >= cutoff);
    }
    return this.rows;
  }

  // Rotated files sit beside the live one as <name>-<timestamp>.jsonl.
  private async backups(): Promise<string[]> {
    const base = path.basename(this.file, ".jsonl");
    try {
      return (await readdir(/* turbopackIgnore: true */ path.dirname(this.file)))
        .filter((n) => n.startsWith(`${base}-`) && n.endsWith(".jsonl"))
        .sort()
        .slice(-2)
        .map((n) => path.join(/* turbopackIgnore: true */ path.dirname(this.file), n));
    } catch {
      return [];
    }
  }

  // Parses complete lines from `from` on; returns the offset after the last one.
  private async append(file: string, from: number, whole: boolean): Promise<number> {
    const fh = await open(/* turbopackIgnore: true */ file, "r");
    try {
      const size = (await fh.stat()).size;
      let start = from;
      let skipFirst = false;
      if (size - start > MAX_INITIAL_BYTES) {
        start = size - MAX_INITIAL_BYTES;
        skipFirst = true;
      }
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      // Stop at the last newline so a line still being written waits for next time.
      const end = whole ? buf.length : buf.lastIndexOf(0x0a) + 1;
      const lines = buf.subarray(0, end).toString("utf8").split("\n");
      if (skipFirst) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          for (const row of this.parse(JSON.parse(line))) this.rows.push(row);
        } catch {
          // A torn line from a crash or rotation; skip it.
        }
      }
      return start + end;
    } finally {
      await fh.close();
    }
  }
}

interface Tails {
  spans: JsonlTail<SpanRow>;
  logs: JsonlTail<LogRow>;
  metrics: JsonlTail<MetricRow>;
}

// On globalThis so dev hot reloads keep what was already parsed.
const globalForTails = globalThis as unknown as { triageOtlpTails?: Tails };
const tails = (globalForTails.triageOtlpTails ??= {
  spans: new JsonlTail(path.join(/* turbopackIgnore: true */ telemetryDir, "traces.jsonl"), parseTraces, (r) => r.start),
  logs: new JsonlTail(path.join(/* turbopackIgnore: true */ telemetryDir, "logs.jsonl"), parseLogs, (r) => r.time),
  metrics: new JsonlTail(path.join(/* turbopackIgnore: true */ telemetryDir, "metrics.jsonl"), parseMetrics, (r) => r.time),
});

export async function readTelemetry() {
  const [spans, logs, metrics] = await Promise.all([tails.spans.read(), tails.logs.read(), tails.metrics.read()]);
  return { spans, logs, metrics };
}
