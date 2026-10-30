import { saveNewIncident } from "../agent";
import type { Incident } from "../schema";
import type { TelemetrySource } from "../source";
import {
  incidentTitle,
  ruleDescription,
  ruleId,
  ruleName,
  ruleSeverity,
  runStatus,
  type UptimeCheck,
  type UptimeRule,
  type UptimeSample,
} from "./model";
import { availabilityMetric, responseTimeMetric } from "./source";

// The incident an uptime rule opens, from the source createUptimeSource
// built. Slow charts each check's response time against the slow limit;
// Down charts availability per minute against 100 %, so the chart shows the
// drop. Filed under the service the series belongs to: the endpoint's host,
// or shopfront when the check targets it.

// Long enough to show the healthy stretch before a Down window of up to 30 min.
const WINDOW_MINUTES = 60;

// The failing checks in the run that tripped the rule: the newest samples
// that failed the way the rule counts.
export function failingRun(rule: UptimeRule, samples: UptimeSample[]): UptimeSample[] {
  const failing = rule === "down" ? "down" : "slow";
  const start = samples.findLastIndex((s) => s.outcome !== failing) + 1;
  return samples.slice(start);
}

export async function createUptimeIncident(
  check: UptimeCheck,
  rule: UptimeRule,
  samples: UptimeSample[],
  source: TelemetrySource,
): Promise<Incident> {
  const metric = rule === "down" ? availabilityMetric(check) : responseTimeMetric(check);
  const alert = await source.queryMetric({ name: metric, windowMinutes: WINDOW_MINUTES });
  if (!alert || alert.points.length === 0) throw new Error(`No ${metric} series to open an incident from.`);
  const run = failingRun(rule, samples);
  return saveNewIncident(source, alert, {
    title: incidentTitle(check, rule, runStatus(run)),
    service: alert.service,
    severity: ruleSeverity(rule),
    threshold: rule === "down" ? 100 : check.slowMs,
    openedBy: "watch",
    rule: { id: ruleId(check, rule), name: `${check.name} ${ruleName(rule)}`, description: ruleDescription(check, rule) },
    route: check.url,
    uptime: { checkId: check.id, rule, failedChecks: run.length, lastFailedAt: run.at(-1)?.at },
  });
}
