"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import type { WatchState } from "@/lib/investigation/watch";
import { cn } from "@/lib/utils";

const POLL_MS = 5_000;

const look: Record<WatchState["status"], { label: string; dot: string }> = {
  ok: { label: "Watching shopfront", dot: "bg-success" },
  idle: { label: "Watching shopfront · no traffic", dot: "bg-muted-foreground" },
  breaching: { label: "Shopfront over its limit", dot: "bg-warning animate-pulse motion-reduce:animate-none" },
  alerting: { label: "Incident open on shopfront", dot: "bg-destructive" },
  paused: { label: "Watch paused", dot: "bg-muted-foreground/50" },
};

// What the last check saw, for the tooltip.
function detail(s: WatchState): string {
  if (!s.enabled) return "Triage isn't watching the live store. Click to resume.";
  if (s.error) return `The last check failed: ${s.error}`;
  const c = s.lastCheck;
  if (!c || c.requests === 0) return "No requests to the store in the last minute. Click to pause.";
  const errors = c.errorRatio === null ? "–" : `${Math.round(c.errorRatio * 100)}%`;
  return `Last minute: p95 ${c.p95Ms ?? "–"} ms, ${errors} errors, ${c.requests} requests. Click to pause.`;
}

// Stage 1 in the sidebar: whether Triage is watching the live store and
// what it last saw. Polls the watch; when it opens an incident, says so and
// refreshes the page, so the incident appears without a reload. Clicking
// pauses or resumes it.
export function WatchStatus() {
  const router = useRouter();
  const [state, setState] = useState<WatchState | null>(null);
  // The incident the watch had opened when this page loaded; anything newer
  // is announced.
  const seen = useRef<string | undefined | null>(null);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const res = await fetch("/api/watch", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const next = (await res.json()) as WatchState;
        setState(next);
        const opened = next.lastOpened?.incidentId;
        if (seen.current === null) seen.current = opened;
        else if (opened && opened !== seen.current) {
          seen.current = opened;
          router.refresh();
          toast.error("Triage opened an incident", {
            description: "Shopfront crossed its alert limit. The investigation has started.",
            action: { label: "View", onClick: () => router.push(`/incidents/${opened}`) },
          });
        }
      } catch {
        // The next poll tries again.
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [router]);

  async function toggle() {
    if (!state) return;
    const res = await fetch("/api/watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !state.enabled }),
    }).catch(() => null);
    if (res?.ok) setState((await res.json()) as WatchState);
  }

  const status = state?.status ?? "paused";
  const { label, dot } = look[status];
  const Icon = state?.enabled === false ? EyeOffIcon : EyeIcon;

  return (
    <SidebarMenuButton
      onClick={() => void toggle()}
      disabled={!state}
      tooltip={state ? `${label}. ${detail(state)}` : "Watch"}
      aria-label={state ? `${label}. ${detail(state)}` : "Watch"}
      className="text-muted-foreground"
    >
      <span className="relative">
        <Icon />
        <span
          aria-hidden
          className={cn("absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar", state ? dot : "bg-muted")}
        />
      </span>
      <span className="truncate">{state ? label : "Watch"}</span>
    </SidebarMenuButton>
  );
}
