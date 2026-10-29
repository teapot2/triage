import { createLiveSource } from "./live/live-source";
import { createScenarioSource, getScenario } from "./scenarios";
import type { Incident } from "./schema";
import type { TelemetrySource } from "./source";

// Where a finished incident's telemetry can be read again, from the source
// its run recorded: a recorded scenario, rebuilt from its ID exactly as the
// investigation saw it, or the live Shopfront, anchored at the alert. The
// bundled examples (no run) and anything else have none.
export function sourceKind(incident: Incident): "scenario" | "live" | undefined {
  const id = incident.run?.source ?? "";
  if (id.startsWith("scenario:")) return getScenario(id.slice("scenario:".length)) ? "scenario" : undefined;
  if (id === "live:shopfront") return "live";
  return undefined;
}

// The incident's telemetry source, or undefined for an incident without
// one: a question on it is answered from the recorded evidence alone. The
// live source keeps what the collector's files still hold, so after a
// server restart its window may be empty.
export async function sourceFor(incident: Incident): Promise<TelemetrySource | undefined> {
  switch (sourceKind(incident)) {
    case "scenario":
      return createScenarioSource(getScenario(incident.run!.source.slice("scenario:".length))!);
    case "live":
      return createLiveSource({ now: Date.parse(incident.detectedAt) });
    default:
      return undefined;
  }
}
