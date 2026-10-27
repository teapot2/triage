"use client";

import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { WatchStatus } from "./watch-status";

// The live watch, pinned to the bottom of the nav (mt-auto), just above the
// footer.
export function SidebarWatch() {
  return (
    <SidebarGroup className="mt-auto">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <WatchStatus />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// Settings, as a footer item beside the collapse control. Reading the URL
// for the active state blocks prerendering outside Suspense (Cache
// Components), so the link prerenders inactive and the URL-aware one
// streams in.
export function SidebarSettingsItem({ className }: { className?: string }) {
  return (
    <SidebarMenuItem className={className}>
      <Suspense fallback={<SettingsLink active={false} />}>
        <ActiveSettingsLink />
      </Suspense>
    </SidebarMenuItem>
  );
}

function ActiveSettingsLink() {
  return <SettingsLink active={usePathname() === "/settings"} />;
}

function SettingsLink({ active }: { active: boolean }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton asChild isActive={active} tooltip="Settings">
      <Link href="/settings" onClick={() => setOpenMobile(false)}>
        <SettingsIcon />
        <span>Settings</span>
      </Link>
    </SidebarMenuButton>
  );
}
