import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { logger } from "@/lib/logger";

// Synthetic shoppers for the demo: a steady stream of real HTTP requests to
// the store's own API, so latency, errors and pool use show up in telemetry
// the way customer traffic would. Runs on the server (a timer on
// globalThis), so it keeps going with no browser open. Mostly product
// views, the route Triage's latency alert watches, plus some listings.

export const RATES = [1, 2, 5, 10] as const;
const HISTORY_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 10_000;
// Past this many unanswered requests, skip ticks instead of piling on.
const MAX_IN_FLIGHT = 40;

type Second = { at: number; ok: number; errors: number; durations: number[] };
type Traffic = {
  rps: number;
  timer: ReturnType<typeof setInterval> | null;
  origin: string;
  productIds: number[];
  inFlight: number;
  seconds: Second[];
};

const globalForTraffic = globalThis as unknown as { shopfrontTraffic?: Traffic };
const state = (globalForTraffic.shopfrontTraffic ??= {
  rps: 0,
  timer: null,
  origin: "",
  productIds: [],
  inFlight: 0,
  seconds: [],
});

const nowSecond = () => Math.floor(Date.now() / 1000);

function record(ok: boolean, durationMs: number) {
  const at = nowSecond();
  let second = state.seconds.at(-1);
  if (!second || second.at !== at) {
    second = { at, ok: 0, errors: 0, durations: [] };
    state.seconds.push(second);
    while (state.seconds.length > HISTORY_SECONDS) state.seconds.shift();
  }
  if (ok) second.ok++;
  else second.errors++;
  second.durations.push(durationMs);
}

async function shop() {
  if (state.inFlight >= MAX_IN_FLIGHT) return;
  const path =
    Math.random() < 0.8
      ? `/api/products/${state.productIds[Math.floor(Math.random() * state.productIds.length)]}`
      : "/api/products";
  state.inFlight++;
  const started = performance.now();
  try {
    const res = await fetch(state.origin + path, {
      headers: { "user-agent": "fernhill-loadgen/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    record(res.ok, performance.now() - started);
  } catch {
    record(false, performance.now() - started);
  } finally {
    state.inFlight--;
  }
}

export function startTraffic(rps: number, origin: string, productIds: number[]) {
  stopTraffic(false);
  state.rps = rps;
  state.origin = origin;
  state.productIds = productIds;
  // Each request starts its own trace, like a real shopper's. Without the
  // root context, the timer would inherit the /api/ops request that started
  // it, and every synthetic request would land in that one trace.
  state.timer = setInterval(() => void context.with(ROOT_CONTEXT, shop), 1000 / rps);
  logger.info("ops: synthetic traffic started", { "traffic.rps": rps });
}

export function stopTraffic(log = true) {
  if (state.timer) clearInterval(state.timer);
  const wasRunning = state.timer !== null;
  state.timer = null;
  state.rps = 0;
  if (log && wasRunning) logger.info("ops: synthetic traffic stopped");
}

const p95 = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
};

// The last minute, one entry per second (gaps filled), and the last 10 s
// summed up.
export function trafficSnapshot() {
  const now = nowSecond();
  const bySecond = new Map(state.seconds.map((s) => [s.at, s]));
  const timeline = Array.from({ length: HISTORY_SECONDS }, (_, i) => {
    const s = bySecond.get(now - HISTORY_SECONDS + 1 + i);
    return { ok: s?.ok ?? 0, errors: s?.errors ?? 0, p95: s ? p95(s.durations) : null };
  });
  const recent = state.seconds.filter((s) => s.at > now - 10);
  const ok = recent.reduce((n, s) => n + s.ok, 0);
  const errors = recent.reduce((n, s) => n + s.errors, 0);
  return {
    running: state.timer !== null,
    rps: state.rps,
    inFlight: state.inFlight,
    timeline,
    last10s: {
      requests: ok + errors,
      errorRatio: ok + errors === 0 ? null : errors / (ok + errors),
      p95: p95(recent.flatMap((s) => s.durations)),
    },
  };
}
