import { contextLimit } from "../../models/context";
import { isOpenWeights } from "../../models/providers";
import { choiceModel, stageModel } from "../../models/settings";
import { FULL_CONTEXT_MODEL, FULL_CONTEXT_WINDOW } from "./full-context";

// Which model a full-context answer runs on. Wonder on Meta's API, unless
// Settings' Ask stage runs open weights with a window that holds the whole
// bundle (Muse Spark Open's 1,048,576 on Baseten or OpenRouter): then that
// model, so a setup on open weights, with its "Open weights" and "Built with
// Muse Spark Open" badges, never quietly calls Meta's API for one feature.
// Undefined when neither is available. The composer's own model choice
// doesn't count: full context has no model picker.
export async function fullContextModel() {
  const ask = await stageModel("ask");
  if (isOpenWeights(ask.model) && (contextLimit(ask.provider, ask.model) ?? 0) >= FULL_CONTEXT_WINDOW) return ask;
  return choiceModel("ask", FULL_CONTEXT_MODEL);
}
