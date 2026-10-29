import { generateText } from "ai";
import { connection } from "next/server";
import { languageModel, modelOptions, wakeProvider } from "@/lib/models/client";
import { providerIdSchema } from "@/lib/models/providers";
import { endpointFor, stageIdSchema, stageModel, stageProblem } from "@/lib/models/settings";

// Calls a model once ("pong") to check it answers: a stage's model
// (?stage=fix), or any provider and model (?provider=…&model=…) before
// it's saved to a stage. May incur charges.
export async function GET(req: Request) {
  await connection();
  const params = new URL(req.url).searchParams;
  const stage = stageIdSchema.safeParse(params.get("stage"));
  const provider = providerIdSchema.safeParse(params.get("provider"));
  const modelId = params.get("model")?.trim();

  let target;
  if (stage.success) target = await stageModel(stage.data);
  else if (provider.success && modelId) target = { provider: provider.data, model: modelId, ...(await endpointFor(provider.data)) };
  else return Response.json({ ok: false, error: "expected ?stage= or ?provider=&model=" }, { status: 400 });

  const problem = stageProblem(target);
  if (problem) return Response.json({ ok: false, error: problem }, { status: 409 });
  try {
    // The 60 s budget is for the model's answer, not a cold host's start.
    await wakeProvider(target);
    const { text, usage } = await generateText({
      model: languageModel(target),
      providerOptions: modelOptions(target),
      prompt: "Reply with the single word: pong",
      abortSignal: AbortSignal.timeout(60_000),
    });
    return Response.json({ ok: true, text, usage, provider: target.provider, model: target.model });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error }, { status: 502 });
  }
}
