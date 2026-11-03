"use client";

import { ArchiveIcon, ArchiveRestoreIcon, DownloadIcon, EllipsisIcon, LoaderCircleIcon, Trash2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { FormField } from "@/components/form-fields";
import { incidentJsonHref, useArchiveActions } from "@/components/incident/archive-actions";
import { SeverityMeter, statusLabel } from "@/components/incident/status-badges";
import { SearchInput } from "@/components/list-controls/search-input";
import { SettingsSectionHeader } from "@/components/settings-list";
import { Timestamp } from "@/components/timestamp";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Incident } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";

// One archived incident, as the page passes it: what the list shows, and
// whether it's a bundled example (those can be restored, never deleted).
export interface ArchivedIncident {
  id: string;
  title: string;
  service: string;
  severity: Incident["severity"];
  status: Incident["status"];
  resolvedAt?: string;
  archivedAt: string;
  example: boolean;
  // What deleting it takes with it, for the delete dialog to name.
  attached: { postmortem: boolean; questions: number; reruns: number };
}

const exampleRefusal = "Example incidents can't be deleted";

// Settings → Archived incidents: the closed incidents taken out of the
// lists, newest archived first, searchable by title or ID, in the incident
// list's shape: a row per incident linking to it, its box showing on hover,
// and a bar floating at the bottom while any are picked, to restore or
// delete them together. Each row's menu restores it, downloads its JSON or
// deletes it for good after a confirmation that names what goes. The page
// passes the list, and refreshes it after every change.
export function ArchivedIncidentSettings({ incidents }: { incidents: ArchivedIncident[] }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  // What the delete dialog is for: one row from its menu, or the selection.
  // Kept once it closes, so the dialog doesn't change as it fades out.
  const [deleting, setDeleting] = useState<{ targets: ArchivedIncident[]; bulk: boolean; skipped: number }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const askDelete = (targets: ArchivedIncident[], bulk: boolean, skipped = 0) => {
    setDeleting({ targets, bulk, skipped });
    setDeleteOpen(true);
  };
  const { restore, remove, pending } = useArchiveActions();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return incidents;
    return incidents.filter((i) => i.title.toLowerCase().includes(q) || i.id.toLowerCase().includes(q));
  }, [incidents, query]);
  // Only what's on screen stays picked: a search that hides a row lets go
  // of it, so a bulk action never reaches what can't be seen.
  const selected = shown.filter((i) => picked.includes(i.id));
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => (on ? [...prev.filter((p) => p !== id), id] : prev.filter((p) => p !== id)));
  const drop = (done: string[]) => setPicked((prev) => prev.filter((id) => !done.includes(id)));
  const count = selected.length;

  // Escape lets go of the selection, unless something else (a menu, the
  // search box, the dialog) took it first.
  useEffect(() => {
    if (count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setPicked([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  return (
    <section aria-labelledby="archived" className="flex flex-col gap-3">
      <SettingsSectionHeader id="archived" title="Archived incidents" />

      {incidents.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-10 text-center">
          <ArchiveIcon className="mb-1 size-5 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">No archived incidents</p>
        </div>
      ) : (
        <>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search by title or ID"
            label="Search archived incidents"
            className="max-w-xs"
          />
          {shown.length === 0 ? (
            <p className="rounded-lg border px-4 py-6 text-center text-muted-foreground text-sm">No archived incidents match.</p>
          ) : (
            <ul data-selecting={count > 0 || undefined} className="group/list divide-y rounded-lg border">
              {shown.map((incident) => (
                <ArchivedRow
                  key={incident.id}
                  incident={incident}
                  checked={picked.includes(incident.id)}
                  onCheckedChange={(on) => toggle(incident.id, on)}
                  pending={pending}
                  onRestore={() => void restore([incident.id]).then(drop)}
                  onDelete={() => askDelete([incident], false)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {count > 0 && (
        <SelectionBar
          count={count}
          all={count === shown.length}
          pending={pending}
          deletable={selected.filter((i) => !i.example)}
          onSelectAll={(on) => setPicked(on ? shown.map((i) => i.id) : [])}
          onRestore={() => void restore(selected.map((i) => i.id)).then(drop)}
          onDelete={(deletable) => askDelete(deletable, true, count - deletable.length)}
          onClear={() => setPicked([])}
        />
      )}

      {deleting && (
        <DeleteDialog
          {...deleting}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onConfirm={() => void remove(deleting.targets.map((t) => t.id)).then(drop)}
        />
      )}
    </section>
  );
}

// The bar that floats at the bottom while any are picked, as on the
// incident list: every one shown, the count, Restore and Delete, and clear.
function SelectionBar({
  count,
  all,
  pending,
  deletable,
  onSelectAll,
  onRestore,
  onDelete,
  onClear,
}: {
  count: number;
  all: boolean;
  pending: boolean;
  deletable: ArchivedIncident[];
  onSelectAll: (on: boolean) => void;
  onRestore: () => void;
  onDelete: (deletable: ArchivedIncident[]) => void;
  onClear: () => void;
}) {
  const remove = (
    <Button
      size="sm"
      variant="ghost"
      className="text-destructive hover:text-destructive"
      disabled={pending || deletable.length === 0}
      onClick={() => onDelete(deletable)}
    >
      <Trash2Icon />
      Delete
    </Button>
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Selected archived incidents"
        className="pointer-events-auto flex items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-3 text-popover-foreground text-sm shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 duration-150 motion-reduce:animate-none"
      >
        <Checkbox
          checked={all ? true : "indeterminate"}
          onCheckedChange={(on) => onSelectAll(on === true)}
          aria-label={all ? "Clear selection" : "Select every archived incident shown"}
          className="mr-2"
        />
        <span className="mr-2 tabular-nums">{count} selected</span>
        <Button size="sm" variant="outline" disabled={pending} onClick={onRestore}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArchiveRestoreIcon />}
          Restore
        </Button>
        {deletable.length === 0 ? (
          // Only examples picked: nothing to delete, and why.
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-not-allowed">{remove}</span>
            </TooltipTrigger>
            <TooltipContent>{exampleRefusal}</TooltipContent>
          </Tooltip>
        ) : (
          remove
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={onClear}>
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

// One archived incident, as a row of the incident list: its box (out of
// sight until the row is hovered or anything is picked; always there on
// touch), a link with its severity, title and what became of it, when it
// was archived, then its menu.
function ArchivedRow({
  incident,
  checked,
  onCheckedChange,
  pending,
  onRestore,
  onDelete,
}: {
  incident: ArchivedIncident;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  pending: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group/row flex items-center transition-colors hover:bg-muted/40">
      <span
        className={cn(
          "flex shrink-0 items-center self-stretch pl-4 transition-opacity duration-100 motion-reduce:transition-none",
          "opacity-0 focus-within:opacity-100 group-hover/row:opacity-100 group-data-selecting/list:opacity-100 [@media(hover:none)]:opacity-100",
          checked && "opacity-100",
        )}
      >
        <Checkbox checked={checked} onCheckedChange={(on) => onCheckedChange(on === true)} aria-label={`Select ${incident.title}`} />
      </span>
      <Link href={`/incidents/${incident.id}`} className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-3">
        <SeverityMeter severity={incident.severity} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{incident.title}</span>
          <span className="truncate text-muted-foreground text-xs">
            {incident.service} ·{" "}
            {incident.resolvedAt ? (
              <>
                resolved <Timestamp date={incident.resolvedAt} />
              </>
            ) : (
              statusLabel[incident.status].toLowerCase()
            )}
            {incident.example && " · example"}
            {/* On phones the archived time has no room of its own. */}
            <span className="sm:hidden">
              {" "}
              · archived <Timestamp date={incident.archivedAt} />
            </span>
          </span>
        </div>
        <span className="hidden w-32 shrink-0 text-right font-mono text-muted-foreground text-xs sm:block">
          <Timestamp date={incident.archivedAt} />
        </span>
      </Link>
      <div className="pr-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${incident.title}`} disabled={pending}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={incident.example ? "w-60" : "w-52"}>
            <DropdownMenuItem onSelect={onRestore}>
              <ArchiveRestoreIcon />
              Restore
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={incidentJsonHref(incident.id)} download>
                <DownloadIcon />
                Download JSON
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={incident.example}
              onSelect={onDelete}
              className="items-start"
            >
              <Trash2Icon className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                Delete permanently
                {incident.example && <span className="text-muted-foreground text-xs">{exampleRefusal}</span>}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

// "Also deletes its postmortem and 4 Ask questions." for what deleting the
// targets takes with them, counted; nothing when there's nothing but the
// records. Ask questions take their images with them.
function attachedSentence(targets: ArchivedIncident[]): string {
  const sum = (f: (a: ArchivedIncident["attached"]) => number) => targets.reduce((n, t) => n + f(t.attached), 0);
  const postmortems = sum((a) => (a.postmortem ? 1 : 0));
  const questions = sum((a) => a.questions);
  const reruns = sum((a) => a.reruns);
  const one = targets.length === 1;
  const count = (n: number, word: string, words: string) => `${n} ${n === 1 ? word : words}`;
  const parts = [
    postmortems > 0 && (one ? "its postmortem" : count(postmortems, "postmortem", "postmortems")),
    questions > 0 && count(questions, "Ask question", "Ask questions"),
    reruns > 0 && count(reruns, "re-run", "re-runs"),
  ].filter((p): p is string => !!p);
  if (parts.length === 0) return "";
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Also deletes ${list}. `;
}

// Deleting for good asks first: which incident (its title, ID and when it
// was archived, under a short title rather than in it), what goes with it,
// counted, and its JSON to keep, as the footer's secondary action. Several
// at once list their titles with a JSON each, and ask for their number,
// typed, so a stray click on a long selection can't do it.
function DeleteDialog({
  targets,
  bulk,
  skipped,
  open,
  onOpenChange,
  onConfirm,
}: {
  targets: ArchivedIncident[];
  bulk: boolean;
  // Examples in the selection, which stay.
  skipped: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  // Each opening starts with the box empty.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setTyped("");
  }
  const n = targets.length;
  const confirmed = !bulk || typed.trim() === String(n);
  const only = !bulk ? targets[0] : undefined;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{only ? "Delete this incident?" : `Delete ${n} ${n === 1 ? "incident" : "incidents"}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {attachedSentence(targets)}This can&apos;t be undone.
            {skipped > 0 && ` ${skipped === 1 ? "One example incident stays" : `${skipped} example incidents stay`}: examples can't be deleted.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {only ? (
          <div className="flex min-w-0 flex-col gap-0.5 rounded-md border px-3 py-2">
            <span className="break-words font-medium text-sm">{only.title}</span>
            <span className="text-muted-foreground text-xs">
              <span className="font-mono">{only.id}</span> · archived <Timestamp date={only.archivedAt} />
            </span>
          </div>
        ) : (
          <>
            {/* Each one's JSON, to keep before it goes. */}
            <ul className="max-h-40 divide-y overflow-y-auto rounded-md border text-sm">
              {targets.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1 pr-1 pl-3">
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <Button variant="ghost" size="xs" asChild>
                    <a href={incidentJsonHref(t.id)} download aria-label={`Download the JSON of ${t.title}`}>
                      <DownloadIcon />
                      JSON
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
            <FormField label={`Type ${n} to confirm`} htmlFor={id}>
              <Input
                id={id}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                className="w-full"
              />
            </FormField>
          </>
        )}
        <AlertDialogFooter>
          {only && (
            <Button variant="ghost" size="sm" className="sm:mr-auto" asChild>
              <a href={incidentJsonHref(only.id)} download>
                <DownloadIcon />
                Download JSON
              </a>
            </Button>
          )}
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={!confirmed} onClick={onConfirm}>
            {bulk ? `Delete ${n}` : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
