import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Incident, Mitigation } from "../schema";
import { shopfrontOps } from "./executors";

const rollback: Mitigation = {
  kind: "rollback",
  target: "9f3c2a1",
  branch: "shopfront-release/formatted-price",
  title: "Roll back shopfront to the deploy before 9f3c2a1",
  why: { text: "The symptom began after 9f3c2a1 was deployed to shopfront.", evidenceIds: ["ev_commit_1"] },
  steps: ["Roll back 9f3c2a1 on shopfront"],
  undo: "Redeploy 9f3c2a1",
  risk: "low",
  state: "running",
  proposedAt: "2026-11-01T12:00:00.000Z",
};

const incident = (mitigation: Mitigation) => ({ id: "inc_test", service: "shopfront", mitigation }) as unknown as Incident;

const release = { name: "formatted-price", sha: "9f3c2a1", branch: "shopfront-release/formatted-price", previous: "e50f949" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Stands in for Shopfront's ops API: GET answers the state, POST applies the
// action and answers the state after it. Every call is kept for the asserts.
function stubOps(state: { release: typeof release | null }, opts: { afterRollback?: typeof release | null; status?: number } = {}) {
  const calls: { method: string; body?: unknown }[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    if (opts.status) return json(opts.status, { error: "ops disabled" });
    if (method === "GET") return json(200, { flags: [], ...state });
    if (body?.action === "rollback") {
      if (!state.release) return json(409, { error: "nothing is deployed" });
      return json(200, { flags: [], release: opts.afterRollback ?? null });
    }
    return json(400, { error: `unknown action ${body?.action}` });
  }) as typeof fetch;
  return calls;
}

describe("shopfrontOps rollback", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts a rollback and reports the sha once the store has no release", async () => {
    const calls = stubOps({ release });
    const result = await shopfrontOps.apply(incident(rollback));
    assert.deepEqual(result, { output: "rolled back 9f3c2a1" });
    assert.deepEqual(calls, [{ method: "GET", body: undefined }, { method: "POST", body: { action: "rollback" } }]);
  });

  it("says so when the deployed release isn't the one the mitigation named", async () => {
    stubOps({ release: { ...release, sha: "1234abc" } });
    const result = await shopfrontOps.apply(incident(rollback));
    assert.equal(result.output, "rolled back 1234abc; the mitigation named 9f3c2a1");
  });

  it("fails when the release is still deployed afterwards", async () => {
    stubOps({ release }, { afterRollback: release });
    await assert.rejects(shopfrontOps.apply(incident(rollback)), { message: "Shopfront still has 9f3c2a1 deployed" });
  });

  it("fails when nothing is deployed, without posting", async () => {
    const calls = stubOps({ release: null });
    await assert.rejects(shopfrontOps.apply(incident(rollback)), { message: "Nothing is deployed on Shopfront to roll back" });
    assert.equal(calls.length, 1);
  });

  it("keeps the ops-off message when the API answers 404", async () => {
    stubOps({ release }, { status: 404 });
    await assert.rejects(shopfrontOps.apply(incident(rollback)), { message: "Shopfront's ops API is off; set OPS_ENABLED=1" });
  });

  it("leaves the flag path as it was", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return json(200, { flags: [{ name: "FF_LIST_PRICES", enabled: false }] });
    }) as typeof fetch;
    const flagOff: Mitigation = { ...rollback, kind: "flag_off", target: "FF_LIST_PRICES", branch: undefined, steps: ["Turn off FF_LIST_PRICES on shopfront"] };
    assert.deepEqual(await shopfrontOps.apply(incident(flagOff)), { output: "FF_LIST_PRICES off" });
    assert.deepEqual(calls, [{ action: "flag", name: "FF_LIST_PRICES", enabled: false }]);
  });
});
