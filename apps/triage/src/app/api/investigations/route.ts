import { after } from "next/server";
import { z } from "zod";
import { stageModel, stageProblem } from "@/lib/models/settings";
import { createLiveIncident, createScenarioIncident, runInvestigation } from "@/lib/investigation/agent";
import { createLiveSource, shopfrontDir } from "@/lib/investigation/live/live-source";
import { LIVE_ID } from "@/lib/investigation/options";
import { createScenarioSource, getScenario } from "@/lib/investigation/scenarios";

// A full run is ~10-25 model steps, plus the fix and its sandbox proof;
// give it room.
export const maxDuration = 300;

const bodySchema = z.object({ scenario: z.string() });

// Starts an investigation and returns its incident ID right away; the agent
// runs after the response and saves progress as it goes. `scenario` is a
// recorded scenario's ID, or "live" for the running Shopfront.
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "expected { scenario }" }, { status: 400 });
  const problem = stageProblem(await stageModel("investigate"));
  if (problem) return Response.json({ error: problem }, { status: 409 });

  if (parsed.data.scenario === LIVE_ID) {
    try {
      const source = await createLiveSource();
      const incident = await createLiveIncident(source);
      after(() => runInvestigation(incident, source, { appDir: shopfrontDir }));
      return Response.json({ id: incident.id }, { status: 202 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
    }
  }

  const scenario = getScenario(parsed.data.scenario);
  if (!scenario) return Response.json({ error: `unknown scenario: ${parsed.data.scenario}` }, { status: 404 });

  const incident = await createScenarioIncident(scenario);
  after(() => runInvestigation(incident, createScenarioSource(scenario)));
  return Response.json({ id: incident.id }, { status: 202 });
}
