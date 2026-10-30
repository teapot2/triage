// Opens an uptime incident and investigates it end to end, without the
// loop: the check on its own, or Triage's results joined with Shopfront's.
//
//   pnpm --filter @triage/web check:uptime google
//     Fabricated down samples (timeouts and 503s for 6 min) on a check of
//     https://www.google.com/. Expect an inconclusive verdict naming
//     application telemetry as missing, citing the check's results.
//
//   TRIAGE_UPTIME_ALLOW_PRIVATE=1 pnpm --filter @triage/web check:uptime shopfront
//     Probes http://localhost:3001/api/health for real (6 checks, 5 s apart),
//     so plant the pool-leak fault on /ops with traffic on first. Expect a
//     root cause on Shopfront with a mitigation, then the fix stage.
//
// Needs MODEL_API_KEY in .env.local. Saves the samples under .data/uptime
// (no check is saved, so nothing joins the Watch list) and the incident
// under .data/incidents; prints its id and verdict.

import { runInvestigation } from "../src/lib/investigation/agent";
import { createUptimeIncident } from "../src/lib/investigation/uptime/incident";
import { defaultCheck, newCheckId, type UptimeSample } from "../src/lib/investigation/uptime/model";
import { probe } from "../src/lib/investigation/uptime/probe";
import { appendSample } from "../src/lib/investigation/uptime/samples";
import { createUptimeSource } from "../src/lib/investigation/uptime/source";

const SECOND = 1000;

// Ok for 4 min, then down for 6: mostly timeouts, a 503 every third check.
function fabricated(now: number): UptimeSample[] {
  return Array.from({ length: 20 }, (_, i): UptimeSample => {
    const at = new Date(now - (19 - i) * 30 * SECOND).toISOString();
    if (i < 8) return { at, ms: 150 + ((i * 37) % 60), status: 200, outcome: "ok" };
    if (i % 3 === 0) return { at, ms: 60, status: 503, outcome: "down", error: "HTTP 503" };
    return { at, ms: 15_000, outcome: "down", error: "timeout after 15000 ms" };
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "google" && mode !== "shopfront") throw new Error("usage: check-uptime.ts google|shopfront");

  const shopfront = process.env.SHOPFRONT_URL ?? "http://localhost:3001";
  const check =
    mode === "google"
      ? defaultCheck({ id: newCheckId(), name: "Google", url: "https://www.google.com/" })
      : defaultCheck({ id: newCheckId(), name: "Shopfront health", url: `${shopfront}/api/health`, slowMs: 2000, downMinutesToOpen: 1 });

  let samples: UptimeSample[] = [];
  if (mode === "google") {
    for (const s of fabricated(Date.now())) samples = await appendSample(check.id, s);
  } else {
    for (let i = 0; i < 6; i++) {
      if (i) await new Promise((r) => setTimeout(r, 5 * SECOND));
      const s = await probe(check);
      console.log(`  ${s.at} ${s.outcome} ${s.status ?? "-"} ${s.ms} ms${s.error ? ` (${s.error})` : ""}`);
      samples = await appendSample(check.id, s);
    }
    if (samples.at(-1)?.outcome !== "down") throw new Error("Shopfront's health check isn't failing: plant the pool-leak fault on /ops first.");
  }

  const { source, appDir, service } = await createUptimeSource(check, samples);
  console.log(`source ${source.describe().id} · service ${service}${appDir ? ` · appDir ${appDir}` : ""}`);
  const incident = await createUptimeIncident(check, "down", samples, source);
  console.log(`incident ${incident.id}: ${incident.title} (${incident.trigger.metric} ${incident.trigger.observed} ${incident.trigger.unit})`);

  const done = await runInvestigation(incident, source, { appDir });
  const verdict = done.report?.verdict;
  console.log(`status ${done.status} · verdict ${verdict?.kind ?? "none"}${done.run?.error ? ` · error ${done.run.error}` : ""}`);
  if (verdict?.kind === "inconclusive") console.log(`missing: ${verdict.missing.join("; ")}`);
  if (verdict?.kind === "root_cause") {
    console.log(`root cause: ${done.report!.hypotheses.find((h) => h.id === verdict.hypothesisId)?.title}`);
  }
  console.log(`summary: ${done.report?.summary ?? "-"}`);
  console.log(`steps: ${done.steps.map((s) => s.tool).join(", ")}`);
  const cited = new Set(done.report?.hypotheses.flatMap((h) => Object.values(h.causalChain).flatMap((c) => c.evidenceIds)));
  console.log(`cited: ${done.evidence.filter((e) => cited.has(e.id)).map((e) => `${e.id} ${e.summary}`).join(" | ") || "-"}`);
  if (done.mitigation) console.log(`mitigation: ${done.mitigation.title} (${done.mitigation.state})`);
  if (done.fixRun) console.log(`fix stage: ${done.fixRun.status}`);
  console.log(`page: /incidents/${done.id}`);
}

main().catch((err) => {
  console.error(`check:uptime failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
