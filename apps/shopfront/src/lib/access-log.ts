import { context as otelContext, SpanKind, trace } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import { logAt } from "./logger";

// The access log: one line per request, the way a web server writes one,
// taken from Next.js's own request spans so pages and API routes are
// covered alike without touching either. Each line carries the route, the
// path, the status and how long the request took, and is tied to its trace.
// Requests past SLOW_MS also get a warning, the usual trigger for a look.

export const SLOW_MS = 1000;

// Operator pages aren't customer traffic, so they stay out of the access log.
const internal = ["/ops", "/api/ops"];

const isRequest = (span: ReadableSpan) =>
  span.instrumentationScope.name === "next.js" && span.kind === SpanKind.SERVER && typeof span.attributes["http.route"] === "string";

const toMs = ([seconds, nanos]: [number, number]) => seconds * 1000 + nanos / 1e6;

export function accessLogProcessor(): SpanProcessor {
  return {
    onStart() {},
    onEnd(span) {
      if (!isRequest(span)) return;
      const route = String(span.attributes["http.route"]);
      if (internal.includes(route)) return;
      const method = String(span.attributes["http.method"] ?? "GET");
      const status = Number(span.attributes["http.status_code"] ?? 0);
      const durationMs = Math.round(toMs(span.duration) * 10) / 10;
      const attributes = {
        "http.request.method": method,
        "http.route": route,
        "http.response.status_code": status,
        "url.path": String(span.attributes["http.target"] ?? route),
        duration_ms: durationMs,
      };
      const options = {
        context: trace.setSpanContext(otelContext.active(), span.spanContext()),
        timestamp: toMs(span.endTime),
      };
      logAt(status >= 500 ? "error" : "info", `${method} ${route} ${status}`, attributes, options);
      if (durationMs >= SLOW_MS) logAt("warn", "slow request", attributes, options);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
