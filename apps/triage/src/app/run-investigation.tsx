"use client";

import { ChevronDownIcon, LoaderCircleIcon, PlayIcon } from "lucide-react";
import { Fragment } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { optionGroups, type ScenarioOption, useStartInvestigation } from "@/hooks/use-start-investigation";

// The page header's start button. A failed start shows as a notice on its
// own full-width row under the header (which wraps), not squeezed in beside
// the button.
export function RunInvestigation({ scenarios }: { scenarios: ScenarioOption[] }) {
  const { start: run, pending, error } = useStartInvestigation();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" disabled={pending} className="group/run">
            {pending ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            Run investigation
            <ChevronDownIcon className="transition-[rotate] duration-200 group-data-[state=open]/run:rotate-180 motion-reduce:transition-none" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {optionGroups(scenarios).map((g, i) => (
            <Fragment key={g.heading}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-muted-foreground text-xs">{g.heading}</DropdownMenuLabel>
              {g.options.map((s) => (
                <DropdownMenuItem key={s.id} onSelect={() => run(s.id)} className="flex-col items-start gap-0.5">
                  <span>{s.label}</span>
                  <span className="text-muted-foreground text-xs">{s.description}</span>
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Dismissible: the failed start is over once it's read. Keyed by the
          message so a new failure shows again. */}
      {error && (
        <Alert key={error} variant="destructive" dismissible dismissLabel="Dismiss error" className="basis-full">
          <AlertTitle>Couldn&apos;t start the investigation</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
