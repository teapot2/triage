"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface ScenarioOption {
  id: string;
  label: string;
  description: string;
  // Reads the running app's telemetry instead of a recording.
  live?: boolean;
}

// The menus' sections: live first, then the recordings. Empty ones are left out.
export const optionGroups = (options: ScenarioOption[]) =>
  [
    { heading: "Live telemetry", options: options.filter((s) => s.live) },
    { heading: "Replay recorded telemetry", options: options.filter((s) => !s.live) },
  ].filter((g) => g.options.length > 0);

// Starts an investigation and opens its incident page. Shared by the home
// page's Run investigation menu and the sidebar's New investigation item.
// Pending covers both the request and the navigation after it: the
// navigation runs in a transition, which React reports pending until the
// incident page has rendered and then clears. That matters for the sidebar
// and the search palette, which stay mounted across pages: a flag kept on
// after a successful start would spin (and disable them) for good.
export function useStartInvestigation() {
  const router = useRouter();
  const [requesting, setRequesting] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Resolves true once the run started and the page is navigating to it.
  // `focus` narrows a live run to a service's range (and route) from the live page.
  async function start(
    scenario: string,
    focus?: { service: string; from: string; to: string; route?: string },
  ): Promise<boolean> {
    setRequesting(true);
    setError(null);
    try {
      const res = await fetch("/api/investigations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario, focus }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
      startNavigation(() => router.push(`/incidents/${data.id}`));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      // Set in the same update as the transition's start, so pending
      // doesn't blink off between the request and the navigation.
      setRequesting(false);
    }
  }

  return { start, pending: requesting || navigating, error };
}
