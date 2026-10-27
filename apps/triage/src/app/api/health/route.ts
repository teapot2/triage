import { connection } from "next/server";
import { stageIds, stageModel, stageProblem } from "@/lib/models/settings";

// Each stage's provider and model, and whether it can run, without calling
// any model.
export async function GET() {
  await connection();
  const stages = Object.fromEntries(
    await Promise.all(
      stageIds.map(async (id) => {
        const s = await stageModel(id);
        return [id, { provider: s.provider, model: s.model, baseUrl: s.baseUrl, problem: stageProblem(s) ?? null }];
      }),
    ),
  );
  return Response.json({ ok: true, stages });
}
