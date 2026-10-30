"use client";

import { PauseIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatAgo } from "@/components/incident/format";
import { StatusBadgeDot, type StatusTone } from "@/components/ui/badge";
import { SidebarMenuAction, SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { type EndpointState, endpointWord, inTrouble } from "@/components/watch/endpoint-client";
import type { RuleState, WatchState } from "@/lib/investigation/watch";
import { cn } from "@/lib/utils";

const POLL_MS = 5_000;

// Over a limit is the one state that pulses: it's about to open an
// incident. A healthy watch stays still rather than pulling at the eye.
const look: Record<WatchState["status"], { label: string; tone: StatusTone; pulse?: boolean }> = {
  ok: { label: "Watching shopfront", tone: "success" },
  idle: { label: "Watching shopfront", tone: "muted" },
  breaching: { label: "Shopfront over a limit", tone: "warning", pulse: true },
  alerting: { label: "Incident open on shopfront", tone: "destructive" },
  paused: { label: "Watch paused", tone: "muted" },
};

type State = WatchState;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Unavailable or an incident open first, then slow.
const trouble = (e: EndpointState) => (e.status === "unavailable" ? 2 : 1) + (e.status === "alerting" ? 2 : 0);

// The second line: what the last check saw, in as few words as fit.
function reading(s: State, now: number): string {
  if (!s.enabled) return "Not checking shopfront";
  if (s.error) return s.status === "alerting" ? "Couldn't open an incident" : "Last check failed";
  if (s.status === "alerting" && s.lastOpened) {
    const ago = formatAgo(s.lastOpened.at, now);
    return `${s.lastOpened.reopened ? "Reopened" : "Opened"} ${ago === "now" ? "just now" : `${ago} ago`} · ${s.lastOpened.rule}`;
  }
  // An endpoint in trouble, when no rule is: "Google · slow, check 2 of 3".
  const ruleTrouble = s.rules.some((r) => r.status === "breaching" || r.status === "alerting");
  const endpoint = ruleTrouble ? undefined : s.endpoints?.filter(inTrouble).sort((a, b) => trouble(b) - trouble(a))[0];
  if (endpoint) return `${endpoint.name} · ${endpoint.summary}`;
  const c = s.lastCheck;
  if (!c) return "Starting…";
  if (c.requests === 0) return "No requests in the last minute";
  // Over a limit, the rule and how close it is to opening an incident.
  const breaching = s.rules.find((r) => r.status === "breaching");
  if (breaching) return `${breaching.name} · check ${breaching.checks} of ${breaching.needed}`;
  if (s.status === "idle") return `${plural(c.requests, "request", "requests")}, too few to judge`;
  const ok = s.rules.filter((r) => r.status === "ok").length;
  return `${plural(ok, "rule", "rules")} OK · ${c.requests}/min`;
}

const ruleWord: Record<RuleState["status"], string> = {
  ok: "OK",
  breaching: "over its limit",
  alerting: "opened the incident",
  idle: "not enough traffic",
  paused: "off",
};

// The full story, for the row's tooltip: the last minute's traffic, then
// each rule, what it checks and what it last saw.
function Detail({ s, label }: { s: State; label: string }) {
  const headline = !s.enabled
    ? "Triage isn't watching the live store."
    : s.error
      ? s.error
      : s.lastCheck
        ? `Last minute: ${plural(s.lastCheck.requests, "request", "requests")}.`
        : "Starting.";
  return (
    <div className="flex flex-col gap-1.5">
      <span>
        <span className="font-medium">{label}.</span> {headline}
      </span>
      {s.enabled && s.rules.length > 0 && (
        <ul className="flex flex-col gap-1">
          {s.rules.map((r) => (
            <li key={r.id}>
              <span className="font-medium">{r.name}</span>: {ruleWord[r.status]}
              {r.summary && r.status !== "idle" && <>, {r.summary}</>}
              <span className="block opacity-70">{r.description}</span>
            </li>
          ))}
        </ul>
      )}
      {s.enabled && s.endpoints && s.endpoints.length > 0 && (
        <ul className="flex flex-col gap-1">
          {s.endpoints.map((e) => (
            <li key={e.id}>
              <span className="font-medium">{e.name}</span>: {endpointWord(e)}
              {e.summary && <>, {e.summary}</>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Stage 1 in the sidebar: whether Triage is watching the live store and
// what it last saw, on two lines. Polls the watch; when it opens an
// incident, says so and refreshes the page, so the incident appears without
// a reload. The row links to the Watch page, or to the incident while one
// is open. Pausing and resuming is its own button, so clicking the row never
// changes the watch.
export function WatchStatus() {
  const router = useRouter();
  const { setOpenMobile, isMobile } = useSidebar();
  const [state, setState] = useState<State | null>(null);
  // For "opened 2m ago". No state renders on the server, so its clock is
  // never read there.
  const now = useNow(0);
  // The incident the watch had opened (or reopened) when this page loaded,
  // and when; anything newer is announced, the same incident reopened too.
  const seen = useRef<string | undefined | null>(null);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const res = await fetch("/api/watch", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const next = (await res.json()) as State;
        setState(next);
        const last = next.lastOpened;
        const opened = last && `${last.incidentId} ${last.at}`;
        if (seen.current === null) seen.current = opened;
        else if (last && opened !== seen.current) {
          seen.current = opened;
          router.refresh();
          const view = { label: "View", onClick: () => router.push(`/incidents/${last.incidentId}`) };
          if (last.reopened) {
            toast.error(`Reopened ${last.title ?? "an incident"}`, {
              description: `Shopfront tripped the ${last.rule} rule again soon after it was resolved.`,
              action: view,
            });
          } else {
            toast.error("Triage opened an incident", {
              description: `Shopfront tripped the ${last.rule} rule. The investigation has started.`,
              action: view,
            });
          }
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
    if (res?.ok) setState((await res.json()) as State);
  }

  const status = state?.status ?? "paused";
  const { label, tone, pulse } = look[status];
  const line2 = state ? reading(state, now) : "Connecting…";
  const incident = status === "alerting" ? state?.lastOpened?.incidentId : undefined;
  const ToggleIcon = state?.enabled === false ? PlayIcon : PauseIcon;
  const toggleLabel = state?.enabled === false ? "Resume watching" : "Pause watching";

  const body = (
    <>
      {/* A size-4 box, so the dot lines up with the nav icons above. */}
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        <StatusBadgeDot tone={tone} pulse={pulse} className={cn("size-2", (!state || status === "paused") && "opacity-50")} />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className={cn("truncate", status === "paused" && "text-muted-foreground")}>
          {state ? label : "Watch"}
        </span>
        <span
          className={cn(
            "truncate text-muted-foreground text-xs tabular-nums",
            state?.error && "text-[color-mix(in_oklab,var(--destructive)_80%,black)] dark:text-destructive",
          )}
        >
          {line2}
        </span>
      </div>
    </>
  );

  return (
    <>
      {/* Sidebar tooltips only show when it's collapsed; this one carries
          details the row has no room for, so it shows expanded too. Not
          hoverable: the pause button sits between the row and the tooltip,
          and a hoverable one would stay open over it and block its own. */}
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            asChild
            className="h-auto min-h-8 py-1.5"
          >
            <Link href={incident ? `/incidents/${incident}` : "/watch"} onClick={() => setOpenMobile(false)}>
              {body}
            </Link>
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right" hidden={isMobile} className="items-start">
          {state ? <Detail s={state} label={label} /> : "Watch"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuAction
            onClick={() => void toggle()}
            disabled={!state}
            aria-label={toggleLabel}
            className="peer-data-[size=default]/menu-button:top-1/2 size-6 -translate-y-1/2 disabled:opacity-50"
          >
            <ToggleIcon />
          </SidebarMenuAction>
        </TooltipTrigger>
        <TooltipContent side="right">{toggleLabel}</TooltipContent>
      </Tooltip>
    </>
  );
}
