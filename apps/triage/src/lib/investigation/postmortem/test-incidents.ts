import { exampleIncidents } from "../fixtures";
import { proposeMitigation } from "../mitigation/propose";
import type { Incident } from "../schema";
import { samplePostmortem } from "./sample";

// Incidents for the postmortem tests: the pool-leak example with the sample
// record, as if its investigation had run, and the same with its
// mitigation applied and recovered.

export function poolLeak(): Incident {
  const example = structuredClone(exampleIncidents.find((i) => i.id === "inc_pool_leak")!);
  return {
    ...example,
    openedBy: "watch",
    run: {
      source: "scenario:pool-leak",
      model: "muse-spark-1.3",
      startedAt: "2026-10-23T02:14:02.000Z",
      finishedAt: "2026-10-23T02:14:12.000Z",
    },
    fixRun: {
      status: "proven",
      attempt: 2,
      model: "muse-spark-1.3",
      startedAt: "2026-10-23T02:14:30.000Z",
      finishedAt: "2026-10-23T02:16:28.000Z",
    },
    postmortem: structuredClone(samplePostmortem),
  };
}

export function mitigated(): Incident {
  const incident = poolLeak();
  const proposed = proposeMitigation(incident.report!, incident.evidence, incident.service, "2026-10-23T02:14:12.000Z")!;
  incident.mitigation = {
    ...proposed,
    state: "applied",
    decidedAt: "2026-10-23T02:15:00.000Z",
    appliedAt: "2026-10-23T02:15:20.000Z",
    recovery: {
      metric: incident.trigger.metric,
      threshold: incident.trigger.threshold,
      since: "2026-10-23T02:15:20.000Z",
      series: [],
      status: "recovered",
      recoveredAt: "2026-10-23T02:18:00.000Z",
    },
  };
  return incident;
}
