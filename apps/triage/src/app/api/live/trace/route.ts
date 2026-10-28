import { connection } from "next/server";
import { liveTrace } from "@/lib/live/trace";

// One request's spans, from the collector's files, for the live page's
// trace view.
export async function GET(req: Request) {
  await connection();
  const traceId = new URL(req.url).searchParams.get("traceId") ?? "";
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return Response.json({ error: "expected a 32-character hex traceId" }, { status: 400 });
  const trace = await liveTrace(traceId);
  if (!trace) return Response.json({ error: "No spans for this trace. It may have aged out of the last 3 hours." }, { status: 404 });
  return Response.json(trace, { headers: { "cache-control": "no-store" } });
}
