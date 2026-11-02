import { after } from "next/server";
import { z } from "zod";
import { RerunRefused, runRerun, startRerun } from "@/lib/investigation/rerun";
import { runModelsSchema } from "@/lib/investigation/schema";

// A re-run is a whole investigation, plus a fix proven in the sandbox on a
// live incident; give it the same room as the first run.
export const maxDuration = 300;

const bodySchema = z.object({ models: runModelsSchema });

// Investigates the incident again with the models given for each stage, on
// the telemetry its first run read. Answers with the re-run's number right
// away; it runs after the response and is saved on the incident as it goes.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "expected { models }" }, { status: 400 });
  }
  try {
    const number = await startRerun(id, parsed.data.models);
    after(() => runRerun(id, number));
    return Response.json({ number }, { status: 202 });
  } catch (err) {
    if (err instanceof RerunRefused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
