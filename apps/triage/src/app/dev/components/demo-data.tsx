"use client";

import { DatabaseIcon, LoaderCircleIcon, TrashIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Adds or removes the 30 demo incidents, for seeing pagination, sorting and
// every status with more than a handful of incidents.
export function DemoData() {
  const router = useRouter();
  const [busy, setBusy] = useState<"add" | "remove" | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE") {
    setBusy(method === "POST" ? "add" : "remove");
    setResult(null);
    try {
      const res = await fetch("/api/dev/demo", { method });
      const data = (await res.json()) as { added?: number; removed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data.added !== undefined ? `Added ${data.added} demo incidents.` : `Removed ${data.removed} demo incidents.`);
      router.refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => call("POST")}>
        {busy === "add" ? <LoaderCircleIcon className="animate-spin" /> : <DatabaseIcon />}
        Add demo incidents
      </Button>
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => call("DELETE")}>
        {busy === "remove" ? <LoaderCircleIcon className="animate-spin" /> : <TrashIcon />}
        Remove demo incidents
      </Button>
      {result && <span className="text-muted-foreground text-xs">{result}</span>}
    </div>
  );
}
