import { z } from "zod";
import { auditTarget, dependencyState, updateDependencySettings } from "@/lib/investigation/dependencies";
import { intervalChoices, MAX_INTERVAL_HOURS, MIN_INTERVAL_HOURS, severityFloors } from "@/lib/investigation/dependencies/model";
import { listAudits, listFindings } from "@/lib/investigation/dependencies/store";
import { getIncident } from "@/lib/investigation/store";

// The dependency audit for the Watch page: its state, the advisories the
// last audit that ran found (gone ones within a week too, folded on the
// page), the status of the incident each opened, and the recent audits.
export async function GET() {
  const state = dependencyState();
  const week = Date.now() - 7 * 86_400_000;
  const findings = listFindings(state.service, { gone: true }).filter((f) => !f.goneAt || Date.parse(f.goneAt) > week);
  const ids = [...new Set(findings.flatMap((f) => (f.incidentId ? [f.incidentId] : [])))];
  const incidents = Object.fromEntries(
    (await Promise.all(ids.map(getIncident))).flatMap((i) => (i ? [[i.id, i.status] as const] : [])),
  );
  return Response.json({ state, findings, incidents, audits: listAudits(state.service, 20), intervals: intervalChoices });
}

const patchSchema = z
  .object({
    enabled: z.boolean(),
    intervalHours: z.number().int().min(MIN_INTERVAL_HOURS).max(MAX_INTERVAL_HOURS),
    severityFloor: z.enum(severityFloors),
    serviceDir: z.string().max(1000),
  })
  .partial()
  .strict();

// Changes the settings; fields left out keep theirs.
export async function PATCH(req: Request) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const settings = await updateDependencySettings(parsed.data);
  return Response.json({ settings, target: auditTarget(settings), state: dependencyState() });
}
