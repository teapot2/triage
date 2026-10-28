"use client";

import { useEffect, useState } from "react";

// Polls a JSON endpoint every `intervalMs` while `active` and the tab is
// visible; a hidden tab stops polling and polls again as soon as it's back.
// One request at a time: the next waits for the last. A failed poll keeps
// the last good data and reports the error until a poll succeeds.
export function useLivePoll<T>(url: string, intervalMs: number, active: boolean) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;
    let stopped = false;
    // Set when a poll found the tab hidden and didn't schedule the next.
    let parked = false;

    async function poll() {
      timer = undefined;
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        parked = true;
        return;
      }
      ctrl = new AbortController();
      try {
        const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
        const body = (await res.json()) as T & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setData(body);
        setError(undefined);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) timer = setTimeout(poll, intervalMs);
    }

    const onVisibility = () => {
      if (document.visibilityState !== "visible" || !parked) return;
      parked = false;
      void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      stopped = true;
      ctrl?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, intervalMs, active]);

  return { data, error, updatedAt };
}
