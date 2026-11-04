"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the page from the server every `intervalMs` while `active`, for
// a server-rendered page whose data changes under it (a run saving its
// steps as it goes). Stops as soon as `active` turns false.
export function useRefreshWhile(active: boolean, intervalMs = 2000) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
}
