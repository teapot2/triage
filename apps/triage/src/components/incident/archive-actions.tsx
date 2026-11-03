"use client";

import { ArchiveIcon, ArchiveRestoreIcon, LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { exportHref } from "@/components/export-menu";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { incidentRecord } from "@/lib/export/datasets/incident";
import { errorMessage } from "@/lib/errors";
import type { Incident } from "@/lib/investigation/schema";

// Archive, restore and permanent delete from the browser: one request per
// incident, through the routes under /api/incidents/[id] (the rules are in
// lib/investigation/archive.ts). Each says how it went in a toast and
// refreshes the page, so what's shown is what the server saved. Archiving
// offers Undo for a while, since it asks nothing first.

type Outcome = { done: string[]; failed: { id: string; error: string }[] };

async function each(ids: string[], method: "POST" | "DELETE", path: (id: string) => string): Promise<Outcome> {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(path(id), { method });
        if (res.ok) return { id };
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { id, error: body.error ?? `HTTP ${res.status}` };
      } catch (err) {
        return { id, error: errorMessage(err) };
      }
    }),
  );
  return {
    done: results.filter((r) => r.error === undefined).map((r) => r.id),
    failed: results.flatMap((r) => (r.error === undefined ? [] : [{ id: r.id, error: r.error }])),
  };
}

const archivePath = (id: string) => `/api/incidents/${encodeURIComponent(id)}/archive`;
const incidentPath = (id: string) => `/api/incidents/${encodeURIComponent(id)}`;

// "Incident archived", "3 incidents archived".
const counted = (n: number, verb: string) => (n === 1 ? `Incident ${verb}` : `${n} incidents ${verb}`);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// How long Undo stays on an archive's toast.
const UNDO_MS = 10_000;

export function useArchiveActions() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function run(ids: string[], method: "POST" | "DELETE", path: (id: string) => string, failVerb: string) {
    setPending(true);
    const outcome = await each(ids, method, path);
    setPending(false);
    router.refresh();
    if (outcome.failed.length > 0) {
      const n = outcome.failed.length;
      toast.error(`Couldn't ${failVerb} ${ids.length === 1 ? "the incident" : `${n} of ${ids.length} incidents`}`, {
        description: sentence(outcome.failed[0].error),
      });
    }
    return outcome;
  }

  async function restore(ids: string[]) {
    const { done } = await run(ids, "DELETE", archivePath, "restore");
    if (done.length > 0) toast.success(counted(done.length, "restored"));
    return done;
  }

  async function archive(ids: string[]) {
    const { done } = await run(ids, "POST", archivePath, "archive");
    if (done.length > 0) {
      toast(counted(done.length, "archived"), {
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => void restore(done) },
      });
    }
    return done;
  }

  async function remove(ids: string[]) {
    const { done } = await run(ids, "DELETE", incidentPath, "delete");
    if (done.length > 0) toast.success(counted(done.length, "deleted"));
    return done;
  }

  return { archive, restore, remove, pending };
}

// The incident's full record as JSON, to keep before deleting it.
export const incidentJsonHref = (id: string) => exportHref(incidentRecord, { id }, "json");

// Above the report of an archived incident: when it was archived, and the
// way back. Everything that would change it is hidden until then.
export function ArchivedNotice({ incident }: { incident: Pick<Incident, "id" | "archivedAt"> }) {
  const { restore, pending } = useArchiveActions();
  if (!incident.archivedAt) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-muted-foreground/40 border-l-2 py-0.5 pl-3 text-muted-foreground text-sm">
      <p className="flex min-w-0 flex-1 items-center gap-2">
        <ArchiveIcon className="size-4 shrink-0" aria-hidden />
        <span>
          Archived on <Timestamp date={incident.archivedAt} />
        </span>
      </p>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => void restore([incident.id])}>
        {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArchiveRestoreIcon />}
        Restore
      </Button>
    </div>
  );
}
