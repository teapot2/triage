import { connection } from "next/server";
import { publicModelSettings, updateModelSettings, updateSchema } from "@/lib/models/settings";

// Which model each stage uses, and the providers to choose from. Keys never
// leave the server; each provider says only whether it has one.
export async function GET() {
  await connection();
  return Response.json(await publicModelSettings());
}

export async function PUT(req: Request) {
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid settings" }, { status: 400 });
  return Response.json(await updateModelSettings(parsed.data));
}
