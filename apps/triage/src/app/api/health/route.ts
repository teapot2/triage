import { connection } from "next/server";
import { publicModelSettings, stageIds, stageModel, stageProblem } from "@/lib/models/settings";
import { recordedEffort } from "@/lib/models/stages";

// Each stage's provider, model and effort (Meta only), and whether it can
// run, without calling any model. `fanout`: whether investigations check
// hypotheses in parallel, so whether the Lead stage runs at all.
export async function GET() {
  await connection();
  const stages = Object.fromEntries(
    await Promise.all(
      stageIds.map(async (id) => {
        const s = await stageModel(id);
        return [
          id,
          {
            provider: s.provider,
            model: s.model,
            effort: recordedEffort(s) ?? null,
            baseUrl: s.baseUrl,
            problem: stageProblem(s) ?? null,
          },
        ];
      }),
    ),
  );
  const { fanout } = await publicModelSettings();
  return Response.json({ ok: true, fanout, stages });
}
