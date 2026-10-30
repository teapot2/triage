"use client";

import { GlobeIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_CHECKS } from "@/lib/investigation/uptime/model";
import { useChecks } from "./endpoint-client";

// New endpoint, beside New rule in the Watch header. At the limit it's
// disabled, with the reason in a tooltip; the span carries the tooltip
// because a disabled button gets no pointer events.
export function NewEndpointButton() {
  const { checks } = useChecks();
  const full = (checks?.length ?? 0) >= MAX_CHECKS;
  if (!full) {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link href="/watch/endpoints/new">
          <GlobeIcon />
          New endpoint
        </Link>
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>
          <Button variant="outline" size="sm" disabled>
            <GlobeIcon />
            New endpoint
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Up to {MAX_CHECKS} endpoints. Delete one to add another.</TooltipContent>
    </Tooltip>
  );
}
