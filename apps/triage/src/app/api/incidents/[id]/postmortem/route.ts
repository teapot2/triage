import { after } from "next/server";
import { archivedRefusal, isArchived } from "@/lib/investigation/archive";
import { nextPostmortem, postmortemRefusal } from "@/lib/investigation/postmortem/rules";
import { writePostmortem } from "@/lib/investigation/postmortem/writer";
import { getIncident, patchIncident } from "@/lib/investigation/store";
import { readTemplate, runStageModel, stageProblem } from "@/lib/models/settings";

class Refused extends Error {}

// Starts writing the incident's blameless postmortem: saves the record as
// writing (replacing any earlier one) and answers 202; the model writes it
// after the response, and the incident shows it ready or failed.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incident = await getIncident(id);
  if (!incident) return Response.json({ error: `unknown incident: ${id}` }, { status: 404 });
  if (isArchived(incident)) return Response.json({ error: archivedRefusal }, { status: 409 });
  // A promoted re-run's own model, else Settings'.
  const stage = await runStageModel("postmortem", incident.models?.postmortem);
  const problem = stageProblem(stage);
  if (problem) return Response.json({ error: problem }, { status: 409 });

  // The template as it stands now: it shapes what is asked and is kept on
  // the record, so the page lays the draft out in its sections from the
  // start, and the postmortem renders as it was written.
  const template = await readTemplate();

  try {
    // Checked and saved under the incident's lock, so two quick POSTs can't
    // both start one.
    await patchIncident(id, (i) => {
      const refusal = isArchived(i) ? archivedRefusal : postmortemRefusal(i);
      if (refusal) throw new Refused(refusal);
      return { ...i, postmortem: { ...nextPostmortem(stage), template } };
    });
  } catch (err) {
    if (err instanceof Refused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }

  after(() => writePostmortem(id));
  return Response.json({ status: "writing" }, { status: 202 });
}
