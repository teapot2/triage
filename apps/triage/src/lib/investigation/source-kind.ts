import { getScenario } from "./scenarios";
import type { Incident } from "./schema";
import { checkIdPattern } from "./uptime/model";

// Where a finished incident's telemetry can be read again, from the source
// its run recorded: a recorded scenario, rebuilt from its ID exactly as the
// investigation saw it, the live Shopfront, anchored at the alert, or an
// uptime check's saved results (with Shopfront's, on a check of it), or the
// dependency audits and the audited source for an advisory. The
// bundled examples (no run) and anything else have none. Apart from
// source-for so the incident page can tell which way a question will be
// answered without bundling the live source.
// Takes anything with the run's source, so a list summary works too.
export function sourceKind(
  incident: { run?: Pick<NonNullable<Incident["run"]>, "source"> },
): "scenario" | "live" | "uptime" | "dependency" | undefined {
  const id = incident.run?.source ?? "";
  if (id.startsWith("scenario:")) return getScenario(id.slice("scenario:".length)) ? "scenario" : undefined;
  if (id === "live:shopfront") return "live";
  // dependencies/source.ts's isDependencySource, without its server imports.
  if (id.startsWith("deps:")) return "dependency";
  if (id.startsWith("uptime:")) return checkIdPattern.test(id.slice("uptime:".length)) ? "uptime" : undefined;
  return undefined;
}
