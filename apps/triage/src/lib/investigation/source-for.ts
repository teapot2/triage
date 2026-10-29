import { createLiveSource } from "./live/live-source";
import { createScenarioSource, getScenario } from "./scenarios";
import type { Incident } from "./schema";
import type { TelemetrySource } from "./source";
import { sourceKind } from "./source-kind";

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
