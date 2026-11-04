import { pastLimit } from "@/components/incident/metric-labels";
import { getScenario } from "../scenarios";
import { poolLeak } from "../scenarios/pool-leak";
import type { Incident, Recovery } from "../schema";
import { sourceKind } from "../source-kind";
import { targetsShopfront } from "../uptime/source";

// Runs an approved mitigation against the service it targets.
export interface Executor {
  apply(incident: Incident): Promise<{ output: string; recovery?: Recovery }>;
}

const shopfrontUrl = process.env.SHOPFRONT_URL ?? "http://localhost:3001";

export type OpsState = {
  flags: { name: string; enabled: boolean }[];
  released?: number;
  // The release the harness has deployed into the store, null when none.
  release?: { sha: string; branch?: string } | null;
};

// The ops API's state: read with no body, changed with an action.
async function ops(body?: object, signal?: AbortSignal): Promise<OpsState> {
  const url = `${shopfrontUrl}/api/ops`;
  let res: Response;
  try {
    res = body
      ? await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      : await fetch(url, { signal });
  } catch {
    throw new Error(`Couldn't reach Shopfront at ${url}`);
  }
  if (res.status === 404) throw new Error("Shopfront's ops API is off; set OPS_ENABLED=1");
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopfront's ops API answered ${res.status}: ${json.error ?? res.statusText}`);
  return json;
}

// The store's flags and deployed release now, for the watch (see
// mitigation/in-effect). Bounded, since a check waits on it.
export const readOpsState = () => ops(undefined, AbortSignal.timeout(3000));

// The running store, through its ops API. Recovery is left to the watch.
export const shopfrontOps: Executor = {
  async apply(incident) {
    const m = incident.mitigation!;
    if (m.kind === "rollback") return rollback(m.target);
    const state = await ops({ action: "flag", name: m.target, enabled: false });
    if (state.flags.find((f) => f.name === m.target)?.enabled !== false) {
      throw new Error(`Shopfront didn't turn ${m.target} off`);
    }
    if (!m.steps.some((s) => s.startsWith("Recycle pooled connections"))) return { output: `${m.target} off` };
    const { released = 0 } = await ops({ action: "release" });
    return { output: `${m.target} off; ${released} held connection${released === 1 ? "" : "s"} released` };
  },
};

// The harness reverse-applies whatever release is deployed, so the state is
// read first: to name what was rolled back, and to say so when it isn't the
// release the mitigation blamed (the store still went back to the code
// before it, so that's not a failure).
async function rollback(target: string): Promise<{ output: string }> {
  const deployed = (await ops()).release;
  if (!deployed) throw new Error("Nothing is deployed on Shopfront to roll back");
  const after = await ops({ action: "rollback" });
  if (after.release) throw new Error(`Shopfront still has ${after.release.sha} deployed`);
  return { output: deployed.sha === target ? `rolled back ${deployed.sha}` : `rolled back ${deployed.sha}; the mitigation named ${target}` };
}

// The bundled examples have no run, so each names the scenario it was
// recorded from. Anything else without one (the demo, a pool-leak copy)
// falls back to the pool leak.
const exampleScenarios: Record<string, string> = {
  inc_pool_leak: "pool-leak",
  inc_price_gap: "price-gap",
  inc_live_ratings: "live-ratings",
  inc_bad_deploy: "bad-deploy",
};

// Scenario replays and the bundled examples: nothing to change, so the
// scenario's recorded recovery stands in, re-timed to follow the trigger's
// series (the example's series ends later than its scenario's clock). It
// stays on that clock rather than the apply time: the chart draws it after
// the trigger's series, and days of empty minutes would sit in between.
export function simulatedRecovery(incident: Incident): Recovery {
  const { trigger, run } = incident;
  const scenarioId = run?.source.startsWith("scenario:") ? run.source.slice("scenario:".length) : exampleScenarios[incident.id];
  const recorded = (scenarioId && getScenario(scenarioId)?.recovery) || poolLeak.recovery!;
  const since = trigger.series.at(-1)?.t ?? incident.detectedAt;
  const series = recorded.map((p, i) => ({ t: new Date(Date.parse(since) + (i + 1) * 60_000).toISOString(), value: p.value }));
  const past = pastLimit(trigger.metric, trigger.threshold);
  const recoveredAt = series.find((p) => !past(p.value))?.t;
  return {
    metric: trigger.metric,
    threshold: trigger.threshold,
    since,
    series,
    status: recoveredAt ? "recovered" : "not_recovered",
    recoveredAt,
  };
}

export const simulated: Executor = {
  async apply(incident) {
    await new Promise((r) => setTimeout(r, 2000));
    return { output: "Simulated on a recorded incident: nothing was changed", recovery: simulatedRecovery(incident) };
  },
};

// What can't be changed from Triage: an endpoint check of somebody else's
// site, or anything else with neither a live service nor a recording.
const nothingToChange = (why: string): Executor => ({
  async apply() {
    throw new Error(why);
  },
});

// The executor for the incident, by what its run can actually touch: the
// live Shopfront, or an uptime check whose URL is on Shopfront's origin
// (its investigation read Shopfront's flags and deploys, so a mitigation it
// proposes is Shopfront's to apply). Recorded scenarios, the bundled
// examples and the demo are simulated. An external endpoint has nothing to
// change.
export function executorFor(incident: Incident): Executor {
  switch (sourceKind(incident)) {
    case "live":
      return shopfrontOps;
    case "uptime":
      return targetsShopfront({ url: incident.trigger.route ?? "" })
        ? shopfrontOps
        : nothingToChange(`Triage can't change anything behind ${incident.trigger.route ?? "this endpoint"}`);
    case "dependency":
      return nothingToChange("A dependency incident has no mitigation: its fix is the version bump");
    default:
      return simulated;
  }
}
