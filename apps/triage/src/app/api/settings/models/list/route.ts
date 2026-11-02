import { connection } from "next/server";
import { listModels, Unreachable } from "@/lib/models/client";
import { providerIdSchema } from "@/lib/models/providers";
import { endpointFor } from "@/lib/models/settings";
import { errorMessage } from "@/lib/errors";

// The chat models one provider offers, for the model field's suggestions
// and the provider's status in Settings.
export async function GET(req: Request) {
  await connection();
  const provider = providerIdSchema.safeParse(new URL(req.url).searchParams.get("provider"));
  if (!provider.success) return Response.json({ error: "unknown provider" }, { status: 400 });
  try {
    return Response.json({ models: await listModels(provider.data, await endpointFor(provider.data)) });
  } catch (err) {
    const error = errorMessage(err);
    return Response.json({ error, unreachable: err instanceof Unreachable }, { status: 502 });
  }
}
