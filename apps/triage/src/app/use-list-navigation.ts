"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { type ListParams, listHref } from "./list-params";

// Moves the incident list to another state, replacing the history entry and
// keeping the scroll position, with `pending` true until the rows arrive.
export function useListNavigation() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (params: ListParams) =>
    startTransition(() => {
      router.replace(listHref(params), { scroll: false });
    });
  return { pending, go };
}
