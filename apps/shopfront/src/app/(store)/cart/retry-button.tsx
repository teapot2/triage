"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

export function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button size="lg" className="mt-8 h-11 px-5" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
      {pending ? "Trying again…" : "Try again"}
    </Button>
  );
}
