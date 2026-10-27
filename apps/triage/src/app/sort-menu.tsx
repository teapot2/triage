"use client";

import { ArrowUpDownIcon, ChevronDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { defaultSort, type IncidentSort, incidentSorts } from "@/lib/investigation/sort";

// The incident list's sort, after the compact "⇅ Date" menus in Wrike and
// Sketch: a quiet button naming the current order, opening a radio list.
// The choice lives in the URL (?sort=), so it survives a reload and can be
// shared; the default leaves the URL clean.
export function SortMenu({ value }: { value: IncidentSort }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = incidentSorts.find((s) => s.id === value) ?? incidentSorts[0];

  const choose = (next: string) =>
    startTransition(() => {
      router.replace(next === defaultSort ? "/" : `/?sort=${next}`, { scroll: false });
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Sort incidents: ${current.label}`}
          className="text-muted-foreground data-[state=open]:text-foreground"
        >
          <ArrowUpDownIcon className={pending ? "animate-pulse" : undefined} />
          {current.label}
          <ChevronDownIcon className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-muted-foreground text-xs">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={choose}>
          {incidentSorts.map((s) => (
            <DropdownMenuRadioItem key={s.id} value={s.id}>
              {s.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
