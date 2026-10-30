import { uptimeState } from "@/lib/investigation/uptime";
import { publicCheck, readChecks } from "@/lib/investigation/uptime/checks";
import { readSamples } from "@/lib/investigation/uptime/samples";

// One check for its page: the configuration (its auth header by name, the
// value stays here), its live state (undefined until the loop has read the
// list) and its last 50 results, newest last.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const check = (await readChecks()).find((c) => c.id === id);
  if (!check) return Response.json({ error: `unknown uptime check: ${id}` }, { status: 404 });
  const state = uptimeState().find((s) => s.id === id);
  const samples = (await readSamples(id)).slice(-50);
  return Response.json({ check: publicCheck(check), state, samples });
}
