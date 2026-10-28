import { readTelemetry, type SpanRow } from "@/lib/investigation/live/otlp-files";
import type { LiveTrace, LiveTraceSpan } from "./types";

// The attributes worth showing on a span in the live page's trace view:
// what it queried or served. Long values (SQL) are cut short.
const detailKeys = ["db.query.text", "db.statement", "http.route", "http.status_code", "http.response.status_code"];
const MAX_DETAIL = 300;
const MAX_SPANS = 300;

function detail(s: SpanRow): string | undefined {
  for (const key of detailKeys) {
    const v = s.attributes[key];
    if (v !== undefined && v !== "") {
      const text = String(v).replace(/\s+/g, " ").trim();
      return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
    }
  }
  return undefined;
}

// One request's spans as a tree, in the order they started, each with its
// depth and its offset from the request's start: a waterfall.
export function buildTrace(traceId: string, rows: SpanRow[]): LiveTrace | undefined {
  const spans = rows.filter((s) => s.traceId === traceId);
  if (spans.length === 0) return undefined;
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string, SpanRow[]>();
  const roots: SpanRow[] = [];
  for (const s of spans) {
    // A parent that isn't in the files (not exported yet, or rotated away)
    // makes its child a root.
    if (s.parentSpanId && ids.has(s.parentSpanId)) {
      const list = children.get(s.parentSpanId);
      if (list) list.push(s);
      else children.set(s.parentSpanId, [s]);
    } else roots.push(s);
  }
  const byStart = (a: SpanRow, b: SpanRow) => a.start - b.start;
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));

  const out: LiveTraceSpan[] = [];
  const visit = (s: SpanRow, depth: number) => {
    if (out.length >= MAX_SPANS) return;
    out.push({
      spanId: s.spanId,
      name: s.name,
      service: s.service,
      depth,
      offsetMs: Math.round((s.start - start) * 10) / 10,
      durationMs: Math.round((s.end - s.start) * 10) / 10,
      error: s.error,
      statusMessage: s.statusMessage,
      detail: detail(s),
    });
    for (const c of (children.get(s.spanId) ?? []).sort(byStart)) visit(c, depth + 1);
  };
  for (const r of roots.sort(byStart)) visit(r, 0);

  return { traceId, start, durationMs: Math.round((end - start) * 10) / 10, spans: out, truncated: spans.length > out.length };
}

export async function liveTrace(traceId: string): Promise<LiveTrace | undefined> {
  const { spans } = await readTelemetry();
  return buildTrace(traceId, spans);
}
