"use client";

import { BellIcon, ListFilterIcon } from "lucide-react";
import { useState } from "react";
import { SeverityBars, severityLabel, StatusIcon, statusGroupOf, statusLabel } from "@/components/incident/status-badges";
import { type FilterFacet, FilterFacetSub } from "@/components/list-controls/filter-menu";
import { SortRadioItems } from "@/components/list-controls/sort-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarGroupAction } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  defaultRecentFilters,
  isDefaultMenu,
  type RecentFilters,
  type RecentSort,
  recentSorts,
  severityIds,
  statusIds,
} from "@/lib/sidebar-filters";
import { cn } from "@/lib/utils";

// A facet's new selection, in the menu's order; all of them selected is the
// same as none (no filter), so it's stored as none.
function normalize<T extends string>(next: string[], all: T[]): T[] {
  return next.length === all.length ? [] : all.filter((v) => next.includes(v));
}

const severityFacet: FilterFacet = {
  id: "severity",
  label: "Severity",
  options: severityIds.map((s) => ({
    value: s,
    label: `${s.toUpperCase()} · ${severityLabel[s]}`,
    icon: <SeverityBars severity={s} />,
  })),
};

const statusFacet: FilterFacet = {
  id: "status",
  label: "Status",
  options: statusIds.map((s) => ({
    value: s,
    label: statusLabel[s],
    group: statusGroupOf[s],
    icon: (
      <span className="flex size-4 items-center justify-center">
        <StatusIcon status={s} />
      </span>
    ),
  })),
};

// The bell beside the filter button: narrows Recent to the incidents that
// need attention (a fix to approve, a run to retry, a run in progress), so
// there's one list instead of two groups. Amber dot while any do and it's
// off, as a prompt; pressed while it's on, when the list itself shows them. Sits left of the filter button (right-9 to its right-3).
export function AttentionToggle({ on, count, onChange }: { on: boolean; count: number; onChange: (on: boolean) => void }) {
  const label = on ? "Show all recent incidents" : "Show only incidents that need attention";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarGroupAction
          onClick={() => onChange(!on)}
          aria-pressed={on}
          aria-label={`${label}${count > 0 ? ` (${count} need${count === 1 ? "s" : ""} attention)` : ""}`}
          className={cn("right-9", on && "bg-sidebar-accent text-sidebar-accent-foreground")}
        >
          <BellIcon />
          {count > 0 && !on && (
            <span className="absolute top-0 right-0 size-1.5 rounded-full bg-warning ring-2 ring-sidebar" />
          )}
        </SidebarGroupAction>
      </TooltipTrigger>
      <TooltipContent side="right">
        {on ? "Show all" : count > 0 ? `${count} need${count === 1 ? "s" : ""} attention` : "Needs attention"}
      </TooltipContent>
    </Tooltip>
  );
}

// A submenu's row: its name, and on the right what it's set to.
function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-1 items-center justify-between gap-6">
      {label}
      <span className="text-muted-foreground text-xs">{value}</span>
    </span>
  );
}

// The Recent group's filter button: sort, severity, status and "only new",
// as submenus that say their current value, like Claude's own sidebar menu.
// Checkbox items keep the menu open, to pick several. The button stays
// highlighted while any filter is on, and carries a dot when those filters
// hide new incidents.
export function RecentFilterMenu({
  filters,
  onChange,
  unseenCount,
  filteredNewCount,
}: {
  filters: RecentFilters;
  onChange: (next: RecentFilters) => void;
  unseenCount: number;
  // New incidents these filters keep out of the list.
  filteredNewCount: number;
}) {
  const active = !isDefaultMenu(filters);
  const keepOpen = (e: Event) => e.preventDefault();
  // The tooltip names the button; with the menu open it would sit on top of
  // the menu's first row, so it stays hidden.
  const [menuOpen, setMenuOpen] = useState(false);
  const sortLabel = recentSorts.find((s) => s.id === filters.sort)?.label ?? "";
  const severityValue = filters.severities.length ? filters.severities.map((s) => s.toUpperCase()).join(", ") : "All";
  const statusValue =
    filters.statuses.length === 0
      ? "All"
      : filters.statuses.length === 1
        ? statusLabel[filters.statuses[0]]
        : `${filters.statuses.length} selected`;
  const label = `Filter and sort recent incidents${active ? " (filtered)" : ""}${filteredNewCount > 0 ? `, ${filteredNewCount} new hidden` : ""}`;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <SidebarGroupAction
              aria-label={label}
              className={cn(
                "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
            >
              <ListFilterIcon />
              {filteredNewCount > 0 && (
                <span className="absolute top-0 right-0 size-1.5 rounded-full bg-brand ring-2 ring-sidebar" />
              )}
            </SidebarGroupAction>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" hidden={menuOpen}>
          Filter and sort
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="right" className="w-60">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Row label="Sort by" value={sortLabel} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            <SortRadioItems
              options={recentSorts}
              value={filters.sort}
              onChange={(sort: RecentSort) => onChange({ ...filters, sort })}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <FilterFacetSub
          facet={severityFacet}
          selected={filters.severities}
          onChange={(next) => onChange({ ...filters, severities: normalize(next, severityIds) })}
          summary={severityValue}
        />
        <FilterFacetSub
          facet={statusFacet}
          selected={filters.statuses}
          onChange={(next) => onChange({ ...filters, statuses: normalize(next, statusIds) })}
          summary={statusValue}
        />
        <DropdownMenuCheckboxItem
          checked={filters.onlyNew}
          onCheckedChange={(on) => onChange({ ...filters, onlyNew: on === true })}
          onSelect={keepOpen}
        >
          <span className="flex flex-1 items-center justify-between gap-6">
            Only new and last day
            {unseenCount > 0 && <span className="text-muted-foreground text-xs tabular-nums">{unseenCount} new</span>}
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {/* The menu's choices only; the bell keeps its state. */}
        <DropdownMenuItem
          disabled={!active}
          onSelect={() => onChange({ ...defaultRecentFilters, attentionOnly: filters.attentionOnly })}
        >
          Reset to defaults
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
