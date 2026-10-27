import { connection } from "next/server";
import { listModels } from "@/lib/models/client";
import { providerIdSchema } from "@/lib/models/providers";
import { endpointFor } from "@/lib/models/settings";

// The chat models one provider offers, for the model field's suggestions.
export async function GET(req: Request) {
  await connection();
  const provider = providerIdSchema.safeParse(new URL(req.url).searchParams.get("provider"));
  if (!provider.success) return Response.json({ error: "unknown provider" }, { status: 400 });
  try {
    return Response.json({ models: await listModels(provider.data, await endpointFor(provider.data)) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
