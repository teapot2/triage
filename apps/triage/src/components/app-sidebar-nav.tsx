"use client";

import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, RadarIcon, ServerIcon, SirenIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { formatAgo } from "@/components/incident/format";
import { StatusIcon } from "@/components/incident/status-badges";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import { useNow } from "@/hooks/use-now";
import { useSeen } from "@/hooks/use-seen";
import type { ScenarioOption } from "@/hooks/use-start-investigation";
import type { Incident, IncidentStatus } from "@/lib/investigation/schema";
import type { IncidentPreview as Preview } from "@/lib/investigation/summary";
import {
  defaultRecentFilters,
  isDefaultMenu,
  needsAttention,
  type RecentFilters,
  type RecentSort,
  writeRecentFilters,
} from "@/lib/sidebar-filters";
import { type SidebarSection, writeSectionOpen } from "@/lib/sidebar-sections";
import { cn } from "@/lib/utils";
import { IncidentPreview } from "./incident-preview";
import { AttentionToggle, RecentFilterMenu } from "./recent-filter-menu";
import { SearchCommand } from "./search-command";

export interface RecentIncident {
  id: string;
  // What Triage concluded when it found a root cause, else the alert title:
  // alert titles repeat across runs, conclusions tell them apart.
  label: string;
  title: string;
  service: string;
  status: IncidentStatus;
  // A fix waiting for a decision: needs attention whatever the status.
  fixPending: boolean;
  severity: Incident["severity"];
  // When the run started (or the alert fired), ISO: runs often share a
  // conclusion, so how long ago tells them apart.
  at: string;
  // When it last changed (run finished, fix decided): what "new" compares.
  activityAt: string;
  // What the row's hover card shows.
  preview: Preview;
}

const RECENT_LIMIT = 8;
const DAY = 24 * 60 * 60 * 1000;
const enterMotion = "animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none";

const newestFirst = (a: RecentIncident, b: RecentIncident) => Date.parse(b.at) - Date.parse(a.at);
const recentOrder: Record<RecentSort, (a: RecentIncident, b: RecentIncident) => number> = {
  newest: newestFirst,
  // "sev1" < "sev2" < "sev3" < "sev4" as strings, so the most severe sorts first.
  severity: (a, b) => a.severity.localeCompare(b.severity) || newestFirst(a, b),
  updated: (a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt),
};

export function AppSidebarNav({
  openCount,
  attention,
  all,
  filters: savedFilters,
  scenarios,
  collapsed,
  now: serverNow,
}: {
  openCount: number;
  // Incidents someone has to act on or watch, most urgent first: the search
  // palette lists them first. In the sidebar, the bell filters Recent to them.
  attention: RecentIncident[];
  // Every incident, newest first: what Recent is filtered from.
  all: RecentIncident[];
  // Recent's sort and filters, as saved (from a cookie, read on the server).
  filters: RecentFilters;
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
  // each new number replays it).
  const countChanged = useChangedSinceMount(openCount);

  // Recent is every incident, through the bell (only what needs attention)
  // and the filter menu's choices: severity, status, and "only new" (news
  // you haven't seen, or a run started in the last day), then sorted and cut
  // to `limit`: RECENT_LIMIT, plus as many more as "View more" asked for.
  // The choices are saved in a cookie, so a reload renders them straight
  // away; the extra rows aren't, and a filter change folds them back.
  const [filters, setFilters] = useState(savedFilters);
  const [limit, setLimit] = useState(RECENT_LIMIT);
  const changeFilters = (next: RecentFilters) => {
    setFilters(next);
    setLimit(RECENT_LIMIT);
    writeRecentFilters(next);
  };
  const attentionCount = all.filter(needsAttention).length;
  // The filter menu's choices; the bell is applied on its own.
  const menuMatch = (i: RecentIncident) =>
    (!filters.onlyNew || isNew(i.id, i.activityAt) || now - Date.parse(i.at) < DAY) &&
    (filters.severities.length === 0 || filters.severities.includes(i.severity)) &&
    (filters.statuses.length === 0 || filters.statuses.includes(i.status));
  const matching = all
    .filter((i) => (!filters.attentionOnly || needsAttention(i)) && menuMatch(i))
    .sort(recentOrder[filters.sort]);
  const shownRecent = matching.slice(0, limit);
  const hidden = matching.length - shownRecent.length;
  // Incidents that join Recent later (a new run, or a filter change) slide
  // in; the ones there on load are simply there.
  const [initialRecent] = useState(() => new Set(shownRecent.map((r) => r.id)));
  const unseenCount = all.filter((i) => isNew(i.id, i.activityAt)).length;
  // New incidents the menu's filters keep out of Recent: the filter button's
  // dot, since only the menu can bring them back. New ones already in the
  // list are marked on their rows.
  const filteredNewCount = all.filter(
    (i) => isNew(i.id, i.activityAt) && (!filters.attentionOnly || needsAttention(i)) && !menuMatch(i),
  ).length;

  // The collapsed sidebar hides Recent, so the Incidents icon carries its
  // signal: amber when something needs attention, else violet for news.
  const signal = attentionCount > 0 ? "attention" : unseenCount > 0 ? "new" : undefined;
  const incidentsTooltip =
    signal === "attention"
      ? `Incidents · ${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`
      : signal === "new"
        ? `Incidents · ${unseenCount} new`
        : "Incidents";

  const rowProps = (incident: RecentIncident) => ({
    href: `/incidents/${incident.id}`,
    onClick: close,
  });

  // One hover card at a time, for the whole list: which row's is open lives
  // here, so opening one closes the last at once instead of after its close
  // delay. The first waits a moment (moving down the list doesn't flash
  // one per row); while one is open, the next opens straight away. Switching
  // from one to the next skips the fade and zoom, so the card swaps rather
  // than two overlapping while one leaves and the other arrives.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const openPreview = (id: string) => {
    setSwitching(previewId !== null && previewId !== id);
    setPreviewId(id);
  };
  // A row's own close timer can fire after the next row's card opened;
  // only the open row closes the card.
  const closePreview = (id: string) => {
    if (previewId !== id) return;
    setPreviewId(null);
    setSwitching(false);
  };

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
                  title={`${openCount} open`}
                  aria-label={`${openCount} open`}
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
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname.startsWith("/watch")} tooltip="Watch">
                <Link href="/watch" onClick={close}>
                  <RadarIcon />
                  <span>Watch</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {all.length > 0 && (
        <CollapsibleGroup
          section="recent"
          label={filters.attentionOnly ? "Needs attention" : filters.onlyNew ? "New and recent" : "Recent"}
          defaultOpen={!collapsed.includes("recent")}
          action={
            <>
              <AttentionToggle
                on={filters.attentionOnly}
                count={attentionCount}
                onChange={(on) => changeFilters({ ...filters, attentionOnly: on })}
              />
              <RecentFilterMenu
                filters={filters}
                onChange={changeFilters}
                unseenCount={unseenCount}
                filteredNewCount={filteredNewCount}
              />
            </>
          }
        >
          {shownRecent.length === 0 ? (
            <p className="px-2 py-1.5 text-sidebar-foreground/60 text-xs">
              {filters.attentionOnly && isDefaultMenu(filters)
                ? "Nothing needs attention."
                : filters.severities.length === 0 && filters.statuses.length === 0 && !filters.attentionOnly
                  ? "Nothing new in the last day."
                  : "No incidents match these filters."}{" "}
              <button
                type="button"
                onClick={() => changeFilters(defaultRecentFilters)}
                className="underline underline-offset-2 hover:text-sidebar-foreground"
              >
                Show all
              </button>
            </p>
          ) : (
            <SidebarMenu>
              {shownRecent.map((incident) => {
                const fresh = isNew(incident.id, incident.activityAt);
                return (
                  <SidebarMenuItem key={incident.id} className={cn(!initialRecent.has(incident.id) && enterMotion)}>
                    <HoverCard
                      open={previewId === incident.id}
                      onOpenChange={(open) => (open ? openPreview(incident.id) : closePreview(incident.id))}
                      openDelay={previewId ? 0 : 450}
                    >
                      <HoverCardTrigger asChild>
                        <SidebarMenuButton asChild isActive={pathname === `/incidents/${incident.id}`}>
                          <Link {...rowProps(incident)}>
                            <span className="flex size-4 shrink-0 items-center justify-center">
                              <StatusIcon status={incident.status} />
                            </span>
                            <span
                              // A run that found nothing recedes, so incidents stand out.
                              className={cn(
                                "min-w-0 flex-1 truncate",
                                fresh
                                  ? "font-medium text-sidebar-foreground"
                                  : incident.status === "healthy" && "text-sidebar-foreground/60",
                              )}
                            >
                              {incident.label}
                            </span>
                            {fresh && <NewMarker />}
                            {/* How long ago, only on hover or keyboard focus, so the
                                title has the row to itself otherwise. The column
                                grows from 0fr to 1fr as the time fades and slides
                                in; while it's closed, -ml-2 takes back the row's
                                gap. Screen readers read it either way. */}
                            <span className="-ml-2 grid shrink-0 grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity,margin] duration-200 ease-out group-hover/menu-button:ml-0 group-hover/menu-button:grid-cols-[1fr] group-hover/menu-button:opacity-100 group-focus-visible/menu-button:ml-0 group-focus-visible/menu-button:grid-cols-[1fr] group-focus-visible/menu-button:opacity-100 motion-reduce:transition-none">
                              <span className="min-w-0 translate-x-1 overflow-hidden font-mono text-[11px] text-sidebar-foreground/50 tabular-nums transition-transform duration-200 ease-out group-hover/menu-button:translate-x-0 group-focus-visible/menu-button:translate-x-0 motion-reduce:transition-none">
                                {formatAgo(incident.at, now)}
                              </span>
                            </span>
                          </Link>
                        </SidebarMenuButton>
                      </HoverCardTrigger>
                      <HoverCardContent
                        side="right"
                        align="start"
                        // Important: the card's own data-closed:animate-out
                        // comes later in the stylesheet and would win.
                        className={cn("w-72", switching && "data-open:animate-none! data-closed:animate-none!")}
                      >
                        <IncidentPreview incident={incident} now={now} />
                      </HoverCardContent>
                    </HoverCard>
                  </SidebarMenuItem>
                );
              })}
              {/* Quiet, like the rows' times: muted until hovered. Each click
                  adds another RECENT_LIMIT rows, which slide in; once more
                  are showing it can fold them back. */}
              {(hidden > 0 || limit > RECENT_LIMIT) && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    onClick={() => setLimit(hidden > 0 ? limit + RECENT_LIMIT : RECENT_LIMIT)}
                    className="text-sidebar-foreground/50 hover:text-sidebar-foreground"
                  >
                    {/* The icon column, so the label lines up with the titles. */}
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {hidden > 0 ? <ChevronDownIcon className="size-3.5!" /> : <ChevronUpIcon className="size-3.5!" />}
                    </span>
                    <span>{hidden > 0 ? `View ${Math.min(hidden, RECENT_LIMIT)} more` : "Show less"}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
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
        <CollapsibleContent>
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
