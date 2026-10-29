import { getScenario } from "../scenarios";
import { poolLeak } from "../scenarios/pool-leak";
import type { Incident, Recovery } from "../schema";

// Runs an approved mitigation against the service it targets.
export interface Executor {
  apply(incident: Incident): Promise<{ output: string; recovery?: Recovery }>;
}

const shopfrontUrl = process.env.SHOPFRONT_URL ?? "http://localhost:3001";

type OpsState = { flags: { name: string; enabled: boolean }[]; released?: number };

async function ops(body: object): Promise<OpsState> {
  const url = `${shopfrontUrl}/api/ops`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`Couldn't reach Shopfront at ${url}`);
  }
  if (res.status === 404) throw new Error("Shopfront's ops API is off; set OPS_ENABLED=1");
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopfront's ops API answered ${res.status}: ${json.error ?? res.statusText}`);
  return json;
}

// The running store, through its ops API. Recovery is left to the watch.
export const shopfrontOps: Executor = {
  async apply(incident) {
    const m = incident.mitigation!;
    if (m.kind === "rollback") throw new Error("no deploy pipeline on this source");
    const state = await ops({ action: "flag", name: m.target, enabled: false });
    if (state.flags.find((f) => f.name === m.target)?.enabled !== false) {
      throw new Error(`Shopfront didn't turn ${m.target} off`);
    }
    if (!m.steps.some((s) => s.startsWith("Recycle pooled connections"))) return { output: `${m.target} off` };
    const { released = 0 } = await ops({ action: "release" });
    return { output: `${m.target} off; ${released} held connection${released === 1 ? "" : "s"} released` };
  },
};

// Scenario replays and the bundled examples: nothing to change, so the
// scenario's recorded recovery stands in, re-timed to follow the trigger's
// series (the example's series ends later than its scenario's clock).
export const simulated: Executor = {
  async apply(incident) {
    await new Promise((r) => setTimeout(r, 2000));
    const { trigger, run } = incident;
    const scenarioId = run?.source.startsWith("scenario:") ? run.source.slice("scenario:".length) : undefined;
    const recorded = (scenarioId && getScenario(scenarioId)?.recovery) || poolLeak.recovery!;
    const since = trigger.series.at(-1)?.t ?? incident.detectedAt;
    const series = recorded.map((p, i) => ({ t: new Date(Date.parse(since) + (i + 1) * 60_000).toISOString(), value: p.value }));
    const recoveredAt = series.find((p) => p.value < trigger.threshold)?.t;
    return {
      output: "Simulated on a recorded incident: nothing was changed",
      recovery: {
        metric: trigger.metric,
        threshold: trigger.threshold,
        since,
        series,
        status: recoveredAt ? "recovered" : "not_recovered",
        recoveredAt,
      },
    };
  },
};
