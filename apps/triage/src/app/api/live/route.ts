import { connection } from "next/server";
import { z } from "zod";
import { liveSnapshot } from "@/lib/live/snapshot";
import { liveWindows } from "@/lib/live/types";

const querySchema = z.object({
  service: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  window: z.enum(liveWindows.map((w) => w.id)).default("5m"),
});

// A service's last few minutes, summarized, for the live page to poll.
export async function GET(req: Request) {
  await connection();
  const params = new URL(req.url).searchParams;
  const parsed = querySchema.safeParse({
    service: params.get("service") ?? undefined,
    window: params.get("window") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid query" }, { status: 400 });
  return Response.json(await liveSnapshot(parsed.data.service, parsed.data.window), {
    headers: { "cache-control": "no-store" },
  });
}
