"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
export function useStartInvestigation() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolves true once the run started and the page is navigating to it.
  async function start(scenario: string): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/investigations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.push(`/incidents/${data.id}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Only reset on failure: on success stay pending while the page navigates.
      setPending(false);
      return false;
    }
  }

  return { start, pending, error };
}
