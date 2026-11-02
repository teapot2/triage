"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge, type StatusTone } from "@/components/ui/badge";
import type { EndpointState } from "@/lib/investigation/uptime";
import { duration, type UptimeCheck, type UptimeSample } from "@/lib/investigation/uptime/model";
import { useWatchState } from "./watch-client";
import { errorMessage } from "@/lib/errors";

// What the Watch pages share in the browser about uptime checks: a check's
// live state and status badge, its results, and saving the list of checks.
// The routes are GET and PUT /api/watch/endpoints, GET
// /api/watch/endpoints/[id] and POST /api/watch/endpoints/[id]/check.

export type { EndpointState };

// Uptime over one window, worked out on the server from the stored history.
// `since` is set when the history starts inside the window, so 30 days of
// "100%" over two hours of data can say so.
export type UptimeWindow = { label: string; percent?: string; checks: number; down: number; since?: string };

export type EndpointDetailData = { check: UptimeCheck; state: EndpointState; samples: UptimeSample[]; uptime?: UptimeWindow[] };

// The watch's state, polled, with the checks' states in it.
export const useEndpointStates = () => {
  const watch = useWatchState();
  return { watch, endpoints: watch?.endpoints };
};

// --- status ------------------------------------------------------------------

export type EndpointStatus = "alerting" | "unavailable" | "slow" | "healthy" | "paused" | "checking";

// A check's states in the rules' words and tones, most urgent first.
export const endpointStatuses: { id: EndpointStatus; label: string; tone: StatusTone }[] = [
  { id: "alerting", label: "Incident open", tone: "destructive" },
  { id: "unavailable", label: "Unavailable", tone: "destructive" },
  { id: "slow", label: "Slow", tone: "warning" },
  { id: "healthy", label: "Healthy", tone: "success" },
  { id: "paused", label: "Paused", tone: "muted" },
  { id: "checking", label: "Checking", tone: "muted" },
];

// Paused when the check or the watch is off, checking until the watch's
// state has one for it.
export function endpointStatus(
  check: Pick<UptimeCheck, "enabled">,
  state: EndpointState | undefined,
  watchOn: boolean | undefined,
): EndpointStatus {
  if (!check.enabled || watchOn === false || state?.status === "paused") return "paused";
  if (!state || state.status === "unchecked") return "checking";
  return state.status;
}

export function EndpointBadge({ status }: { status: EndpointStatus }) {
  const { label, tone } = endpointStatuses.find((s) => s.id === status) ?? endpointStatuses[0];
  return (
    <StatusBadge tone={tone} loading={status === "checking"} pulse={status === "slow"}>
      {label}
    </StatusBadge>
  );
}

// For the sidebar's tooltip: the state in a word.
export function endpointWord(state: EndpointState): string {
  return {
    healthy: "healthy",
    slow: "slow",
    unavailable: "unavailable",
    unchecked: "not checked yet",
    alerting: "incident open",
    paused: "off",
  }[state.status];
}

// In trouble: slow, unavailable or an incident open.
export const inTrouble = (e: EndpointState) => e.status === "slow" || e.status === "unavailable" || e.status === "alerting";

// --- words -------------------------------------------------------------------

// "12 s ago", "3 min ago", "2 h ago".
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

// "200 · 184 ms", or the reason when nothing answered: "no response · 15 s".
export function sampleText(s: UptimeSample): string {
  return s.status ? `${s.status} · ${duration(s.ms)}` : `no response · ${duration(s.ms)}`;
}

// The last result in a line: "200 · 184 ms · 12 s ago", or what the loop
// makes of the trouble ("slow, check 2 of 3", "down 3 of 5 min").
export function resultLine(state: EndpointState | undefined, now: number): string {
  if (!state?.last) return "Waiting for the first check.";
  const summary = state.summary ?? "";
  if (inTrouble(state) && summary) return summary.charAt(0).toUpperCase() + summary.slice(1);
  return `${sampleText(state.last)} · ${ago(state.last.at, now)}`;
}

// The time now, kept current every second, for "12 s ago". Only for what
// renders after the browser has data, so the server never reads it.
export function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// --- routes ------------------------------------------------------------------

// The saved checks, for the page that lists or edits them.
export function useChecks() {
  const [checks, setChecks] = useState<UptimeCheck[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/watch/endpoints", { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setChecks(((await res.json()) as { checks: UptimeCheck[] }).checks);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(errorMessage(err));
      });
    return () => ctrl.abort();
  }, [attempt]);
  const retry = () => {
    setError(undefined);
    setAttempt((n) => n + 1);
  };
  return { checks, setChecks, error, retry };
}

// Changes the saved list of checks, the way updateRules changes the rules:
// reads the server's current list, applies `change` and saves the result.
// The server checks every URL again and answers 400 with the reason, which
// comes back as `error` (and `refused` for the form to show under the URL).
export async function updateEndpoints(
  change: (checks: UptimeCheck[]) => UptimeCheck[],
): Promise<{ checks?: UptimeCheck[]; error?: string; refused?: boolean }> {
  try {
    const current = await fetch("/api/watch/endpoints", { cache: "no-store" });
    if (!current.ok) return { error: `HTTP ${current.status}` };
    const { checks } = (await current.json()) as { checks: UptimeCheck[] };
    const res = await fetch("/api/watch/endpoints", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checks: change(checks) }),
    });
    const data = (await res.json()) as { checks?: UptimeCheck[]; error?: string };
    if (res.ok && data.checks) return { checks: data.checks };
    return { error: data.error ?? `HTTP ${res.status}`, refused: res.status === 400 };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// One check with its state and last 50 results, polled every 5 seconds like
// the watch's state. `refresh` reads it again now (after Check now).
export function useEndpointDetail(id: string) {
  const [data, setData] = useState<EndpointDetailData>();
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const res = await fetch(`/api/watch/endpoints/${id}`, { cache: "no-store" });
        if (stopped) return;
        if (res.status === 404) return setMissing(true);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as EndpointDetailData;
        // Oldest first, however the route lists them.
        setData({ ...next, samples: next.samples.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)) });
        setError(undefined);
      } catch (err) {
        if (!stopped) setError(errorMessage(err));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { data, missing, error, refresh };
}

// Runs a check now; the sample it took, or why not.
export async function checkNow(id: string): Promise<{ sample?: UptimeSample; error?: string }> {
  try {
    const res = await fetch(`/api/watch/endpoints/${id}/check`, { method: "POST" });
    const data = (await res.json()) as UptimeSample & { error?: string };
    return res.ok ? { sample: data } : { error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

