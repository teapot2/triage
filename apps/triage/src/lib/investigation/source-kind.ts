import { getScenario } from "./scenarios";
import type { Incident } from "./schema";
import { checkIdPattern } from "./uptime/model";

// Where a finished incident's telemetry can be read again, from the source
// its run recorded: a recorded scenario, rebuilt from its ID exactly as the
// investigation saw it, the live Shopfront, anchored at the alert, or an
// uptime check's saved results (with Shopfront's, on a check of it). The
// bundled examples (no run) and anything else have none. Apart from
// source-for so the incident page can tell which way a question will be
// answered without bundling the live source.
export function sourceKind(incident: Incident): "scenario" | "live" | "uptime" | undefined {
  const id = incident.run?.source ?? "";
  if (id.startsWith("scenario:")) return getScenario(id.slice("scenario:".length)) ? "scenario" : undefined;
  if (id === "live:shopfront") return "live";
  if (id.startsWith("uptime:")) return checkIdPattern.test(id.slice("uptime:".length)) ? "uptime" : undefined;
  return undefined;
}
