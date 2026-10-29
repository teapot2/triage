import { getScenario } from "./scenarios";
import type { Incident } from "./schema";

// Where a finished incident's telemetry can be read again, from the source
// its run recorded: a recorded scenario, rebuilt from its ID exactly as the
// investigation saw it, or the live Shopfront, anchored at the alert. The
// bundled examples (no run) and anything else have none. Apart from
// source-for so the incident page can tell which way a question will be
// answered without bundling the live source.
export function sourceKind(incident: Incident): "scenario" | "live" | undefined {
  const id = incident.run?.source ?? "";
  if (id.startsWith("scenario:")) return getScenario(id.slice("scenario:".length)) ? "scenario" : undefined;
  if (id === "live:shopfront") return "live";
  return undefined;
}
