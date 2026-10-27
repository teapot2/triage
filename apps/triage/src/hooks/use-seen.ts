"use client";

import { useMemo, useSyncExternalStore } from "react";

// Which incidents have news you haven't seen: per incident, the activity
// time you last saw, kept in this browser. An incident is new when its
// latest activity (its run finishing, a decision) is later than that.
// Incidents from before your first visit count as seen, so a first visit
// doesn't light everything up.

const SEEN_KEY = "triage:seen";
const SINCE_KEY = "triage:seen-since";

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) window.addEventListener("storage", notify);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener("storage", notify);
  };
}

// The raw stored strings, so the snapshot compares stable between reads.
function readRaw(): string {
  try {
    let since = localStorage.getItem(SINCE_KEY);
    if (!since) {
      since = new Date().toISOString();
      localStorage.setItem(SINCE_KEY, since);
    }
    return `${since}\n${localStorage.getItem(SEEN_KEY) ?? "{}"}`;
  } catch {
    return "";
  }
}

function parse(raw: string): { since: number; seen: Record<string, string> } | undefined {
  if (!raw) return undefined;
  const [since, json] = raw.split("\n");
  try {
    return { since: Date.parse(since), seen: JSON.parse(json) as Record<string, string> };
  } catch {
    return { since: Date.parse(since), seen: {} };
  }
}

export function markSeen(id: string, activityAt: string) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>;
    if (seen[id] && Date.parse(seen[id]) >= Date.parse(activityAt)) return;
    seen[id] = activityAt;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    notify();
  } catch {
    // Storage blocked: nothing is remembered, so nothing is marked new either.
  }
}

// The incidents opened most recently in this browser, newest first: the
// search palette lists them before anything is typed.
const VIEWED_KEY = "triage:viewed";
const VIEWED_LIMIT = 6;

export function recordView(id: string) {
  try {
    const viewed = JSON.parse(localStorage.getItem(VIEWED_KEY) ?? "[]") as string[];
    if (viewed[0] === id) return;
    localStorage.setItem(VIEWED_KEY, JSON.stringify([id, ...viewed.filter((v) => v !== id)].slice(0, VIEWED_LIMIT)));
    notify();
  } catch {
    // Storage blocked: nothing to remember.
  }
}

const readViewed = () => {
  try {
    return localStorage.getItem(VIEWED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
};

export function useRecentlyViewed(): string[] {
  const raw = useSyncExternalStore(subscribe, readViewed, () => "[]");
  return useMemo(() => {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }, [raw]);
}

// isNew(id, activityAt). The server render (and hydration) marks nothing
// new, since it can't see this browser's storage; markers appear after.
export function useSeen() {
  const raw = useSyncExternalStore(subscribe, readRaw, () => "");
  return useMemo(() => {
    const state = parse(raw);
    return (id: string, activityAt: string) => {
      if (!state) return false;
      const at = Date.parse(activityAt);
      const seenAt = state.seen[id] ? Date.parse(state.seen[id]) : state.since;
      return at > seenAt;
    };
  }, [raw]);
}
