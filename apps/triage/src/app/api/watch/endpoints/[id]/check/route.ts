import { CheckBusy, checkNow, UnknownCheck } from "@/lib/investigation/uptime";

// Runs the check now, out of turn, and answers with its result. While the
// watch is on, the result counts like any other: it can open or resolve.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json({ sample: await checkNow(id) });
  } catch (err) {
    if (err instanceof UnknownCheck) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof CheckBusy) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
