// The incident the watch last opened or reopened, from any of its loops: a
// watch rule (watch.ts), an uptime check (uptime.ts) or the dependency audit
// (dependencies.ts). GET /api/watch carries it, and the sidebar announces
// anything newer. On globalThis, like the loops' own states, so it survives
// dev hot reloads.

export type LastOpened = {
  incidentId: string;
  at: string;
  // What opened it, for the sidebar's line: a rule's name ("API latency"),
  // "Google is not responding", "semver advisory".
  rule: string;
  // The loop that opened it; a watch rule when absent.
  by?: "uptime" | "dependencies";
  title?: string;
  // Reopened a recently resolved incident rather than opening one.
  reopened?: boolean;
};

const g = globalThis as unknown as { triageLastOpened?: LastOpened };

export function recordOpened(opened: LastOpened) {
  g.triageLastOpened = opened;
}

export const lastOpened = (): LastOpened | undefined => g.triageLastOpened;
