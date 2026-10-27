"use client";

import { Command } from "cmdk";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, PencilIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Matches the select trigger, so the picker sits beside the provider select
// as one of a pair.
const triggerClass =
  "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-left text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[invalid=true]:border-destructive data-[invalid=true]:ring-3 data-[invalid=true]:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:data-[invalid=true]:border-destructive/50 dark:data-[invalid=true]:ring-destructive/40";
const itemClass =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0";

const matchSubstring = (value: string, search: string) =>
  value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0;

// Picks a model from the provider's list, with search. A custom ID is the
// fallback: typed in directly when there's no list to pick from (it failed
// to load or is empty), or chosen from the list's last option for a model
// the provider leaves out of its list.
export function ModelPicker({
  id,
  models,
  loading,
  listed,
  value,
  custom,
  onChange,
}: {
  id: string;
  models: string[];
  loading: boolean;
  // Whether there's a list to pick from.
  listed: boolean;
  value: string;
  custom: boolean;
  onChange: (model: string, custom: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const typed = search.trim();

  if (!loading && (!listed || custom)) {
    return (
      <div className="flex gap-2">
        <Input
          id={id}
          placeholder="Model ID"
          value={value}
          onChange={(e) => onChange(e.target.value, custom)}
          autoComplete="off"
          spellCheck={false}
          // Focus follows a choice of "Use a custom ID".
          autoFocus={custom}
          className="font-mono"
        />
        {listed && (
          <Button variant="ghost" onClick={() => onChange(value.trim(), false)}>
            Choose from list
          </Button>
        )}
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          data-invalid={!loading && Boolean(value) && !models.includes(value)}
          disabled={loading}
          className={triggerClass}
        >
          {loading ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
              Loading models…
            </span>
          ) : value ? (
            <span className="min-w-0 truncate font-mono">{value}</span>
          ) : (
            <span className="text-muted-foreground">Choose a model</span>
          )}
          <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command filter={matchSubstring} loop>
          <div className="flex items-center gap-2 border-b px-2.5">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Search models"
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-3 text-center text-muted-foreground text-xs">No model matches</Command.Empty>
            {models.map((m) => (
              <Command.Item
                key={m}
                value={m}
                onSelect={() => {
                  onChange(m, false);
                  setOpen(false);
                }}
                className={itemClass}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
                {m === value && <CheckIcon aria-hidden />}
              </Command.Item>
            ))}
            <Command.Separator alwaysRender className="-mx-1 my-1 h-px bg-border" />
            <Command.Item
              forceMount
              value="use a custom id"
              onSelect={() => {
                onChange(typed || value, true);
                setOpen(false);
              }}
              className={itemClass}
            >
              <PencilIcon className="text-muted-foreground" aria-hidden />
              {typed ? (
                <span className="min-w-0 truncate">
                  Use <span className="font-mono">{typed}</span> as a custom ID
                </span>
              ) : (
                "Use a custom ID"
              )}
            </Command.Item>
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
