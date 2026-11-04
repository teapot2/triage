import { z } from "zod";
import { recheckUptime } from "@/lib/investigation/uptime";
import { checksSchema, publicCheck, readChecks, saveChecks, slowLimitRefusal, withSavedSecrets } from "@/lib/investigation/uptime/checks";
import { checkUrl } from "@/lib/investigation/uptime/guard";
import { deleteSamples } from "@/lib/investigation/uptime/samples";

// The uptime checks: the URLs Triage requests itself. None until any are
// saved. A check's auth header goes out by name only; its value stays here.
export async function GET() {
  return Response.json({ checks: (await readChecks()).map(publicCheck) });
}

const bodySchema = z.object({ checks: checksSchema });

// Replaces the whole list, saved on the server. A check whose auth header
// came without its value (the browser never had it) gets the saved one
// back, while it targets the same origin. A new or changed slow limit has to
// be under its check's timeout (one saved equal before loads and stays as
// it is). Every URL passes the guard next (a
// check is a request from this server, so no private addresses); a refusal
// names the check and why. The loop runs what is due right away. A removed
// check's samples go with it, and so do those of a check pointed at another
// URL: the old target's results would otherwise judge the new.
export async function PUT(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const before = await readChecks().catch(() => []);
  const merged = withSavedSecrets(parsed.data.checks, before);
  if (!merged.checks) return Response.json({ error: merged.problem }, { status: 400 });
  const { checks } = merged;
  const slowLimit = slowLimitRefusal(checks, before);
  if (slowLimit) return Response.json({ error: slowLimit }, { status: 400 });
  const refusals = await Promise.all(checks.map((c) => checkUrl(c.url)));
  const refused = checks.findIndex((_, i) => refusals[i]);
  if (refused >= 0) {
    return Response.json({ error: `${checks[refused].name}: ${refusals[refused]}` }, { status: 400 });
  }
  await saveChecks(checks);
  const next = new Map(checks.map((c) => [c.id, c]));
  const stale = before.filter((c) => next.get(c.id)?.url !== c.url);
  await Promise.all(stale.map((c) => deleteSamples(c.id)));
  recheckUptime();
  return Response.json({ checks: checks.map(publicCheck) });
}
