import { after } from "next/server";
import { nextPostmortem, postmortemRefusal } from "@/lib/investigation/postmortem/rules";
import { writePostmortem } from "@/lib/investigation/postmortem/writer";
import { getIncident, patchIncident } from "@/lib/investigation/store";
import { stageModel, stageProblem } from "@/lib/models/settings";

class Refused extends Error {}

// Starts writing the incident's blameless postmortem: saves the record as
// writing (replacing any earlier one) and answers 202; the model writes it
// after the response, and the incident shows it ready or failed.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getIncident(id))) return Response.json({ error: `unknown incident: ${id}` }, { status: 404 });
  const stage = await stageModel("postmortem");
  const problem = stageProblem(stage);
  if (problem) return Response.json({ error: problem }, { status: 409 });

  try {
    // Checked and saved under the incident's lock, so two quick POSTs can't
    // both start one.
    await patchIncident(id, (i) => {
      const refusal = postmortemRefusal(i);
      if (refusal) throw new Refused(refusal);
      return { ...i, postmortem: nextPostmortem(stage) };
    });
  } catch (err) {
    if (err instanceof Refused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }

  after(() => writePostmortem(id));
  return Response.json({ status: "writing" }, { status: 202 });
}
