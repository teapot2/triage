"use client";

import { ArchiveIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useArchiveActions } from "@/components/incident/archive-actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Picking incidents on the list to archive them together. Only a closed
// incident can be picked; the others' boxes say why not. The boxes stay out
// of sight until a row is hovered or something is picked, and a small bar
// with the count and Archive floats at the bottom while anything is.

interface Selection {
  selected: ReadonlySet<string>;
  toggle: (id: string, on: boolean) => void;
}

const SelectionContext = createContext<Selection | null>(null);

// `ids` are the incidents on this page that can be picked; a pick that
// leaves the page (archived, filtered out, another page) drops out.
export function IncidentSelection({ ids, children }: { ids: string[]; children: ReactNode }) {
  const [picked, setPicked] = useState<string[]>([]);
  const selected = useMemo(() => new Set(picked.filter((id) => ids.includes(id))), [picked, ids]);
  const { archive, pending } = useArchiveActions();
  const value = useMemo<Selection>(
    () => ({
      selected,
      toggle: (id, on) => setPicked((prev) => (on ? [...prev.filter((p) => p !== id), id] : prev.filter((p) => p !== id))),
    }),
    [selected],
  );
  const count = selected.size;
  const clear = () => setPicked([]);

  // Escape lets go of the selection, unless something else (a menu, the
  // search box) took it first.
  useEffect(() => {
    if (count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setPicked([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  async function archiveSelected() {
    const done = await archive([...selected]);
    setPicked((prev) => prev.filter((id) => !done.includes(id)));
  }

  return (
    <SelectionContext.Provider value={value}>
      <div data-selecting={count > 0 || undefined} className="group/list">
        {children}
      </div>
      {count > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div
            role="toolbar"
            aria-label="Selected incidents"
            className="pointer-events-auto flex items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-3 text-popover-foreground text-sm shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 duration-150 motion-reduce:animate-none"
          >
            <Checkbox
              checked={count === ids.length ? true : "indeterminate"}
              onCheckedChange={(on) => setPicked(on === true ? ids : [])}
              aria-label={count === ids.length ? "Clear selection" : "Select every closed incident on this page"}
              className="mr-2"
            />
            <span className="mr-2 tabular-nums">{count} selected</span>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void archiveSelected()}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArchiveIcon />}
              Archive
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={clear}>
              <XIcon />
            </Button>
          </div>
        </div>
      )}
    </SelectionContext.Provider>
  );
}

// A row's box, left of its link. `blocker` is why it can't be archived yet
// (archiveBlocker), shown on hover over the greyed-out box.
export function SelectIncident({ id, title, blocker }: { id: string; title: string; blocker?: string }) {
  const selection = useContext(SelectionContext);
  if (!selection) return null;
  const checked = selection.selected.has(id);
  const box = (
    <Checkbox
      checked={checked}
      disabled={blocker !== undefined}
      onCheckedChange={(on) => selection.toggle(id, on === true)}
      aria-label={`Select ${title}`}
      className="disabled:pointer-events-none"
    />
  );
  return (
    // Out of sight until the row is hovered, the box is focused or anything
    // is selected; always there where nothing hovers (touch).
    <span
      className={cn(
        "flex shrink-0 items-center self-stretch pl-4 transition-opacity duration-100 motion-reduce:transition-none",
        "opacity-0 focus-within:opacity-100 group-hover/row:opacity-100 group-data-selecting/list:opacity-100 [@media(hover:none)]:opacity-100",
        checked && "opacity-100",
      )}
    >
      {blocker ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-not-allowed">{box}</span>
          </TooltipTrigger>
          <TooltipContent side="right">{blocker}</TooltipContent>
        </Tooltip>
      ) : (
        box
      )}
    </span>
  );
}
