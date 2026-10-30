import type { Incident } from "./schema";

// A breach shortly after a resolution is the same outage coming back, not a
// new one: the watch reopens the incident it had opened for that rule and
// route instead of opening a second. "Shortly" is REOPEN_WINDOW_MINUTES after
// it was resolved, or after its verification saw the metric climb back.
export const REOPEN_WINDOW_MINUTES = 30;

const OPEN: ReadonlySet<Incident["status"]> = new Set(["investigating", "diagnosed", "awaiting_approval"]);

export const isOpen = (incident: Incident) => OPEN.has(incident.status);

// The route the rule tripped on: on the trigger, or for incidents from
// before it was recorded, the end of the title ("… on GET /api/products").
const routeOf = (i: Incident) => i.trigger.route ?? / on [A-Z]+ (\S+)$/.exec(i.title)?.[1];

// When it last stopped being an outage.
const endedAt = (i: Incident) => i.resolvedAt ?? i.verification?.breachedAt;

const opened = (i: Incident) => Date.parse(i.detectedAt);

// The incident a trip of `ruleId` on `route` at `now` should reopen: the
// latest on that rule and route that ended within the window, unless a newer
// incident on the rule is still open (the outage already has a home).
export function incidentToReopen(
  incidents: Incident[],
  { ruleId, route }: { ruleId: string; route: string },
  now: number,
): Incident | undefined {
  const onRule = incidents.filter((i) => i.trigger.rule?.id === ruleId);
  const recent = onRule
    .filter((i) => {
      const ended = endedAt(i);
      return routeOf(i) === route && ended !== undefined && now - Date.parse(ended) <= REOPEN_WINDOW_MINUTES * 60_000;
    })
    .sort((a, b) => opened(b) - opened(a))[0];
  if (!recent) return undefined;
  return onRule.some((i) => i.id !== recent.id && isOpen(i) && opened(i) > opened(recent)) ? undefined : recent;
}
