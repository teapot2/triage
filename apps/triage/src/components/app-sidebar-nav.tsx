"use client";

import { BellIcon, ChevronRightIcon, ServerIcon, SirenIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { formatAgo, formatDateTime } from "@/components/incident/format";
import { collapseMotion } from "@/components/incident/motion";
import { StatusDot, statusLabel } from "@/components/incident/status-badges";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import { useNow } from "@/hooks/use-now";
import { useSeen } from "@/hooks/use-seen";
import type { ScenarioOption } from "@/hooks/use-start-investigation";
import type { IncidentStatus } from "@/lib/investigation/schema";
import { type SidebarSection, writeSectionOpen } from "@/lib/sidebar-sections";
import { cn } from "@/lib/utils";
import { SearchCommand } from "./search-command";

export interface RecentIncident {
  id: string;
  // What Triage concluded when it found a root cause, else the alert title:
  // alert titles repeat across runs, conclusions tell them apart.
  label: string;
  title: string;
  service: string;
  status: IncidentStatus;
  // When the run started (or the alert fired), ISO: runs often share a
  // conclusion, so how long ago tells them apart.
  at: string;
  // When it last changed (run finished, fix decided): what "new" compares.
  activityAt: string;
}

const RECENT_LIMIT = 8;
const DAY = 24 * 60 * 60 * 1000;
const enterMotion = "animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none";

export function AppSidebarNav({
  openCount,
  attention,
  recent,
  all,
  scenarios,
  collapsed,
  now: serverNow,
}: {
  openCount: number;
  // Incidents someone has to act on or watch, most urgent first; Recent
  // leaves them out, so each incident shows once.
  attention: RecentIncident[];
  recent: RecentIncident[];
  // Every incident, newest first: what the "new" filter draws from.
  all: RecentIncident[];
  // For the search palette's "Run investigation" actions.
  scenarios: ScenarioOption[];
  // Groups saved as collapsed (from a cookie, read on the server).
  collapsed: SidebarSection[];
  // Server render time, for the relative times' first (hydrating) render.
  now: number;
}) {
  const now = useNow(serverNow);
  const pathname = usePathname();
  const isNew = useSeen();
  // On phones the sidebar is a sheet; close it once a link is chosen.
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);

  // Changes made while the app is open show: the open count pops (keyed so
  // each new number replays it) and incidents slide into a group they
  // weren't in on load: a new run, or one handled and back in Recent. On
  // load everything is simply there.
  const countChanged = useChangedSinceMount(openCount);
  const [initialRecent] = useState(() => new Set(recent.map((r) => r.id)));
  const [initialAttention] = useState(() => new Set(attention.map((r) => r.id)));

  // The bell narrows Recent to what's worth a look: news you haven't seen,
  // or a run started in the last day.
  const [onlyNew, setOnlyNew] = useState(false);
  const inAttention = new Set(attention.map((i) => i.id));
  const fresh = all.filter(
    (i) => !inAttention.has(i.id) && (isNew(i.id, i.activityAt) || now - Date.parse(i.at) < DAY),
  );
  const unseenCount = all.filter((i) => isNew(i.id, i.activityAt)).length;
  const shownRecent = onlyNew ? fresh.slice(0, RECENT_LIMIT) : recent;

  // The collapsed sidebar hides both groups, so the Incidents icon carries
  // their signal: amber when something needs attention, else violet for news.
  const signal = attention.length > 0 ? "attention" : unseenCount > 0 ? "new" : undefined;
  const incidentsTooltip =
    signal === "attention"
      ? `Incidents · ${attention.length} need${attention.length === 1 ? "s" : ""} attention`
      : signal === "new"
        ? `Incidents · ${unseenCount} new`
        : "Incidents";

  const rowProps = (incident: RecentIncident) => ({
    href: `/incidents/${incident.id}`,
    onClick: close,
    title: `${incident.title} · ${formatDateTime(incident.at)}`,
  });

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SearchCommand incidents={all} attention={attention} scenarios={scenarios} now={now} />
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === "/"} tooltip={incidentsTooltip}>
                <Link href="/" onClick={close}>
                  <SirenIcon />
                  <span>Incidents</span>
                </Link>
              </SidebarMenuButton>
              {signal && (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute top-1.5 left-5 hidden size-2 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:block",
                    signal === "attention" ? "bg-warning" : "bg-brand",
                  )}
                />
              )}
              {openCount > 0 && (
                <SidebarMenuBadge
                  key={openCount}
                  className={cn(
                    countChanged &&
                      "animate-in zoom-in-75 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none",
                  )}
                >
                  {openCount}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname.startsWith("/services")} tooltip="Services">
                <Link href="/services" onClick={close}>
                  <ServerIcon />
                  <span>Services</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {attention.length > 0 && (
        <CollapsibleGroup section="attention" label="Needs attention" defaultOpen={!collapsed.includes("attention")}>
          <SidebarMenu>
            {attention.map((incident) => {
              const fresh = isNew(incident.id, incident.activityAt);
              return (
                <SidebarMenuItem key={incident.id} className={cn(!initialAttention.has(incident.id) && enterMotion)}>
                  {/* Two lines, so the status is spelled out next to its dot. */}
                  <SidebarMenuButton asChild size="lg" isActive={pathname === `/incidents/${incident.id}`}>
                    <Link {...rowProps(incident)}>
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center self-start">
                        <StatusDot status={incident.status} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className={cn("truncate", fresh && "font-medium text-sidebar-foreground")}>
                          {incident.label}
                        </span>
                        <span className="flex items-center gap-1.5 truncate text-sidebar-foreground/60 text-xs">
                          {statusLabel[incident.status]} · {formatAgo(incident.at, now)}
                          {fresh && <NewMarker />}
                        </span>
                      </span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </CollapsibleGroup>
      )}

      {(recent.length > 0 || onlyNew) && (
        <CollapsibleGroup
          section="recent"
          label={onlyNew ? "New and recent" : "Recent"}
          defaultOpen={!collapsed.includes("recent")}
          action={
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarGroupAction
                  onClick={() => setOnlyNew((v) => !v)}
                  aria-pressed={onlyNew}
                  aria-label={
                    unseenCount > 0 ? `Show only new and recent incidents (${unseenCount} new)` : "Show only new and recent incidents"
                  }
                  className={cn(onlyNew && "bg-sidebar-accent text-sidebar-accent-foreground")}
                >
                  <BellIcon />
                  {unseenCount > 0 && (
                    <span className="absolute top-0 right-0 size-1.5 rounded-full bg-brand ring-2 ring-sidebar" />
                  )}
                </SidebarGroupAction>
              </TooltipTrigger>
              <TooltipContent side="right">
                {onlyNew ? "Show all recent" : "Show only new and recent (last day)"}
              </TooltipContent>
            </Tooltip>
          }
        >
          {shownRecent.length === 0 ? (
            <p className="px-2 py-1.5 text-sidebar-foreground/60 text-xs">Nothing new in the last day.</p>
          ) : (
            <SidebarMenu>
              {shownRecent.map((incident) => {
                const fresh = isNew(incident.id, incident.activityAt);
                return (
                  <SidebarMenuItem key={incident.id} className={cn(!initialRecent.has(incident.id) && enterMotion)}>
                    <SidebarMenuButton asChild isActive={pathname === `/incidents/${incident.id}`}>
                      <Link {...rowProps(incident)}>
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          <StatusDot status={incident.status} />
                        </span>
                        <span
                          className={cn("min-w-0 flex-1 truncate", fresh && "font-medium text-sidebar-foreground")}
                        >
                          {incident.label}
                        </span>
                        {fresh && <NewMarker />}
                        <span className="shrink-0 font-mono text-[11px] text-sidebar-foreground/50 tabular-nums">
                          {formatAgo(incident.at, now)}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          )}
        </CollapsibleGroup>
      )}
    </>
  );
}

// A sidebar group that folds: its label is the toggle, with a chevron just
// after the title that points right when closed and down when open. Opens
// and closes with the app's disclosure motion. `action` (e.g. the bell)
// sits at the group's top right, outside the toggle. The choice is saved in
// a cookie, which the server reads to render the group the same way on the
// next load (see lib/sidebar-sections).
function CollapsibleGroup({
  section,
  label,
  defaultOpen,
  action,
  children,
}: {
  section: SidebarSection;
  label: string;
  defaultOpen: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} onOpenChange={(open) => writeSectionOpen(section, open)} asChild>
      <SidebarGroup className="group/section group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="w-full gap-1 transition-colors hover:text-sidebar-foreground">
            {label}
            <ChevronRightIcon className="size-3.5! transition-[rotate] duration-200 group-data-[state=open]/section:rotate-90 motion-reduce:transition-none" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        {action}
        <CollapsibleContent className={collapseMotion}>
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

// Unseen activity, e.g. a run that finished while you were elsewhere.
function NewMarker() {
  return (
    <span className="flex shrink-0 items-center">
      <span aria-hidden className="size-1.5 rounded-full bg-brand" />
      <span className="sr-only">New</span>
    </span>
  );
}
