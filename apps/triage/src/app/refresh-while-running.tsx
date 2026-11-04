"use client";

import { useRefreshWhile } from "@/hooks/use-refresh-while";

// The list is rendered on the server; while a run shown on it is going, it
// re-renders every few seconds so the row moves on from Investigating by
// itself. Nothing on screen.
export function RefreshWhileRunning({ running }: { running: boolean }) {
  useRefreshWhile(running, 3000);
  return null;
}
