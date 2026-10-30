"use client";

import { ChevronDownIcon, ChevronUpIcon, LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type BuiltInSection,
  builtInSections,
  type CustomSection,
  keptBuiltIns,
  type Template,
  type TemplateSection,
} from "@/lib/investigation/postmortem/template";

type Reply = { template: Template; isDefault: boolean };
// A request's outcome: the server kept it, turned it down with problems to
// show, or couldn't be reached (a toast says so).
type Outcome = "saved" | "rejected" | "failed";
// A custom section as the dialog drafts it: no id until the server gives one.
type Draft = { name: string; instructions: string };

const nameMax = 60;
const instructionsMax = 500;
const sectionsMax = 20;

const builtInLabels: Record<BuiltInSection, string> = {
  summary: "Summary",
  impact: "Impact",
  timeline: "Timeline",
  factors: "Contributing factors",
  lessons: "Lessons (what went well and what didn't)",
  lucky: "Where we got lucky",
  actions: "Action items",
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const rowKey = (s: TemplateSection) => (s.kind === "builtin" ? s.key : s.id);
const rowLabel = (s: TemplateSection) => (s.kind === "builtin" ? builtInLabels[s.key] : s.name);

// The Postmortems section of Settings: the sections Triage writes in a
// postmortem, in order. A person reorders and removes them, adds back the
// built-in ones that were removed, writes custom ones (a name and the
// instructions the model fills it from), or restores the defaults. One
// template for the whole app, saved on the server: every change sends the
// whole list, and the list shown is always what the server answered with, so
// a custom section's id and a rejection are never guessed at here.
export function PostmortemTemplateSettings() {
  const [data, setData] = useState<Reply>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  // Why the server turned the last change down.
  const [problems, setProblems] = useState<string[]>([]);
  // The dialog: a new custom section, or the one being edited.
  const [editing, setEditing] = useState<{ section?: CustomSection }>();
  const list = useRef<HTMLUListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once a save finishes: a disabled button drops it.
  const afterSave = useRef<() => void>(undefined);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/settings/postmortem", { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as Reply);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setLoadError(message(err));
      });
    return () => ctrl.abort();
  }, [attempt]);

  useEffect(() => {
    if (saving) return;
    afterSave.current?.();
    afterSave.current = undefined;
  }, [saving]);

  async function request(method: "PUT" | "DELETE", template?: Template): Promise<Outcome> {
    setSaving(true);
    setProblems([]);
    try {
      const res = await fetch("/api/settings/postmortem", {
        method,
        ...(template && { headers: { "content-type": "application/json" }, body: JSON.stringify({ template }) }),
      });
      const body = (await res.json()) as Partial<Reply> & { error?: string; problems?: string[] };
      if (res.ok && body.template) {
        setData({ template: body.template, isDefault: body.isDefault ?? false });
        toast.success(method === "DELETE" ? "Defaults restored" : "Template saved");
        return "saved";
      }
      if (res.status === 400) {
        setProblems(body.problems?.length ? body.problems : [body.error ?? "The template isn't valid."]);
        return "rejected";
      }
      toast.error(`Couldn't save the template: ${body.error ?? `HTTP ${res.status}`}`);
      return "failed";
    } catch (err) {
      toast.error(`Couldn't save the template: ${message(err)}`);
      return "failed";
    } finally {
      setSaving(false);
    }
  }

  const sections = data?.template.sections ?? [];
  const save = (next: TemplateSection[]) => request("PUT", { sections: next });

  function move(index: number, delta: -1 | 1) {
    const next = [...sections];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    const key = rowKey(next[index + delta]);
    // Keep focus on the row that moved: the same button, or its pair when the
    // row reached an end.
    afterSave.current = () => {
      const row = list.current?.querySelector(`[data-row="${key}"]`);
      const wanted = row?.querySelector<HTMLButtonElement>(`[data-move="${delta}"]:not(:disabled)`);
      (wanted ?? row?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)"))?.focus();
    };
    void save(next);
  }

  function remove(index: number) {
    afterSave.current = () => addButton.current?.focus();
    void save(sections.filter((_, i) => i !== index));
  }

  function addBuiltIn(key: BuiltInSection) {
    void save([...sections, { kind: "builtin", key }]);
  }

  async function submit(draft: Draft): Promise<Outcome | undefined> {
    const existing = editing?.section;
    if (existing && existing.name === draft.name && existing.instructions === draft.instructions) return "saved";
    // A new section goes without an id; the server gives it one.
    const next = existing
      ? sections.map((s) => (s.kind === "custom" && s.id === existing.id ? { ...s, ...draft } : s))
      : [...sections, { kind: "custom", ...draft }];
    return save(next as TemplateSection[]);
  }

  const missing = builtInSections.filter((key) => !keptBuiltIns({ sections }).includes(key));
  const full = sections.length >= sectionsMax;

  return (
    <section aria-labelledby="postmortems" className="flex flex-col gap-3">
      <SettingsSectionHeader
        id="postmortems"
        title="Postmortems"
        description="The sections Triage writes in a postmortem, in order. The header and the Evidence appendix are always there."
      />

      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load the postmortem template</AlertTitle>
          <AlertDescription className="break-words">{loadError}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setLoadError(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {!data && !loadError && (
        <div className="divide-y rounded-lg border" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-2 px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </div>
      )}

      {data && (
        <>
          <ul ref={list} aria-busy={saving} className="divide-y overflow-hidden rounded-lg border">
            {sections.map((section, i) => {
              const label = rowLabel(section);
              return (
                <li
                  key={rowKey(section)}
                  data-row={rowKey(section)}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                >
                  {section.kind === "custom" ? (
                    <button
                      type="button"
                      onClick={() => setEditing({ section })}
                      disabled={saving}
                      className="-mx-2 flex min-w-0 flex-1 basis-48 flex-col gap-0.5 rounded-md px-2 py-1 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none"
                    >
                      <span className="flex flex-wrap items-center gap-2 font-medium text-sm">
                        {section.name}
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          Custom
                        </Badge>
                        <span className="sr-only">. Edit this section</span>
                      </span>
                      <span className="truncate text-muted-foreground text-xs">
                        {section.instructions.split("\n")[0]}
                      </span>
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 basis-48 font-medium text-sm">{label}</span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      data-move="-1"
                      onClick={() => move(i, -1)}
                      disabled={saving || i === 0}
                    >
                      <ChevronUpIcon />
                      <span className="sr-only">Move {label} up</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      data-move="1"
                      onClick={() => move(i, 1)}
                      disabled={saving || i === sections.length - 1}
                    >
                      <ChevronDownIcon />
                      <span className="sr-only">Move {label} down</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(i)}
                      disabled={saving || sections.length === 1}
                      title={sections.length === 1 ? "A postmortem needs at least one section" : undefined}
                    >
                      <XIcon />
                      <span className="sr-only">Remove {label}</span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>

          {problems.length > 0 && (
            <Alert variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setProblems([])}>
              <AlertTitle>Couldn&apos;t save the template</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {problems.map((p) => (
                    <li key={p} className="break-words">
                      {p}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={addButton} variant="outline" size="sm" disabled={saving || full}>
                  {saving ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
                  Add section
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64 max-w-[calc(100vw-2rem)]">
                {missing.map((key) => (
                  <DropdownMenuItem key={key} onSelect={() => addBuiltIn(key)}>
                    {builtInLabels[key]}
                  </DropdownMenuItem>
                ))}
                {missing.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => setEditing({})}>Custom section…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {full && <span className="text-muted-foreground text-xs">A postmortem has at most {sectionsMax} sections.</span>}

            {!data.isDefault && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="ml-auto" disabled={saving}>
                    Restore defaults
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Restore the default sections?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The seven built-in sections come back in their usual order, and any custom sections are deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void request("DELETE")}>Restore defaults</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </>
      )}

      {editing && (
        <SectionDialog
          section={editing.section}
          saving={saving}
          onSubmit={submit}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
  );
}

// The dialog for a custom section, new or existing. Mounted while open, so
// each opening starts from the section as saved. Empty fields are refused
// here; the server checks the rest.
function SectionDialog({
  section,
  saving,
  onSubmit,
  onClose,
}: {
  section?: CustomSection;
  saving: boolean;
  onSubmit: (draft: Draft) => Promise<Outcome | undefined>;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(section?.name ?? "");
  const [instructions, setInstructions] = useState(section?.instructions ?? "");
  const [tried, setTried] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const instructionsField = useRef<HTMLTextAreaElement>(null);

  const nameError = name.trim() ? undefined : "Give the section a name.";
  const instructionsError = instructions.trim() ? undefined : "Say what the model should write in it.";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (nameError || instructionsError) {
      (nameError ? nameField : instructionsField).current?.focus();
      return;
    }
    const outcome = await onSubmit({ name: name.trim(), instructions: instructions.trim() });
    if (outcome !== "failed") onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{section ? "Edit section" : "Custom section"}</DialogTitle>
            <DialogDescription>
              The model writes this section from the incident&apos;s record, following your instructions.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-name`} className="font-medium text-xs">
              Name
            </label>
            <Input
              ref={nameField}
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={nameMax}
              placeholder="Customer communication"
              autoComplete="off"
              aria-invalid={tried && Boolean(nameError)}
              aria-describedby={tried && nameError ? `${id}-name-error` : undefined}
            />
            {tried && nameError && (
              <p id={`${id}-name-error`} className="text-destructive text-xs">
                {nameError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={`${id}-instructions`} className="font-medium text-xs">
                Instructions
              </label>
              <span className="text-muted-foreground text-xs" aria-hidden>
                {instructions.length}/{instructionsMax}
              </span>
            </div>
            <Textarea
              ref={instructionsField}
              id={`${id}-instructions`}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={instructionsMax}
              rows={5}
              placeholder="Who was told what and when, from the record; say if nothing was recorded."
              aria-invalid={tried && Boolean(instructionsError)}
              aria-describedby={tried && instructionsError ? `${id}-instructions-error` : undefined}
            />
            {tried && instructionsError && (
              <p id={`${id}-instructions-error`} className="text-destructive text-xs">
                {instructionsError}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving && <LoaderCircleIcon className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
