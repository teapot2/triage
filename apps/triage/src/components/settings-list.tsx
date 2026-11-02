"use client";

import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";import { cn } from "@/lib/utils";

// The pieces of Settings' lists: a section heading, group headings inside a
// list, and rows that open in place to an editor. A row's status is a
// StatusBadge, as everywhere else.

export function SettingsSectionHeader({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <h2 id={id} className="font-heading font-medium text-base">
          {title}
        </h2>
        {children}
      </div>
      {description && <p className="text-muted-foreground text-sm">{description}</p>}
    </div>
  );
}

// A heading inside a list, with a note on the right about the group.
export function ListGroup({ label, note }: { label: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 bg-muted/50 px-4 py-2 text-xs">
      <span className="font-medium">{label}</span>
      {note && <span className="text-muted-foreground">{note}</span>}
    </div>
  );
}

// A row that opens in place: its title and an optional tag, a one-line
// subtitle, and its status, over an editor. The parent owns `open`, so it
// can keep one row open at a time. "Unsaved" shows on a closed row whose
// editor holds a draft.
//
// `summary` is the row's current value, in fixed-width columns the caller
// sizes so they line up from row to row. It sits before the status once the
// row itself is wide enough (a container query: beside Settings' menu the
// list is narrower than the window suggests) and under the subtitle below
// that, and hides while the row is open,
// where the editor shows the same values. The open subtitle wraps instead
// of truncating, and the editor sits directly in the row, aligned with its
// title, with no card of its own.
export function DisclosureRow({
  title,
  tag,
  subtitle,
  summary,
  status,
  unsaved,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  tag?: string;
  subtitle?: ReactNode;
  summary?: ReactNode;
  status?: ReactNode;
  unsaved?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="group/row @container">
      <CollapsibleTrigger
        className={cn(
          "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
          summary && "@2xl:grid-cols-[minmax(0,1fr)_auto_auto_auto] @2xl:gap-x-6",
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 font-medium text-sm">
            {title}
            {tag && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {tag}
              </Badge>
            )}
          </span>
          {subtitle && (
            <span className="truncate text-muted-foreground text-xs group-data-[state=open]/row:whitespace-normal">
              {subtitle}
            </span>
          )}
        </span>
        {summary && (
          <span className="col-start-1 row-start-2 flex items-center gap-4 group-data-[state=open]/row:hidden @2xl:col-start-2 @2xl:row-start-1">
            {summary}
          </span>
        )}
        <span className={cn("flex items-center justify-end gap-3", summary && "@2xl:min-w-28")}>
          {unsaved && !open && <span className="text-muted-foreground text-xs">Unsaved</span>}
          {status}
        </span>
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-[rotate] duration-200 group-data-[state=open]/row:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 px-4 pt-1 pb-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// An editor's footer: a test on the left, Cancel and Save on the right,
// under a rule.
export function DisclosureFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">{children}</div>;
}
