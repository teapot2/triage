"use client";

import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// The pieces of Settings' lists: a section heading, group headings inside a
// list, rows that open in place to an editor, and the status a row shows.

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

// The text colors match the tinted badges, which mix toward black in light
// mode for contrast.
const tones = {
  success: "text-[color-mix(in_oklab,var(--success)_70%,black)] dark:text-success",
  warning: "text-[color-mix(in_oklab,var(--warning)_55%,black)] dark:text-warning",
  destructive: "text-[color-mix(in_oklab,var(--destructive)_80%,black)] dark:text-destructive",
  muted: "text-muted-foreground",
};

export function Status({ tone, loading, children }: { tone: keyof typeof tones; loading?: boolean; children: ReactNode }) {
  return (
    <span className={cn("flex items-center gap-1.5 whitespace-nowrap text-xs", tones[tone])}>
      {loading ? (
        <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
      ) : (
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
      )}
      {children}
    </span>
  );
}

// A row that opens in place: its title and an optional tag, a one-line
// subtitle, and its status, over an editor. The parent owns `open`, so it
// can keep one row open at a time. "Unsaved" shows on a closed row whose
// editor holds a draft.
export function DisclosureRow({
  title,
  tag,
  subtitle,
  status,
  unsaved,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  tag?: string;
  subtitle: ReactNode;
  status?: ReactNode;
  unsaved?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="group/row">
      <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 font-medium text-sm">
            {title}
            {tag && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {tag}
              </Badge>
            )}
          </span>
          <span className="truncate text-muted-foreground text-xs">{subtitle}</span>
        </span>
        {unsaved && !open && <span className="text-muted-foreground text-xs">Unsaved</span>}
        {status}
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
