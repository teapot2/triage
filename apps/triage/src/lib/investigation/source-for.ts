import { createLiveSource } from "./live/live-source";
import { createScenarioSource, getScenario } from "./scenarios";
import type { Incident } from "./schema";
import type { TelemetrySource } from "./source";
import { sourceKind } from "./source-kind";
import { defaultCheck, readChecks } from "./uptime/checks";
import { readSamples } from "./uptime/samples";
import { createUptimeSource } from "./uptime/source";

// The incident's telemetry source, or undefined for an incident without
// one: a question on it is answered from the recorded evidence alone. The
// live source keeps what the collector's files still hold, so after a
// server restart its window may be empty; an uptime check keeps its last
// samples, which a busy check may have rolled past the alert.
export async function sourceFor(incident: Incident): Promise<TelemetrySource | undefined> {
  const now = Date.parse(incident.detectedAt);
  switch (sourceKind(incident)) {
    case "scenario":
      return createScenarioSource(getScenario(incident.run!.source.slice("scenario:".length))!);
    case "live":
      return createLiveSource({ now });
    case "uptime": {
      const id = incident.run!.source.slice("uptime:".length);
      // A deleted check is rebuilt from the URL the incident recorded; its
      // samples went with it, so the results come back empty.
      const check =
        (await readChecks().catch(() => [])).find((c) => c.id === id) ??
        defaultCheck({ id, name: incident.service, url: incident.trigger.route ?? "" });
      return (await createUptimeSource(check, await readSamples(id), { now })).source;
    }
    default:
      return undefined;
  }
}
