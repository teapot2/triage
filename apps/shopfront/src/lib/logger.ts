import { context as otelContext, logs, SeverityNumber, trace, type Attributes, type Context } from "@opentelemetry/api";

// In OTel JS SDK 3.x the Logs API lives in @opentelemetry/api (the separate
// @opentelemetry/api-logs package is the pre-3.0 line). Records emitted here
// pick up the active span context, so logs correlate with traces. The
// logger is looked up on each emit rather than held: one taken before the
// SDK registers its provider (this module loads ahead of it at boot) would
// be a no-op for good, and the lookup is a map read.
const otelLogger = () => logs.getLogger("shopfront");

export type Level = "debug" | "info" | "warn" | "error";

const levels: Level[] = ["debug", "info", "warn", "error"];

const severity: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// The least severe level that gets logged, from LOG_LEVEL. The default is
// info, as in production: per-request detail is logged at debug and stays
// out of the stream until someone turns it on.
const configured = (process.env.LOG_LEVEL ?? "").toLowerCase();
export const minLevel: Level = (levels as string[]).includes(configured) ? (configured as Level) : "info";

export const isLevelEnabled = (level: Level) => levels.indexOf(level) >= levels.indexOf(minLevel);

const reserved = new Set(["time", "level", "msg", "trace_id", "span_id"]);

export type EmitOptions = {
  // Where the record happened, when it isn't the active context: a span
  // that already ended, for instance.
  context?: Context;
  // When it happened, in epoch ms, if not now.
  timestamp?: number;
};

// Emits one record to OTel and mirrors it to stdout as one JSON object per
// line, the shape log shippers expect.
export function logAt(level: Level, message: string, attributes?: Attributes, options?: EmitOptions) {
  if (!isLevelEnabled(level)) return;
  const ctx = options?.context ?? otelContext.active();
  const timestamp = options?.timestamp ?? Date.now();
  otelLogger().emit({
    severityNumber: severity[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes,
    context: ctx,
    timestamp,
  });
  const span = trace.getSpanContext(ctx);
  // The line's own fields win: an attribute named `level` or `msg` can't
  // replace them.
  const line: Record<string, unknown> = { time: new Date(timestamp).toISOString(), level, msg: message };
  for (const [key, value] of Object.entries(attributes ?? {})) if (!reserved.has(key)) line[key] = value;
  if (span) Object.assign(line, { trace_id: span.traceId, span_id: span.spanId });
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg: string, attrs?: Attributes) => logAt("debug", msg, attrs),
  info: (msg: string, attrs?: Attributes) => logAt("info", msg, attrs),
  warn: (msg: string, attrs?: Attributes) => logAt("warn", msg, attrs),
  error: (msg: string, attrs?: Attributes) => logAt("error", msg, attrs),
};
