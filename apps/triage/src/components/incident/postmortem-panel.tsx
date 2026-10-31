"use client";

import {
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  FileDownIcon,
  FileTextIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ExportCommands, ExportMenuItems, type ExportSource } from "@/components/export-menu";
import { Timestamp } from "@/components/timestamp";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { postmortemActions } from "@/lib/export/datasets/postmortem";
import { downloadText } from "@/lib/export/download";
import { progressOf, sectionKey } from "@/lib/investigation/postmortem/draft";
import { postmortemMarkdown } from "@/lib/investigation/postmortem/render";
import { postmortemRefusal } from "@/lib/investigation/postmortem/rules";
import type { DraftContent, Incident } from "@/lib/investigation/schema";
import { modelLabel } from "@/lib/models/labels";
import { MarkdownDoc } from "./markdown-doc";
import { clock, contentOf, DraftDocument, DraftStatus, templateOf, usePostmortemDraft, useReveal } from "./postmortem-draft";

// The Postmortem section: Triage writes a blameless postmortem from the
// incident's record on request, writing it into the page as it goes
// (postmortem-draft.tsx), and shows it as the document it exports, to copy
// as Markdown or download. The record is the model's judgment; the
// document around it is rendered here from the incident, so Copy and
// Download always match what's on screen.

// Whether the incident has a Postmortem section: once a report names
// something wrong.
export function hasPostmortem(incident: Incident): boolean {
  return incident.report !== undefined && incident.report.verdict.kind !== "healthy";
}

// The server's words ("the fix is still being written: …") as a sentence.
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The server's rule, for the button's tooltip.
export function writeRefusal(incident: Incident): string | undefined {
  const refusal = postmortemRefusal(incident);
  return refusal && sentence(refusal);
}

export function copyPostmortem(incident: Incident) {
  navigator.clipboard
    ?.writeText(postmortemMarkdown(incident))
    .then(() => toast.success("Postmortem copied"))
    .catch(() => toast.error("Couldn't copy the postmortem", { description: "The browser blocked clipboard access." }));
}

function downloadPostmortem(incident: Incident) {
  downloadText(postmortemMarkdown(incident), `postmortem-${incident.id}.md`, "text/markdown");
}

// Saves the postmortem as a PDF through the browser's print dialog ("Save
// as PDF"): the page prints only the document (globals.css, under
// printing-postmortem), and the browser names the file after the page's
// title, so the title is the Markdown file's name while the dialog is open.
// The palette may ask while the section is still mounting: it waits up to a
// second for the document to be on the page.
export async function savePostmortemPdf(incident: Incident) {
  for (let i = 0; i < 20 && !document.querySelector("[data-print-root]"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!document.querySelector("[data-print-root]")) {
    toast.error("Couldn't save the postmortem as a PDF", { description: "Open its section and try again." });
    return;
  }
  const root = document.documentElement;
  const title = document.title;
  root.classList.add("printing-postmortem");
  document.title = `postmortem-${incident.id}`;
  window.addEventListener(
    "afterprint",
    () => {
      root.classList.remove("printing-postmortem");
      document.title = title;
    },
    { once: true },
  );
  window.print();
}

// The palette asks for a write while the section may still be mounting; the
// panel picks the request up when it mounts, or hears it if it's open.
const WRITE_EVENT = "triage:write-postmortem";
let writePending = false;

export function requestPostmortemWrite() {
  writePending = true;
  window.dispatchEvent(new Event(WRITE_EVENT));
}

// Starts a write. The route answers 202 and saves the record a beat later,
// so after it's accepted the page refreshes every second until the record
// changes; the draft's live stream and useRefreshWhile follow it from there.
function useWritePostmortem(incident: Incident) {
  const router = useRouter();
  const startedAt = incident.postmortem?.startedAt;
  // The record's start when the write was asked for; null when none is.
  const [sentFrom, setSentFrom] = useState<{ from: string | undefined; accepted: boolean } | null>(null);
  if (sentFrom?.accepted && sentFrom.from !== startedAt) setSentFrom(null);

  const write = useCallback(async () => {
    setSentFrom({ from: startedAt, accepted: false });
    try {
      const res = await fetch(`/api/incidents/${incident.id}/postmortem`, { method: "POST" });
      if (res.status !== 202) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSentFrom({ from: startedAt, accepted: true });
      toast("Writing the postmortem");
      router.refresh();
    } catch (err) {
      setSentFrom(null);
      toast.error("Couldn't write the postmortem", { description: sentence(err instanceof Error ? err.message : String(err)) });
    }
  }, [incident.id, startedAt, router]);

  // Give up after a while, in case the record never comes: the section
  // shows whatever the incident has then.
  const accepted = sentFrom?.accepted ?? false;
  useEffect(() => {
    if (!accepted) return;
    const timer = setInterval(() => router.refresh(), 1000);
    const stop = setTimeout(() => setSentFrom(null), 15_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [accepted, router]);

  useEffect(() => {
    function onRequest() {
      writePending = false;
      void write();
    }
    if (writePending) onRequest();
    window.addEventListener(WRITE_EVENT, onRequest);
    return () => window.removeEventListener(WRITE_EVENT, onRequest);
  }, [write]);

  return { write, sending: sentFrom !== null, accepted };
}

const NOTHING: DraftContent = {};
const WHOLE = { open: undefined, complete: true };

export function PostmortemPanel({ incident }: { incident: Incident }) {
  const pm = incident.postmortem;
  const { write, sending, accepted } = useWritePostmortem(incident);
  const refusal = writeRefusal(incident);
  const markdown = useMemo(() => (pm?.status === "ready" ? postmortemMarkdown(incident) : ""), [pm?.status, incident]);
  const draft = usePostmortemDraft(incident);
  const template = templateOf(incident);

  // The write this panel watched, and its attempt: once it's ready, the
  // rest of it is revealed before the document takes the draft's place.
  const [watched, setWatched] = useState<{ startedAt: string; attempt: number }>();
  if (pm?.status === "writing" && (watched?.startedAt !== pm.startedAt || (draft && draft.attempt !== watched.attempt))) {
    setWatched({ startedAt: pm.startedAt, attempt: draft?.attempt ?? 1 });
  }
  const finishing = pm?.status === "ready" && watched?.startedAt === pm.startedAt;
  const target = useMemo(
    () => (pm?.status === "writing" ? (draft?.content ?? NOTHING) : finishing ? contentOf(pm) : NOTHING),
    [pm, draft, finishing],
  );
  const progress = pm?.status === "writing" && draft ? progressOf(draft) : WHOLE;
  const attempt = (pm?.status === "writing" ? draft?.attempt : undefined) ?? watched?.attempt ?? 1;
  const reveal = useReveal(target, template, progress, `${pm?.startedAt}:${attempt}`);
  if (finishing && reveal.caughtUp) setWatched(undefined);

  // Writing, or accepted and not saved yet, which reads as writing already.
  const writing = pm?.status === "writing" || finishing;
  if (writing || accepted) {
    const at = reveal.at;
    const keys = template.sections.map(sectionKey);
    return (
      <div className="flex flex-col gap-4">
        <DraftStatus
          startedAt={writing ? pm.startedAt : undefined}
          attempt={draft?.attempt ?? 1}
          problems={pm?.status === "writing" ? draft?.problems : undefined}
          model={writing ? pm.model : undefined}
          written={!writing ? 0 : at === undefined ? keys.length : Math.max(0, keys.indexOf(at))}
          sections={keys.length}
        />
        <DraftDocument
          incident={incident}
          content={writing ? reveal.content : NOTHING}
          template={template}
          at={writing ? at : undefined}
          mode="writing"
          thinking={pm?.status === "writing" ? draft?.thinking : undefined}
        />
      </div>
    );
  }

  if (!pm) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border p-4">
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <FileTextIcon className="size-3.5" />
          Postmortem
        </span>
        <p className="text-sm leading-relaxed">
          Triage writes a blameless postmortem from this incident&apos;s record: a summary, the impact, a timeline,
          the contributing factors, lessons and action items, with every claim cited to its evidence. Copy it as
          Markdown or download it for your team&apos;s docs.
        </p>
        <WriteButton refusal={refusal} sending={sending} onClick={write}>
          Write the postmortem
        </WriteButton>
      </div>
    );
  }

  if (pm.status === "failed") {
    // What was written before it stopped, under the error.
    const partial = pm.draft && Object.keys(pm.draft.content).length > 0 ? pm.draft : undefined;
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive" className="has-data-[slot=alert-action]:pr-28">
          <AlertTitle>{partial ? "The postmortem stopped part-way" : "The postmortem wasn’t written"}</AlertTitle>
          {pm.error && <AlertDescription className="line-clamp-3 break-words">{pm.error}</AlertDescription>}
          <AlertAction>
            <WriteButton refusal={refusal} sending={sending} onClick={write} size="xs" variant="outline">
              Try again
            </WriteButton>
          </AlertAction>
        </Alert>
        {partial && (
          <div className="opacity-70">
            <DraftDocument incident={incident} content={partial.content} template={template} at={partial.writing} mode="stopped" />
          </div>
        )}
      </div>
    );
  }

  // The judgment predates the resolution; the document around it doesn't.
  const written = pm.finishedAt ?? pm.startedAt;
  const stale = incident.resolvedAt !== undefined && Date.parse(incident.resolvedAt) > Date.parse(written);
  const actionExports: ExportSource[] = pm.actionItems?.length
    ? [{ dataset: postmortemActions, params: { id: incident.id } }]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 text-muted-foreground text-xs">
          Written <Timestamp date={written} /> · {modelLabel(pm.model, pm.provider, pm.reasoningEffort)}
          {pm.finishedAt && <> · took {clock(Date.parse(pm.finishedAt) - Date.parse(pm.startedAt))}</>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {stale && <span className="text-muted-foreground text-xs">Written before the incident resolved</span>}
          {/* Quiet, icon-only: their names show on hover. */}
          <WriteButton refusal={refusal} sending={sending} onClick={write} size="icon-sm" variant="ghost">
            Write again
          </WriteButton>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Copy Markdown" onClick={() => copyPostmortem(incident)}>
                <CopyIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy Markdown</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <DownloadIcon />
                Download
                <ChevronDownIcon className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => void savePostmortemPdf(incident)}>
                <FileDownIcon />
                PDF
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => downloadPostmortem(incident)}>
                <FileCodeIcon />
                Markdown (.md)
              </DropdownMenuItem>
              {/* The action items alone, to file as tickets. */}
              {actionExports.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <ExportMenuItems exports={actionExports} />
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <ExportCommands exports={actionExports} />
        </div>
      </div>
      {/* What Download's PDF prints. */}
      <article data-print-root className="rounded-lg border px-4 py-5 sm:px-8 sm:py-7">
        <MarkdownDoc text={markdown} />
      </article>
    </div>
  );
}

// Write, Write again and Try again: disabled with the reason on hover while
// the server would refuse, a spinner while the request is out. Ghost and
// icon-only (Write again), with its name on hover instead.
function WriteButton({
  refusal,
  sending,
  onClick,
  children,
  size = "sm",
  variant = "default",
}: {
  refusal: string | undefined;
  sending: boolean;
  onClick: () => void;
  children: string;
  size?: "xs" | "sm" | "icon-sm";
  variant?: "default" | "outline" | "ghost";
}) {
  const iconOnly = size === "icon-sm";
  const button = (
    <Button
      size={size}
      variant={variant}
      disabled={sending || refusal !== undefined}
      onClick={onClick}
      aria-label={iconOnly ? children : undefined}
    >
      {sending ? <LoaderCircleIcon className="animate-spin" /> : variant !== "default" && <RotateCcwIcon />}
      {!iconOnly && children}
    </Button>
  );
  if (!refusal && iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{children}</TooltipContent>
      </Tooltip>
    );
  }
  if (!refusal) return button;
  // A disabled button gets no pointer events; its wrapper shows the tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{refusal}</TooltipContent>
    </Tooltip>
  );
}
