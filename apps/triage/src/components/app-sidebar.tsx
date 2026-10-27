import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import type { Incident, IncidentStatus } from "@/lib/investigation/schema";
import { investigationOptions } from "@/lib/investigation/options";
import { listIncidents } from "@/lib/investigation/store";
import { activityAt, openStatuses, rootCauseTitle } from "@/lib/investigation/summary";
import { parseCollapsedSections, SIDEBAR_SECTIONS_COOKIE } from "@/lib/sidebar-sections";
import { AppSidebarNav } from "./app-sidebar-nav";
import { NewInvestigation } from "./new-investigation";
import { SidebarBrand } from "./sidebar-brand";
import { SidebarFooterControls } from "./sidebar-footer";
import { SidebarWatch } from "./sidebar-settings";

const RECENT_LIMIT = 8;
const ATTENTION_LIMIT = 5;
// What someone has to act on or watch, most urgent first: a fix to approve,
// a run to retry, a run in progress.
const attentionOrder: IncidentStatus[] = ["awaiting_approval", "failed", "investigating"];

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      {/* Brand and the primary action read as one block, like Linear's
          workspace row with its compose button. */}
      <SidebarHeader className="gap-1">
        <SidebarBrand />
        <NewInvestigation
          scenarios={investigationOptions}
        />
      </SidebarHeader>
      <SidebarContent>
        <Suspense fallback={<NavSkeleton />}>
          <IncidentsNav />
        </Suspense>
        <SidebarWatch />
      </SidebarContent>
      <SidebarFooter>
        <SidebarFooterControls />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

async function IncidentsNav() {
  // Incidents change at runtime; read them per request. An incident page's
  // refresh while the agent runs re-renders this too, so statuses stay live.
  await connection();
  // Collapsed groups render collapsed from the first byte, so a reload
  // doesn't open them and snap shut.
  const collapsed = parseCollapsedSections((await cookies()).get(SIDEBAR_SECTIONS_COOKIE)?.value);
  return (
    <AppSidebarNav
      {...await loadNav()}
      collapsed={collapsed}
      scenarios={investigationOptions}
    />
  );
}

// What the nav shows, plus when it was read: the browser's first render of
// the relative times uses that, so it matches this HTML before its own
// clock takes over. Incidents that need someone go in Needs attention,
// most urgent status first (each status newest first: the list is sorted
// newest first and the sort is stable); Recent is everything else, so an
// incident moves back there once it's handled.
async function loadNav() {
  const incidents = await listIncidents();
  const openCount = incidents.filter((i) => openStatuses.includes(i.status)).length;
  const toItem = (i: Incident) => ({
    id: i.id,
    label: rootCauseTitle(i) ?? i.title,
    title: i.title,
    service: i.service,
    status: i.status,
    at: i.run?.startedAt ?? i.detectedAt,
    activityAt: activityAt(i),
  });
  const attention = incidents
    .filter((i) => attentionOrder.includes(i.status))
    .sort((a, b) => attentionOrder.indexOf(a.status) - attentionOrder.indexOf(b.status))
    .slice(0, ATTENTION_LIMIT);
  const shown = new Set(attention.map((i) => i.id));
  const recent = incidents.filter((i) => !shown.has(i.id)).slice(0, RECENT_LIMIT);
  return {
    openCount,
    attention: attention.map(toItem),
    recent: recent.map(toItem),
    // Every incident, for search; the groups above only show a few.
    all: incidents.map(toItem),
    now: Date.now(),
  };
}

// Fixed widths: shadcn's SidebarMenuSkeleton randomizes them with
// Math.random(), which Cache Components rejects in a prerendered fallback.
function NavSkeleton() {
  return (
    <SidebarGroup>
      <SidebarMenu>
        {["70%", "85%", "60%", "75%"].map((width) => (
          <SidebarMenuItem key={width} className="flex h-8 items-center px-2">
            <Skeleton className="h-4" style={{ width }} />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
