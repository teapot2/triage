import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import type { Incident, Mitigation } from "../schema";
import { judgeWindow, simulatedWindow } from "../verify";
import { executorFor, shopfrontOps, simulated, simulatedRecovery } from "./executors";

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

describe("simulatedRecovery", () => {
  // Every bundled example a person can approve a mitigation on.
  const approvable = exampleIncidents.filter((i) => i.mitigation?.state === "proposed");

  it("covers the examples with a proposed mitigation", () => {
    assert.deepEqual(approvable.map((i) => i.id), ["inc_pool_leak", "inc_price_gap", "inc_live_ratings"]);
  });

  for (const example of approvable) {
    it(`recovers ${example.id} under its own limit, then verifies`, () => {
      const recovery = simulatedRecovery(example);
      assert.equal(recovery.status, "recovered");
      assert.equal(recovery.metric, example.trigger.metric);
      assert.equal(recovery.threshold, example.trigger.threshold);
      assert.equal(recovery.since, example.trigger.series.at(-1)!.t);
      // What the verification replays after the recovery stays under it too.
      const incident = { ...example, mitigation: { ...example.mitigation!, state: "applied", recovery } } as Incident;
      const window = simulatedWindow(incident, { since: recovery.recoveredAt!, threshold: recovery.threshold, windowMinutes: 5 });
      assert.equal(judgeWindow(window, recovery.threshold, 5).kind, "resolved");
    });
  }

  it("replays the price gap's own recovery, not the pool leak's", () => {
    const priceGap = approvable.find((i) => i.id === "inc_price_gap")!;
    assert.ok(simulatedRecovery(priceGap).series.every((p) => p.value < priceGap.trigger.threshold));
  });

  it("follows a scenario run's source", () => {
    const poolLeak = approvable.find((i) => i.id === "inc_pool_leak")!;
    const run = { source: "scenario:price-gap" } as Incident["run"];
    const values = simulatedRecovery({ ...poolLeak, id: "inc_replay", run }).series.map((p) => p.value);
    assert.deepEqual(values, [0, 0, 0, 0, 0, 0]);
  });
});

describe("executorFor", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const shopfront = process.env.SHOPFRONT_URL ?? "http://localhost:3001";
  const flagOff: Mitigation = {
    ...rollback,
    kind: "flag_off",
    target: "FF_LIST_PRICES",
    branch: undefined,
    steps: ["Turn off FF_LIST_PRICES on shopfront"],
  };
  // An incident an uptime check opened, on the check's own metric and URL.
  const uptime = (url: string) =>
    ({
      id: "inc_uptime",
      service: "shopfront",
      run: { source: "uptime:chk_shop01" },
      trigger: { metric: "uptime.availability{check=chk_shop01}", threshold: 100, route: url, series: [] },
      detectedAt: "2026-11-03T10:00:00.000Z",
      mitigation: flagOff,
    }) as unknown as Incident;

  it("runs a check of Shopfront's mitigation on Shopfront, not as a replay", async () => {
    const incident = uptime(`${shopfront}/api/health`);
    assert.equal(executorFor(incident), shopfrontOps);
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return json(200, { flags: [{ name: "FF_LIST_PRICES", enabled: false }] });
    }) as typeof fetch;
    const result = await executorFor(incident).apply(incident);
    assert.deepEqual(result, { output: "FF_LIST_PRICES off" });
    assert.equal(result.recovery, undefined, "the recovery is watched on the check's results, not replayed");
    assert.deepEqual(calls, [{ url: `${shopfront}/api/ops`, body: { action: "flag", name: "FF_LIST_PRICES", enabled: false } }]);
  });

  it("changes nothing behind an external endpoint, and says so", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return json(200, {});
    }) as typeof fetch;
    const incident = uptime("https://www.example.com/");
    await assert.rejects(executorFor(incident).apply(incident), { message: "Triage can't change anything behind https://www.example.com/" });
    assert.equal(called, false);
  });

  it("applies a live run on Shopfront and simulates only recorded runs", () => {
    const run = (source?: string) => ({ ...incident(flagOff), run: source ? { source } : undefined }) as Incident;
    assert.equal(executorFor(run("live:shopfront")), shopfrontOps);
    assert.equal(executorFor(run("scenario:pool-leak")), simulated);
    assert.equal(executorFor(run("demo")), simulated);
    assert.equal(executorFor(run()), simulated);
    for (const example of exampleIncidents) assert.equal(executorFor(example), simulated);
  });
});
