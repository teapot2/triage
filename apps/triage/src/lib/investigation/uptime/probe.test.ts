import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Lookup } from "./guard";
import { defaultCheck } from "./model";
import { probe } from "./probe";

const check = defaultCheck({ id: "chk_abc123", name: "Example", url: "https://example.com/" });
const publicLookup: Lookup = async () => [{ address: "93.184.216.34" }];
// The refusals below assume the local-target override is off.
delete process.env.TRIAGE_UPTIME_ALLOW_PRIVATE;

// A fake fetch over a fake clock: each URL answers with a status (and
// headers) after `ms`, and every call is recorded.
function fakeFetch(routes: Record<string, { status: number; ms: number; headers?: Record<string, string> }>) {
  let clock = Date.parse("2026-10-30T12:00:00.000Z");
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    clock += route.ms;
    return new Response(route.status === 204 || route.status >= 300 ? null : "body", { status: route.status, headers: route.headers });
  }) as typeof globalThis.fetch;
  return { fetch, now: () => clock, calls, lookup: publicLookup };
}

describe("probe", () => {
  it("records a fast answer in range as ok", async () => {
    const f = fakeFetch({ "https://example.com/": { status: 200, ms: 184 } });
    const sample = await probe(check, f);
    assert.deepEqual(sample, { at: "2026-10-30T12:00:00.000Z", ms: 184, status: 200, outcome: "ok" });
    const init = f.calls[0].init;
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    assert.deepEqual(init?.headers, { "user-agent": "Triage uptime check", accept: "*/*" });
    assert.ok(init?.signal instanceof AbortSignal);
  });

  it("records an answer in range past the slow limit as slow", async () => {
    const f = fakeFetch({ "https://example.com/": { status: 200, ms: 12_000 } });
    assert.deepEqual(await probe(check, f), { at: "2026-10-30T12:00:00.000Z", ms: 12_000, status: 200, outcome: "slow" });
  });

  it("records a status out of range as down, however fast", async () => {
    const f = fakeFetch({ "https://example.com/": { status: 503, ms: 40 } });
    assert.deepEqual(await probe(check, f), { at: "2026-10-30T12:00:00.000Z", ms: 40, status: 503, outcome: "down", error: "HTTP 503" });
  });

  it("records a timeout as down, its time the timeout", async () => {
    const quick = { ...check, timeoutMs: 30 };
    const fetch = ((_: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof globalThis.fetch;
    const sample = await probe(quick, { fetch, lookup: publicLookup });
    assert.equal(sample.outcome, "down");
    assert.equal(sample.ms, 30);
    assert.equal(sample.error, "timeout after 30 ms");
    assert.equal(sample.status, undefined);
  });

  it("records a connection failure by its code", async () => {
    const f = fakeFetch({});
    const sample = await probe(check, f);
    assert.equal(sample.outcome, "down");
    assert.equal(sample.error, "ENOTFOUND");
  });

  it("follows a redirect and judges the final answer, timed from the start", async () => {
    const f = fakeFetch({
      "https://example.com/": { status: 301, ms: 50, headers: { location: "/home" } },
      "https://example.com/home": { status: 200, ms: 100 },
    });
    assert.deepEqual(await probe(check, f), { at: "2026-10-30T12:00:00.000Z", ms: 150, status: 200, outcome: "ok" });
    assert.deepEqual(
      f.calls.map((c) => c.url),
      ["https://example.com/", "https://example.com/home"],
    );
  });

  it("refuses a redirect to a private host without requesting it", async () => {
    const f = fakeFetch({ "https://example.com/": { status: 302, ms: 20, headers: { location: "http://10.0.0.1/admin" } } });
    const sample = await probe(check, f);
    assert.equal(sample.outcome, "down");
    assert.match(sample.error ?? "", /^redirect to http:\/\/10\.0\.0\.1\/admin refused: 10\.0\.0\.1 is a private address/);
    assert.equal(f.calls.length, 1);
  });

  it("gives up after five redirects", async () => {
    const routes: Parameters<typeof fakeFetch>[0] = {};
    for (let i = 0; i < 7; i++) routes[`https://example.com/${i || ""}`] = { status: 302, ms: 10, headers: { location: `/${i + 1}` } };
    const sample = await probe(check, fakeFetch(routes));
    assert.equal(sample.outcome, "down");
    assert.equal(sample.error, "too many redirects");
  });

  it("sends the auth header to the check's origin only, not along a redirect elsewhere", async () => {
    const secured = { ...check, auth: { header: "Authorization", value: "Bearer t0k3n" } };
    const f = fakeFetch({
      "https://example.com/": { status: 302, ms: 10, headers: { location: "/v2" } },
      "https://example.com/v2": { status: 307, ms: 10, headers: { location: "https://status.example.net/" } },
      "https://status.example.net/": { status: 200, ms: 10 },
    });
    assert.equal((await probe(secured, f)).outcome, "ok");
    assert.deepEqual(
      f.calls.map((c) => (c.init?.headers as Record<string, string>).Authorization),
      ["Bearer t0k3n", "Bearer t0k3n", undefined],
    );
  });

  it("sends no header without a value, and names a rejected token", async () => {
    const f = fakeFetch({ "https://example.com/": { status: 401, ms: 20 } });
    const sample = await probe({ ...check, auth: { header: "Authorization" } }, f);
    assert.deepEqual(f.calls[0].init?.headers, { "user-agent": "Triage uptime check", accept: "*/*" });
    assert.deepEqual(sample, { at: "2026-10-30T12:00:00.000Z", ms: 20, status: 401, outcome: "down", error: "HTTP 401: credentials rejected" });
  });

  it("refuses the check's own URL before any request", async () => {
    const f = fakeFetch({});
    const sample = await probe({ ...check, url: "http://127.0.0.1:3000" }, f);
    assert.equal(sample.outcome, "down");
    assert.match(sample.error ?? "", /loopback/);
    assert.equal(f.calls.length, 0);
  });
});
