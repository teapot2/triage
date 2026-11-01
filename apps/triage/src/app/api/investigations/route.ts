import { after } from "next/server";
import { z } from "zod";
import { investigationProblem } from "@/lib/models/settings";
import { createLiveIncident, createRangeIncident, createScenarioIncident, runInvestigation } from "@/lib/investigation/agent";
import { createLiveSource, shopfrontDir } from "@/lib/investigation/live/live-source";
import { LIVE_ID } from "@/lib/investigation/options";
import { createScenarioSource, getScenario } from "@/lib/investigation/scenarios";

// A full run is ~10-25 model steps, plus the fix and its sandbox proof;
// give it room.
export const maxDuration = 300;

const bodySchema = z.object({
  scenario: z.string(),
  // Live only: a range (and route) selected on the live telemetry page.
  focus: z
    .object({
      service: z.string().max(100).default("shopfront"),
      from: z.iso.datetime(),
      to: z.iso.datetime(),
      route: z.string().max(200).optional(),
    })
    .refine((f) => Date.parse(f.from) < Date.parse(f.to), "focus.from must be before focus.to")
    .optional(),
});

// Starts an investigation and returns its incident ID right away; the agent
// runs after the response and saves progress as it goes. `scenario` is a
// recorded scenario's ID, or "live" for the running Shopfront, optionally
// with a `focus` range from the live telemetry page.
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "expected { scenario }" }, { status: 400 });
  }
  const problem = await investigationProblem();
  if (problem) return Response.json({ error: problem }, { status: 409 });

  if (parsed.data.scenario === LIVE_ID) {
    try {
      const source = await createLiveSource();
      const { focus } = parsed.data;
      const incident = focus ? await createRangeIncident(source, focus) : await createLiveIncident(source);
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
