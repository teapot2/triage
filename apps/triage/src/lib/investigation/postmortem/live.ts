import type { PostmortemDraft } from "../schema";

// The drafts being written in this server's process, for the page to follow
// as they stream (the postmortem/stream route). The record is saved about
// once a second; this carries every change in between. On globalThis: one
// map across dev hot reloads, shared by the writer and the route.

export type DraftEvent = { startedAt: string; draft: PostmortemDraft };
type Listener = (event: DraftEvent | null) => void;

interface Live {
  latest: DraftEvent;
  listeners: Set<Listener>;
}

const g = globalThis as unknown as { triagePostmortemDrafts?: Map<string, Live> };
const live = (g.triagePostmortemDrafts ??= new Map<string, Live>());

export function publishDraft(incidentId: string, event: DraftEvent) {
  const entry = live.get(incidentId);
  if (!entry || entry.latest.startedAt !== event.startedAt) {
    // A write that replaced another: its followers hear the old one end.
    entry?.listeners.forEach((l) => l(null));
    live.set(incidentId, { latest: event, listeners: new Set() });
    return;
  }
  entry.latest = event;
  entry.listeners.forEach((l) => l(event));
}

// The write is over (ready or failed, saved): followers hear null.
export function endDraft(incidentId: string, startedAt: string) {
  const entry = live.get(incidentId);
  if (entry?.latest.startedAt !== startedAt) return;
  live.delete(incidentId);
  entry.listeners.forEach((l) => l(null));
}

// Hears the incident's draft, starting with the latest, until it ends.
// Undefined when none is being written here: the record has what there is.
export function followDraft(incidentId: string, listener: Listener): (() => void) | undefined {
  const entry = live.get(incidentId);
  if (!entry) return undefined;
  entry.listeners.add(listener);
  listener(entry.latest);
  return () => entry.listeners.delete(listener);
}

// What the postmortem/stream route sends: each draft, then the end.
export type PostmortemStreamEvent = ({ type: "draft" } & DraftEvent) | { type: "end" };
