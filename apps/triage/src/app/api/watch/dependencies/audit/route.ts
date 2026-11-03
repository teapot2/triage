import { auditNow, dependencyState } from "@/lib/investigation/dependencies";

// Audit now: runs the audit whatever the schedule (joining one already
// running) and answers once it has finished. A failed audit is still a 200:
// its error is on the audit.
export async function POST() {
  const audit = await auditNow();
  return Response.json({ audit, state: dependencyState() });
}
