"use client";

import { ListFilterIcon, type LucideIcon, XIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// Faceted filters for a list, the way log and trace viewers do them: each
// facet (Status, Severity...) a set of values; values within a facet are
// OR'd, facets are AND'd. What a facet's values mean is the list's business;
// these only show and change the selection.

export type FilterOption = {
  value: string;
  label: string;
  // Drawn before the label in the menu: a status icon, severity bars.
  icon?: ReactNode;
  // How many of the list's items have it.
  count?: number;
  // A heading the option is listed under ("In progress", "Done"); options
  // with the same group must be next to each other.
  group?: string;
};

export type FilterFacet = {
  id: string;
  label: string;
  icon?: LucideIcon;
  options: FilterOption[];
  // Values that are identifiers (tool names), set in monospace.
  mono?: boolean;
};

// The selected values per facet id; a facet with none isn't filtering.
export type FilterValues = Record<string, string[]>;

export const activeFacetCount = (values: FilterValues) =>
  Object.values(values).filter((v) => v.length > 0).length;

// One facet as a submenu of checkboxes. Checking keeps the menu open, to
// pick several. On the right of its row, `summary` ("All", "SEV1, SEV2")
// when given, otherwise how many values are picked.
export function FilterFacetSub({
  facet,
  selected,
  onChange,
  summary,
}: {
  facet: FilterFacet;
  selected: string[];
  onChange: (selected: string[]) => void;
  summary?: string;
}) {
  const Icon = facet.icon;
  const aside = summary ?? (selected.length > 0 ? String(selected.length) : undefined);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {Icon && <Icon />}
        <span className="flex flex-1 items-center justify-between gap-6">
          {facet.label}
          {aside && <span className="text-muted-foreground text-xs tabular-nums">{aside}</span>}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        {facet.options.map((o, i) => (
          <Fragment key={o.value}>
            {o.group && o.group !== facet.options[i - 1]?.group && (
              <>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{o.group}</DropdownMenuLabel>
              </>
            )}
            <DropdownMenuCheckboxItem
              checked={selected.includes(o.value)}
              onCheckedChange={(checked) =>
                onChange(checked === true ? [...selected, o.value] : selected.filter((v) => v !== o.value))
              }
              onSelect={(e) => e.preventDefault()}
            >
              {o.icon}
              <span className={cn("min-w-0 truncate", facet.mono && "font-mono text-xs")}>{o.label}</span>
              {o.count !== undefined && (
                <span className="ml-auto pl-3 font-mono text-muted-foreground text-xs tabular-nums">{o.count}</span>
              )}
            </DropdownMenuCheckboxItem>
          </Fragment>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// A list's Filter button: one submenu per facet, the number of facets in
// use on the button, and Clear filters once any is. Facets with no values
// in the list are left out.
export function FilterMenu({
  facets,
  values,
  onChange,
}: {
  facets: FilterFacet[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
}) {
  const active = activeFacetCount(values);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <ListFilterIcon />
          Filter
          {active > 0 && (
            <span className="rounded bg-primary px-1 font-mono text-[10px] text-primary-foreground tabular-nums">
              {active}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {facets
          .filter((f) => f.options.length > 0)
          .map((f) => (
            <FilterFacetSub
              key={f.id}
              facet={f}
              selected={values[f.id] ?? []}
              onChange={(selected) => onChange({ ...values, [f.id]: selected })}
            />
          ))}
        {active > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(Object.fromEntries(facets.map((f) => [f.id, []])))}>
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The filters in use as removable chips ("Status is Error ×", "Tool is any
// of query_logs, query_traces ×"), then Clear (search too) and how many of
// the list's items are showing.
export function FilterChips({
  facets,
  values,
  onChange,
  onClearAll,
  shown,
  total,
}: {
  facets: FilterFacet[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
  onClearAll: () => void;
  shown: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {facets
        .filter((f) => (values[f.id] ?? []).length > 0)
        .map((f) => (
          <FilterChip key={f.id} facet={f} selected={values[f.id]} onRemove={() => onChange({ ...values, [f.id]: [] })} />
        ))}
      <Button variant="ghost" size="xs" onClick={onClearAll} className="text-muted-foreground">
        Clear
      </Button>
      <span className="ml-auto text-muted-foreground text-xs tabular-nums">
        {shown} of {total}
      </span>
    </div>
  );
}

function FilterChip({ facet, selected, onRemove }: { facet: FilterFacet; selected: string[]; onRemove: () => void }) {
  const Icon = facet.icon;
  const label = (v: string) => facet.options.find((o) => o.value === v)?.label ?? v;
  const shown = selected.length > 2 ? `${selected.length} values` : selected.map(label).join(", ");
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted/40 pl-2 text-xs animate-in fade-in-0 zoom-in-95 duration-150 ease-out motion-reduce:animate-none">
      {Icon && <Icon className="size-3 text-muted-foreground" />}
      <span className="text-muted-foreground">{facet.label}</span>
      <span className="text-muted-foreground/70">{selected.length > 1 ? "is any of" : "is"}</span>
      <span className={cn("font-medium", facet.mono && "font-mono")}>{shown}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${facet.label} filter`}
        className="flex h-full w-6 items-center justify-center rounded-r-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}
