import { logs, SeverityNumber, type Attributes } from "@opentelemetry/api";

// In OTel JS SDK 3.x the Logs API lives in @opentelemetry/api (the separate
// @opentelemetry/api-logs package is the pre-3.0 line). Records emitted here
// pick up the active span context, so logs correlate with traces.
const otelLogger = logs.getLogger("shopfront");

type Level = "debug" | "info" | "warn" | "error";

const severity: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function emit(level: Level, message: string, attributes?: Attributes) {
  otelLogger.emit({
    severityNumber: severity[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes,
  });
  const line = attributes ? `${message} ${JSON.stringify(attributes)}` : message;
  console[level === "debug" ? "log" : level](`[${level}] ${line}`);
}

export const logger = {
  debug: (msg: string, attrs?: Attributes) => emit("debug", msg, attrs),
  info: (msg: string, attrs?: Attributes) => emit("info", msg, attrs),
  warn: (msg: string, attrs?: Attributes) => emit("warn", msg, attrs),
  error: (msg: string, attrs?: Attributes) => emit("error", msg, attrs),
};
