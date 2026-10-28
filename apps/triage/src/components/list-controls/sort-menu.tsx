"use client";

import { ArrowUpDownIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SortOption<T extends string> = { readonly id: T; readonly label: string };

// A list's orders as radio items, for a sort menu or a submenu of a larger
// menu (the sidebar's Recent filters). Each label says its direction.
export function SortRadioItems<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly SortOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
      {options.map((o) => (
        <DropdownMenuRadioItem key={o.id} value={o.id}>
          {o.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

// A list's sort, after the compact "⇅ Date" menus in Wrike and Sketch: a
// button naming the current order, opening a radio list. Ghost beside a
// list's count; outline in a toolbar with a search box and Filter.
export function SortMenu<T extends string>({
  options,
  value,
  onChange,
  noun,
  pending,
  variant = "ghost",
}: {
  options: readonly SortOption<T>[];
  value: T;
  onChange: (value: T) => void;
  // What's sorted, for the button's name: "Sort incidents: Newest first".
  noun: string;
  pending?: boolean;
  variant?: "ghost" | "outline";
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size="sm"
          aria-label={`Sort ${noun}: ${current.label}`}
          className={variant === "ghost" ? "text-muted-foreground data-[state=open]:text-foreground" : "h-8"}
        >
          <ArrowUpDownIcon className={pending ? "animate-pulse" : undefined} />
          {current.label}
          <ChevronDownIcon className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-muted-foreground text-xs">Sort by</DropdownMenuLabel>
        <SortRadioItems options={options} value={value} onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
