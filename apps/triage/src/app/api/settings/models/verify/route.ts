import { connection } from "next/server";
import { z } from "zod";
import { listModels, Unreachable, WAKE_TIMEOUT_MS } from "@/lib/models/client";
import { providerIdSchema, providers } from "@/lib/models/providers";
import { endpointFor } from "@/lib/models/settings";

// Tests an endpoint before it's saved: lists the models at a draft base URL
// with a draft key. Absent fields fall back to what's saved, though the saved
// key only while the URL is the saved one, and a hosted provider is always
// tested as configured. Listing models is free.
const verifySchema = z.object({
  provider: providerIdSchema,
  // A URL, or "" for the provider's default.
  baseUrl: z.url().or(z.literal("")).optional(),
  apiKey: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  await connection();
  const parsed = verifySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, { status: 400 });

  const { provider, baseUrl, apiKey } = parsed.data;
  const info = providers[provider];
  const saved = await endpointFor(provider);
  let endpoint = saved;
  if (info.configurable) {
    const url = (baseUrl === undefined ? saved.baseUrl : baseUrl || info.baseUrl).replace(/\/+$/, "");
    // The saved key goes only to the saved URL, never to a draft one.
    endpoint = { baseUrl: url, apiKey: apiKey || (url === saved.baseUrl ? saved.apiKey : undefined) };
  }
  if (!endpoint.baseUrl) return Response.json({ error: "Enter a base URL." }, { status: 400 });

  try {
    // A host that scales to zero is waited for, so testing it wakes it
    // rather than reporting it unreachable after a few seconds.
    return Response.json({ models: await listModels(provider, endpoint, info.coldStart ? WAKE_TIMEOUT_MS : undefined) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return Response.json({ error, unreachable: err instanceof Unreachable }, { status: 502 });
  }
}
