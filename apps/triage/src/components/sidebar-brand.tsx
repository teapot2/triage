import Link from "next/link";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { TriageMark } from "./triage-mark";

// Compact brand row, linking home: the mark sized like the nav icons so the
// column of icons lines up, expanded or collapsed, then the wordmark in the
// app's Geist. The collapse/expand control lives in the footer.
export function SidebarBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Triage">
          <Link href="/">
            <TriageMark className="text-foreground" />
            <span className="font-semibold tracking-tight">Triage</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
