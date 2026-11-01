import { generateText } from "ai";
import { connection } from "next/server";
import { callSettings, languageModel, modelErrorText, modelOptions, wakeProvider } from "@/lib/models/client";
import { providerIdSchema } from "@/lib/models/providers";
import { type Endpoint, endpointFor, type StageModel, stageIdSchema, stageModel, stageProblem } from "@/lib/models/settings";
import { reasoningEffortSchema, recordedEffort } from "@/lib/models/stages";

// Calls a model once ("pong") to check it answers: a stage's model
// (?stage=fix), or any provider and model (?provider=…&model=…, with
// &effort=… for Meta) before it's saved to a stage. May incur charges.
// The answer says what reasoning was asked for, as sent to the provider,
// and how many reasoning tokens it used, so an effort's change shows.
export async function GET(req: Request) {
  await connection();
  const params = new URL(req.url).searchParams;
  const stage = stageIdSchema.safeParse(params.get("stage"));
  const provider = providerIdSchema.safeParse(params.get("provider"));
  const modelId = params.get("model")?.trim();
  const effort = reasoningEffortSchema.optional().safeParse(params.get("effort") ?? undefined);
  if (!effort.success) return Response.json({ ok: false, error: "unknown effort" }, { status: 400 });

  let target: StageModel & Endpoint;
  if (stage.success) target = await stageModel(stage.data);
  else if (provider.success && modelId) target = { provider: provider.data, model: modelId, effort: effort.data, ...(await endpointFor(provider.data)) };
  else return Response.json({ ok: false, error: "expected ?stage= or ?provider=&model=" }, { status: 400 });

  const problem = stageProblem(target);
  if (problem) return Response.json({ ok: false, error: problem }, { status: 409 });
  try {
    // The 60 s budget is for the model's answer, not a cold host's start.
    // Retries happen within it, as on every model call (models/fetch.ts),
    // so a test fails in a minute rather than an attempt's 90 s times four.
    await wakeProvider(target);
    const { text, usage, request } = await generateText({
      model: languageModel(target),
      providerOptions: modelOptions(target),
      ...callSettings(),
      prompt: "Reply with the single word: pong",
      abortSignal: AbortSignal.timeout(60_000),
      include: { requestBody: true },
    });
    const body = request.body as { reasoning?: unknown } | undefined;
    return Response.json({
      ok: true,
      text,
      usage,
      provider: target.provider,
      model: target.model,
      effort: recordedEffort(target) ?? null,
      reasoning: body?.reasoning ?? null,
    });
  } catch (err) {
    return Response.json({ ok: false, error: modelErrorText(err, target.provider) }, { status: 502 });
  }
}
