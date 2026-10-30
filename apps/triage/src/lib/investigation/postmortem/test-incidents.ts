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

// The mitigated incident after its quiet window: five minutes under the
// threshold from the recovery, resolved at the last one. The fix is still
// waiting for approval.
export function resolved(): Incident {
  const incident = mitigated();
  const { metric, threshold } = incident.trigger;
  const minute = (m: number) => `2026-10-23T02:${m}:00.000Z`;
  incident.verification = {
    after: "mitigation",
    since: "2026-10-23T02:18:00.000Z",
    windowMinutes: 5,
    metric,
    threshold,
    series: [19, 20, 21, 22, 23].map((m) => ({ t: minute(m), value: 180 })),
    status: "resolved",
    startedAt: "2026-10-23T02:18:05.000Z",
    checkedAt: "2026-10-23T02:23:15.000Z",
    finishedAt: "2026-10-23T02:23:15.000Z",
  };
  incident.resolvedAt = minute(23);
  incident.status = "resolved";
  return incident;
}

// The resolved incident, reopened by the watch seven minutes later: back to
// waiting on the fix's approval.
export function reopened(): Incident {
  const incident = resolved();
  incident.reopenings = [
    { at: "2026-10-23T02:30:00.000Z", by: "watch", why: "p95 latency back over 500 ms", resolvedAt: incident.resolvedAt, value: 812 },
  ];
  incident.resolvedAt = undefined;
  incident.status = "awaiting_approval";
  return incident;
}
