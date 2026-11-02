import { checkUrl, type Lookup } from "./guard";
import type { UptimeCheck, UptimeSample } from "./model";
import { errorMessage } from "../../errors";

// Runs one uptime check: a GET to the check's URL, timed to the response
// headers, judged against its status range and slow limit. Redirects are
// followed by hand so the guard sees every hop. The body is never read. The
// check's auth header goes with requests to the check's own origin only: a
// redirect elsewhere must not carry the token along.

const MAX_REDIRECTS = 5;
const redirects = new Set([301, 302, 303, 307, 308]);

export type ProbeOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  // For the guard's DNS lookups; tests stub it.
  lookup?: Lookup;
};

// The reason a request failed: undici hides the system's code (ENOTFOUND,
// ECONNREFUSED, CERT_HAS_EXPIRED) on the error's cause.
function failure(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return cause.code;
  if (cause?.message) return cause.message;
  return errorMessage(err);
}

// The request's headers: the auth header when the check has one with a
// value and `url` is on the check's origin.
function headersFor(check: UptimeCheck, url: string): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": "Triage uptime check", accept: "*/*" };
  if (check.auth?.value && new URL(url).origin === new URL(check.url).origin) headers[check.auth.header] = check.auth.value;
  return headers;
}

// "HTTP 503", or what 401 and 403 mean for a check: the endpoint answered
// and turned it away.
const badStatus = (status: number) =>
  status === 401 ? "HTTP 401: credentials rejected" : status === 403 ? "HTTP 403: forbidden" : `HTTP ${status}`;

// Resolves never; rejects with the signal's reason once it aborts, so a
// slow DNS lookup can't outlast the timeout.
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

export async function probe(check: UptimeCheck, opts: ProbeOptions = {}): Promise<UptimeSample> {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const start = now();
  const at = new Date(start).toISOString();
  const signal = AbortSignal.timeout(check.timeoutMs);
  const down = (error: string, status?: number, ms = now() - start): UptimeSample => ({
    at,
    ms: Math.max(0, Math.round(ms)),
    ...(status !== undefined && { status }),
    outcome: "down",
    error,
  });

  let url = check.url;
  try {
    for (let hop = 0; ; hop++) {
      const refusal = await Promise.race([checkUrl(url, { lookup: opts.lookup }), aborted(signal)]);
      if (refusal) return down(hop === 0 ? refusal : `redirect to ${url} refused: ${refusal}`);

      const res = await fetchFn(url, {
        method: "GET",
        redirect: "manual",
        signal,
        cache: "no-store",
        headers: headersFor(check, url),
      });
      const ms = now() - start;
      // Headers are all a check needs; cancelling frees the connection.
      res.body?.cancel().catch(() => {});

      const location = res.headers.get("location");
      if (redirects.has(res.status) && location) {
        if (hop >= MAX_REDIRECTS) return down("too many redirects", undefined, ms);
        url = new URL(location, url).href;
        continue;
      }

      const { min, max } = check.expectedStatus;
      if (res.status < min || res.status > max) return down(badStatus(res.status), res.status, ms);
      return { at, ms: Math.round(ms), status: res.status, outcome: ms > check.slowMs ? "slow" : "ok" };
    }
  } catch (err) {
    if (signal.aborted) return down(`timeout after ${check.timeoutMs} ms`, undefined, check.timeoutMs);
    return down(failure(err));
  }
}
