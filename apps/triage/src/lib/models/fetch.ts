import type { RetryPolicy } from "./policy";
import { errorMessage } from "../errors";

type Fetch = typeof globalThis.fetch;

// Statuses worth another try: a timeout, rate limiting, or the server or a
// gateway in front of it failing. Anything else (a bad key, a refused
// image) fails the same way every time.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// A model call that failed after its retries, said in a sentence a person
// can read on the incident ("Meta's API answered HTTP 503 (4 tries).").
export class ModelCallError extends Error {
  override name = "ModelCallError";
  constructor(
    message: string,
    readonly attempts: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type RetryInfo = { attempt: number; reason: string; waitMs: number };

export type RetryOptions = {
  onRetry?: (info: RetryInfo) => void;
  // For tests.
  fetch?: Fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

type Failure = { reason: string; status?: number };

// A fetch for the AI SDK's provider clients that gives each attempt
// policy.attemptMs and retries transient failures with jittered, doubling
// waits (a 429's retry-after when it gives one). The SDK's own retries are
// off (callSettings), so these are the only ones. The caller's signal (a
// run's budget, a stream's stall limit) ends everything at once and is
// never retried.
//
// A non-streamed answer is read whole within its attempt, so a body that
// stalls times out like a request that never answered. A stream is handed
// over once its headers arrive, and fails if no bytes come for an
// attempt's limit (idleGuard); the SDK's stall limit (callSettings) also
// watches the gaps once the model's output starts.
export function retryingFetch(policy: RetryPolicy, opts: RetryOptions = {}): Fetch {
  const { fetch: base = globalThis.fetch, sleep = abortableSleep, random = Math.random, onRetry } = opts;
  return async (input, init) => {
    const caller = init?.signal ?? undefined;
    const body = init?.body;
    const streaming = typeof body === "string" && /"stream"\s*:\s*true/.test(body);
    // A string body (the SDK's JSON) can be sent again; a stream can't.
    const attempts = body == null || typeof body === "string" ? policy.attempts : 1;

    for (let attempt = 1; ; attempt++) {
      caller?.throwIfAborted();
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(), policy.attemptMs);
      const signal = caller ? AbortSignal.any([caller, timer.signal]) : timer.signal;
      let failure: Failure;
      let retryAfterMs: number | undefined;
      try {
        const res = await base(input, { ...init, signal });
        if (!res.ok && RETRY_STATUSES.has(res.status)) {
          await res.body?.cancel().catch(() => {});
          failure = { reason: `HTTP ${res.status}`, status: res.status };
          retryAfterMs = retryAfter(res.headers);
        } else if (!res.ok) {
          return res;
        } else if (streaming) {
          if (!res.body) return res;
          const { status, statusText, headers } = res;
          return new Response(idleGuard(res.body, policy), { status, statusText, headers });
        } else {
          const whole = await res.arrayBuffer();
          return new Response(whole, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
      } catch (err) {
        if (caller?.aborted) throw caller.reason;
        failure = { reason: timer.signal.aborted ? "timeout" : networkDetail(err) };
      } finally {
        clearTimeout(timeout);
      }

      if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) {
        throw new ModelCallError(
          `${policy.label} is rate-limiting this key: HTTP ${failure.status}, retry after ${Math.ceil(retryAfterMs / 1000)} s.`,
          attempt,
          failure.status,
        );
      }
      if (attempt >= attempts) throw new ModelCallError(failedMessage(policy, failure, attempt), attempt, failure.status);

      const waitMs = retryAfterMs ?? Math.round(random() * policy.baseDelayMs * 2 ** (attempt - 1));
      const reason = failure.reason === "timeout" ? `no answer in ${Math.round(policy.attemptMs / 1000)} s` : failure.reason;
      console.warn(
        `[triage] ${policy.label}: ${reason}, retry ${attempt} of ${attempts - 1} in ${(waitMs / 1000).toFixed(1)} s`,
      );
      onRetry?.({ attempt, reason, waitMs });
      await sleep(waitMs, caller);
    }
  };
}

// A streamed body that fails once nothing arrives for policy.attemptMs: a
// connection that died after its headers, before the model's first output,
// which the SDK's own stream limits don't catch (checked Oct 31: a stream
// held after its first event ran until the run's budget).
function idleGuard(body: ReadableStream<Uint8Array>, policy: RetryPolicy): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const seconds = Math.round(policy.attemptMs / 1000);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ModelCallError(`${policy.label} stopped sending its answer for ${seconds} s.`, 1)),
          policy.attemptMs,
        );
      });
      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        reader.cancel(err).catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function failedMessage(policy: RetryPolicy, failure: Failure, attempts: number): string {
  const tries = attempts > 1 ? ` (${attempts} tries)` : "";
  if (failure.reason === "timeout") {
    return `${policy.label} didn't answer within ${Math.round(policy.attemptMs / 1000)} s${tries}.`;
  }
  if (failure.status === 429) return `${policy.label} is rate-limiting this key: HTTP 429${tries}.`;
  if (failure.status) return `${policy.label} answered HTTP ${failure.status}${tries}.`;
  return `Couldn't reach ${policy.label}: ${failure.reason}${tries}.`;
}

// retry-after-ms, or retry-after in seconds or as an HTTP date.
function retryAfter(headers: Headers): number | undefined {
  const ms = Number.parseFloat(headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// Node's and undici's codes for the usual ways a connection fails.
const NETWORK_CODES: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ENOTFOUND: "host not found",
  EAI_AGAIN: "DNS lookup failed",
  ETIMEDOUT: "connection timed out",
  ENETUNREACH: "network unreachable",
  UND_ERR_SOCKET: "connection closed",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
};

// What went wrong on the wire: undici's code where there is one, in words
// when it's a usual one, else the innermost message. fetch itself only
// says "fetch failed".
function networkDetail(err: unknown): string {
  let message = errorMessage(err);
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return NETWORK_CODES[code] ?? code;
    message = e.message;
  }
  return message;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
