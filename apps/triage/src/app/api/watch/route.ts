import { z } from "zod";
import { startWatch, stopWatch, watchState } from "@/lib/investigation/watch";

// The live watch's state, for the sidebar to show and poll.
export function GET() {
  return Response.json(watchState());
}

const bodySchema = z.object({ enabled: z.boolean() });

// Pauses or resumes the watch. In memory: a restart starts it again.
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "expected { enabled: boolean }" }, { status: 400 });
  if (parsed.data.enabled) startWatch();
  else stopWatch();
  return Response.json(watchState());
}
