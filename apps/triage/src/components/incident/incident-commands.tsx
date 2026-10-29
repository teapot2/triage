"use client";

import { LayoutListIcon, LinkIcon, MessageSquareTextIcon, RouteIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";
import { type PaletteCommand, useRegisterCommands } from "@/components/command-registry";
import type { Incident } from "@/lib/investigation/schema";
import { evidenceIcons, useEvidence } from "./evidence";
import { evidenceTitle } from "./metric-labels";
import { requestComposerFocus } from "./questions-panel";

export const THIS_INCIDENT = "This incident";

// The incident page's commands in the search palette: jump to a section,
// open any evidence by number or name, copy a link. Approve and deny are
// registered by the header, which owns the decision.
export function IncidentCommands({ incident }: { incident: Incident }) {
  const { byId, numberOf, open } = useEvidence();

  const section = (id: string) => () => {
    // The report reads its section from the URL; same as its own menu.
    window.history.pushState(null, "", `?section=${id}`);
  };

  const commands: PaletteCommand[] = [
    { id: "section-overview", group: THIS_INCIDENT, label: "Go to Overview", icon: LayoutListIcon, pinned: true, run: section("overview") },
    ...(incident.fix
      ? [{ id: "section-fix", group: THIS_INCIDENT, label: "Go to Fix", icon: WrenchIcon, pinned: true, run: section("fix") }]
      : []),
    ...(incident.steps.length > 0
      ? [
          {
            id: "section-investigation",
            group: THIS_INCIDENT,
            label: "Go to Investigation",
            icon: RouteIcon,
            pinned: true,
            run: section("investigation"),
          },
        ]
      : []),
    ...(incident.report
      ? [
          {
            id: "ask",
            group: THIS_INCIDENT,
            label: "Ask Triage",
            icon: MessageSquareTextIcon,
            keywords: "question follow-up",
            pinned: true,
            run: () => {
              section("questions")();
              requestComposerFocus();
            },
          },
        ]
      : []),
    {
      id: "copy-link",
      group: THIS_INCIDENT,
      label: "Copy link to this incident",
      icon: LinkIcon,
      pinned: true,
      run: () => {
        const url = `${window.location.origin}/incidents/${incident.id}`;
        navigator.clipboard
          ?.writeText(url)
          .then(() => toast.success("Link copied", { description: url }))
          .catch(() => toast.error("Couldn't copy the link", { description: "The browser blocked clipboard access." }));
      },
    },
    // Every evidence item, numbered like its citations; only while searching,
    // so the palette's opening view stays short.
    ...[...byId.values()]
      .sort((a, b) => (numberOf.get(a.id) ?? 0) - (numberOf.get(b.id) ?? 0))
      .map((e) => ({
        id: `evidence-${e.id}`,
        group: THIS_INCIDENT,
        label: `Evidence ${numberOf.get(e.id)} · ${evidenceTitle(e)}`,
        icon: evidenceIcons[e.kind],
        keywords: `evidence ${e.id} ${e.tool} ${e.kind}`,
        run: () => open(e.id),
      })),
  ];

  useRegisterCommands("incident", commands);
  return null;
}
