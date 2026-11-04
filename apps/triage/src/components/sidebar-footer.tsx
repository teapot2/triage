"use client";

import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { modKey, useIsMac } from "@/hooks/use-is-mac";
import { SidebarSettingsItem } from "./sidebar-settings";

// Settings and the collapse/expand control: side by side when expanded,
// stacked (toggle below) when collapsed. The toggle stays absolutely placed
// at the menu's right edge (100% - 2rem), so it rides the sidebar's width
// animation and lands under Settings at icon width (where that is 0); only
// its top and the footer height change, on the same 200ms ease-in-out
// curve as the width. Everything switches with CSS on data-collapsible, so
// the markup never depends on React state: the saved state is applied before
// hydration (see lib/sidebar-state).
export function SidebarFooterControls() {
  return (
    <SidebarMenu className="relative h-8 transition-[height] duration-200 ease-in-out group-data-[collapsible=icon]:h-[4.25rem] motion-reduce:transition-none">
      <SidebarSettingsItem className="pr-9 group-data-[collapsible=icon]:pr-0" />
      <SidebarToggle />
    </SidebarMenu>
  );
}

function SidebarToggle() {
  const { state, isMobile, toggleSidebar } = useSidebar();
  // ⌘B on a Mac, Ctrl B elsewhere, written as the search row writes ⌘K.
  const isMac = useIsMac();
  const shortcut = `${modKey(isMac)}B`;
  // Tooltip text can follow state: it only renders on hover, after hydration.
  const label = isMobile
    ? "Close sidebar"
    : state === "collapsed"
      ? `Expand sidebar (${shortcut})`
      : `Collapse sidebar (${shortcut})`;

  return (
    // max(0px, …): at icon width the menu is 31px (the sidebar's 1px border),
    // so the plain calc would sit 1px left of Settings.
    <SidebarMenuItem className="absolute top-0 left-[max(0px,calc(100%-2rem))] transition-[top] duration-200 ease-in-out group-data-[collapsible=icon]:top-9 motion-reduce:transition-none">
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
            className="size-8 justify-center p-0 text-muted-foreground"
          >
            <PanelLeftCloseIcon className="group-data-[collapsible=icon]:hidden" />
            <PanelLeftOpenIcon className="hidden group-data-[collapsible=icon]:block" />
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
}
