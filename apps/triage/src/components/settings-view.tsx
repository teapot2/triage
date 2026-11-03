"use client";

import { ArchiveIcon, BellIcon, CpuIcon, FileTextIcon, SlidersHorizontalIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { type MenuSection, SectionMenu, selectSection } from "@/components/section-menu";

export type SettingsSectionId = "general" | "models" | "notifications" | "postmortems" | "archived";

const sections: MenuSection<SettingsSectionId>[] = [
  { id: "general", label: "General", icon: <SlidersHorizontalIcon /> },
  { id: "models", label: "Models", icon: <CpuIcon /> },
  { id: "notifications", label: "Notifications", icon: <BellIcon /> },
  { id: "postmortems", label: "Postmortems", icon: <FileTextIcon /> },
  { id: "archived", label: "Archived incidents", icon: <ArchiveIcon /> },
];

// Settings' sections in the incident report's menu, one at a time, the open
// one in the URL (?section=models). The page renders each section's content;
// this only picks which one shows.
export function SettingsView({ content }: { content: Record<SettingsSectionId, ReactNode> }) {
  const searchParams = useSearchParams();
  const asked = searchParams.get("section");
  const current = sections.find((s) => s.id === asked)?.id ?? "general";
  return (
    <SectionMenu
      label="Settings sections"
      besideFrom="4xl"
      sections={sections}
      current={current}
      onSelect={(id) => {
        if (id !== current) selectSection(searchParams, id, "general");
      }}
    >
      {content[current]}
    </SectionMenu>
  );
}
