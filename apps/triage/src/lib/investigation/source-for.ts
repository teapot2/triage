import { createDependencySource } from "./dependencies/source";
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
    // The audits up to the alert; the source as it is on disk now.
    case "dependency":
      return createDependencySource(incident.service, { now });
    default:
      return undefined;
  }
}

// How far past the alert Ask's tools read on a live run or an endpoint
// check. The tools' windows count back from their "now" and reach at most
// 180 min, so stopping two hours after the alert keeps the hour before it
// in reach too.
export const ASK_REACH_MINUTES = 120;

// The source Ask's tools read: on a live run or an endpoint check, the
// same telemetry up to now (at most ASK_REACH_MINUTES past the alert), so
// "is it back to normal?" is read from what came after the mitigation;
// `pastAlert` says how many minutes past the alert that is (0 at the
// alert). The database checks still answer as at the alert, as before. A
// recorded scenario, a dependency advisory or anything else stays at the
// alert: there is nothing later to read. Re-runs, the full-context bundle
// and the recovery watch use sourceFor as before.
export async function askSourceFor(
  incident: Incident,
  now = Date.now(),
): Promise<{ source: TelemetrySource; pastAlert: number } | undefined> {
  const kind = sourceKind(incident);
  const alert = Date.parse(incident.detectedAt);
  const until = Math.min(Math.max(now, alert), alert + ASK_REACH_MINUTES * 60_000);
  const pastAlert = Math.floor((until - alert) / 60_000);
  if ((kind !== "live" && kind !== "uptime") || pastAlert < 1) {
    const source = await sourceFor(incident);
    return source && { source, pastAlert: 0 };
  }
  const later = await sourceFor({ ...incident, detectedAt: new Date(until).toISOString() });
  if (!later) return undefined;
  // slow_queries counts its window from a sample taken before the source's
  // "now": the one before the alert, as the investigation read it.
  let atAlert: Promise<TelemetrySource | undefined> | undefined;
  const dbDiagnostics: TelemetrySource["dbDiagnostics"] = async (check) => {
    const source = await (atAlert ??= sourceFor(incident));
    return (source ?? later).dbDiagnostics(check);
  };
  return { source: { ...later, dbDiagnostics }, pastAlert };
}
