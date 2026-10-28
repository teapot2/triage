"use client";

import { useSearchParams } from "next/navigation";

// A list's controls kept in the page's URL (?q=&sort=&status=), so a reload
// or a shared link shows the same view, changed without a round trip to the
// server: Next keeps useSearchParams in step with history.replaceState.
// Values left empty are dropped, so the defaults keep the URL clean. The
// component calling it needs a Suspense boundary above it (the URL isn't
// known when the page is prerendered).
export function useUrlParams() {
  const params = useSearchParams();
  const update = (changes: Record<string, string | string[] | null | undefined>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      const text = Array.isArray(value) ? value.join(",") : value;
      if (text) next.set(key, text);
      else next.delete(key);
    }
    const query = next.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  };
  // A comma-separated list (?status=ok,idle), empty when missing.
  const list = (key: string) => params.get(key)?.split(",").filter(Boolean) ?? [];
  return { params, update, list };
}
