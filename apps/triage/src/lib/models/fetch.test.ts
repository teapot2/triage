import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelCallError, type RetryInfo, retryingFetch } from "./fetch";
import { RunTimeoutError, runBudget } from "./policy";

const policy = { label: "Meta's API", attempts: 4, attemptMs: 1_000, baseDelayMs: 1_000, maxRetryAfterMs: 30_000 };
const body = JSON.stringify({ model: "muse-spark-1.3", input: "hi" });

// A fetch that answers each call with the next of `answers`: a status, a
// Response, an error to throw, or "hang" (never answers until aborted).
function fakeFetch(answers: (number | Response | Error | "hang")[]) {
  const calls: RequestInit[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next === "hang") {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
      );
    }
    if (next instanceof Error) throw next;
    return typeof next === "number" ? new Response(next === 200 ? '{"ok":true}' : "busy", { status: next }) : next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function harness(answers: Parameters<typeof fakeFetch>[0], over: Partial<typeof policy> = {}) {
  const { fetch, calls } = fakeFetch(answers);
  const waits: number[] = [];
  const retries: RetryInfo[] = [];
  const wrapped = retryingFetch(
    { ...policy, ...over },
    {
      fetch,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
      onRetry: (info) => retries.push(info),
    },
  );
  return { call: (init: RequestInit = {}) => wrapped("https://api.example/v1/responses", { method: "POST", body, ...init }), calls, waits, retries };
}

describe("retryingFetch", () => {
  it("retries a 503 with jittered, doubling waits and returns the answer", async () => {
    const h = harness([503, 503, 200]);
    const res = await h.call();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(h.calls.length, 3);
    // random 0.5 of a 1 s, then 2 s window.
    assert.deepEqual(h.waits, [500, 1000]);
    assert.deepEqual(
      h.retries.map((r) => [r.attempt, r.reason]),
      [
        [1, "HTTP 503"],
        [2, "HTTP 503"],
      ],
    );
  });

  it("gives up after its attempts with a readable error", async () => {
    const h = harness([500]);
    await assert.rejects(h.call(), (err: unknown) => {
      assert.ok(err instanceof ModelCallError);
      assert.equal(err.message, "Meta's API answered HTTP 500 (4 tries).");
      assert.equal(err.attempts, 4);
      assert.equal(err.status, 500);
      return true;
    });
    assert.equal(h.calls.length, 4);
  });

  it("waits a 429's retry-after, and fails at once when it's too long", async () => {
    const short = harness([new Response("", { status: 429, headers: { "retry-after": "2" } }), 200]);
    assert.equal((await short.call()).status, 200);
    assert.deepEqual(short.waits, [2000]);

    const long = harness([new Response("", { status: 429, headers: { "retry-after": "120" } })]);
    await assert.rejects(long.call(), /rate-limiting this key: HTTP 429, retry after 120 s/);
    assert.equal(long.calls.length, 1);
  });

  it("passes other errors straight through for the SDK to read", async () => {
    const h = harness([new Response('{"error":{"message":"bad key"}}', { status: 401 })]);
    const res = await h.call();
    assert.equal(res.status, 401);
    assert.equal(await res.text(), '{"error":{"message":"bad key"}}');
    assert.equal(h.calls.length, 1);
  });

  it("times out an attempt that never answers and tries again", async () => {
    const h = harness(["hang", 200], { attemptMs: 20 });
    assert.equal((await h.call()).status, 200);
    assert.equal(h.retries[0].reason, "no answer in 0 s");

    const dead = harness(["hang"], { attemptMs: 20, attempts: 2 });
    await assert.rejects(dead.call(), /^ModelCallError: Meta's API didn't answer within 0 s \(2 tries\)\.$/);
  });

  it("retries network errors, naming undici's code", async () => {
    const reset = Object.assign(new Error("other side closed"), { code: "ECONNRESET" });
    const h = harness([new TypeError("fetch failed", { cause: reset })], { attempts: 2 });
    await assert.rejects(h.call(), { message: "Couldn't reach Meta's API: connection reset (2 tries)." });
    assert.equal(h.calls.length, 2);

    const odd = Object.assign(new Error("odd"), { code: "EPROTO" });
    await assert.rejects(harness([new TypeError("fetch failed", { cause: odd })], { attempts: 1 }).call(), {
      message: "Couldn't reach Meta's API: EPROTO.",
    });
  });

  it("stops at once when the caller aborts, with the caller's reason", async () => {
    const budget = new AbortController();
    const h = harness(["hang"]);
    const pending = h.call({ signal: budget.signal });
    budget.abort(new RunTimeoutError("The investigation ran past its 10-minute limit."));
    await assert.rejects(pending, { name: "TimeoutError", message: "The investigation ran past its 10-minute limit." });
    assert.equal(h.calls.length, 1);
  });

  it("hands a stream over at its headers, before it ends", async () => {
    // Never closes: a stream still going.
    const stream = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("data: {}\n\n")) });
    const h = harness([new Response(stream, { status: 200 })]);
    const res = await h.call({ body: JSON.stringify({ stream: true }) });
    const first = await res.body!.getReader().read();
    assert.equal(new TextDecoder().decode(first.value), "data: {}\n\n");
  });

  it("fails a stream that sends nothing for an attempt's limit", async () => {
    const stream = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("event: response.created\n\n")) });
    const h = harness([new Response(stream, { status: 200 })], { attemptMs: 20 });
    const reader = (await h.call({ body: JSON.stringify({ stream: true }) })).body!.getReader();
    await reader.read();
    await assert.rejects(reader.read(), { name: "ModelCallError", message: "Meta's API stopped sending its answer for 0 s." });
  });
});

describe("runBudget", () => {
  it("aborts with a sentence naming the stage and its limit", async () => {
    const signal = runBudget("ask", 10);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(signal.aborted);
    assert.equal(signal.reason.message, "The answer ran past its 0-second limit.");
    assert.equal(signal.reason.name, "TimeoutError");
    assert.equal(runBudget("investigate").aborted, false);
  });
});
