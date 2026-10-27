"use client";

import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { Fragment } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { optionGroups, type ScenarioOption, useStartInvestigation } from "@/hooks/use-start-investigation";

// The sidebar's primary action, first in the nav like Linear's compose or
// Cursor's New Agent. Opens the scenario menu beside the sidebar.
export function NewInvestigation({ scenarios }: { scenarios: ScenarioOption[] }) {
  const { start, pending, error } = useStartInvestigation();
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton tooltip="New investigation" disabled={pending}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
              <span>New investigation</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="start" className="w-72">
            {optionGroups(scenarios).map((g, i) => (
              <Fragment key={g.heading}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-muted-foreground text-xs">{g.heading}</DropdownMenuLabel>
                {g.options.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={() => {
                      setOpenMobile(false);
                      start(s.id);
                    }}
                    className="flex-col items-start gap-0.5"
                  >
                    <span>{s.label}</span>
                    <span className="text-muted-foreground text-xs">{s.description}</span>
                  </DropdownMenuItem>
                ))}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* A failed start is over once it's read, so it can be dismissed;
            keyed by the message so a new failure shows again. */}
        {error && (
          <Alert
            key={error}
            variant="destructive"
            dismissible
            dismissLabel="Dismiss error"
            className="mt-2 group-data-[collapsible=icon]:hidden"
          >
            <AlertTitle className="text-xs">Couldn&apos;t start the investigation</AlertTitle>
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
