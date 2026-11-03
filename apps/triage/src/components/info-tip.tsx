"use client";

import { InfoIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

// An explanation kept out of the way: a small info icon beside a label that
// shows what the label means when hovered or focused. For what an
// experienced reader may still need once (what a field refers to, a rule
// that isn't obvious), where a hint under the field would sit there on every
// visit. A hover card rather than a tooltip, so the pointer can move onto
// it and its text can be selected; a tap opens it too, for touch screens,
// which have no hover. `label` names the icon for screen readers: "About
// the service directory".
export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // A mouse opens it by hovering, so its click changes nothing.
          onPointerUp={(e) => e.pointerType !== "mouse" && setOpen((o) => !o)}
          className={cn(
            "inline-flex shrink-0 rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
            className,
          )}
        >
          <InfoIcon className="size-3.5" aria-hidden />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 max-w-[calc(100vw-2rem)] text-xs leading-relaxed">
        {children}
      </HoverCardContent>
    </HoverCard>
  );
}
