"use client";

import { BrainIcon, LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  draftLength,
  type Progress,
  revealDraft,
  type SectionState,
  sectionStarted,
  sectionStates,
} from "@/lib/investigation/postmortem/draft";
import type { PostmortemStreamEvent } from "@/lib/investigation/postmortem/live";
import { postmortemParts } from "@/lib/investigation/postmortem/render";
import { defaultTemplate, type Template } from "@/lib/investigation/postmortem/template";
import type { DraftContent, Incident, Postmortem, PostmortemDraft } from "@/lib/investigation/schema";
import { MarkdownDoc } from "./markdown-doc";

// The postmortem while Triage writes it, filling in the way a document does
// when Claude writes into it: the template's sections in order, the one
// being written lit with a caret at the end of its text, the ones still to
// come as placeholder lines under their headings. The draft comes live from
// the server (postmortem/stream) and is revealed a few characters a frame,
// so text arriving in bursts still reads as it's written.

// While the incident's postmortem is written: the draft as the server has
// it, live, else as last saved on the record (a reload, or a stream that
// broke off reads along from there).
export function usePostmortemDraft(incident: Incident): PostmortemDraft | undefined {
  const router = useRouter();
  const pm = incident.postmortem;
  const writing = pm?.status === "writing" ? pm.startedAt : undefined;
  const [live, setLive] = useState<Extract<PostmortemStreamEvent, { type: "draft" }>>();

  useEffect(() => {
    if (!writing) return;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // The stream ends when the write does, or at once when this server
    // isn't writing it yet (the route answered before the writer started):
    // the record is read again, and while it still says writing, the
    // stream is tried again.
    const connect = () => {
      source = new EventSource(`/api/incidents/${incident.id}/postmortem/stream`);
      source.onmessage = (e) => {
        const event = JSON.parse(e.data) as PostmortemStreamEvent;
        if (event.type === "draft") return setLive(event);
        source?.close();
        router.refresh();
        retry = setTimeout(connect, 1500);
      };
      source.onerror = () => {
        source?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      source?.close();
      clearTimeout(retry);
    };
  }, [incident.id, writing, router]);

  if (writing && live?.startedAt === writing) return live.draft;
  return pm?.draft;
}

// Characters a second the reveal runs at least, and how far behind it lets
// itself fall: it speeds up to stay within about this long of the text.
const MIN_RATE = 140;
const CATCH_UP_MS = 1500;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The draft as far as the page has revealed it (revealDraft). Starts with
// everything already there (a reload doesn't write it again), then reveals
// what arrives; a new `resetKey` (the next attempt) starts from nothing.
export function useReveal(content: DraftContent, template: Template, progress: Progress, resetKey: string) {
  const { open, complete } = progress;
  const total = useMemo(() => draftLength(content, template, { open, complete }), [content, template, open, complete]);
  const [state, setState] = useState({ key: resetKey, shown: total });
  if (state.key !== resetKey) setState({ key: resetKey, shown: 0 });
  const shown = Math.min(state.shown, total);
  const behind = shown < total;

  useEffect(() => {
    if (!behind) return;
    // Reduced motion shows what arrives at once, on the next tick.
    const instant = reducedMotion();
    let last = performance.now();
    // A timer rather than animation frames: a hidden tab gets no frames,
    // and would hold the draft back until it's shown again. Nobody watches
    // a hidden tab write, so there it shows everything at once.
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      setState((s) => {
        const left = total - s.shown;
        const rate = Math.max(MIN_RATE, (left * 1000) / CATCH_UP_MS);
        return { ...s, shown: instant || document.hidden ? total : Math.min(total, s.shown + rate * (dt / 1000)) };
      });
    }, 16);
    return () => clearInterval(timer);
  }, [behind, total]);

  const revealed = useMemo(
    () => revealDraft(content, template, Math.floor(shown), { open, complete }),
    [content, template, shown, open, complete],
  );
  return { ...revealed, caughtUp: !behind };
}

// A ready postmortem's content, to reveal the end of it as the draft's.
export function contentOf(pm: Postmortem): DraftContent {
  const { summary, impact, verdictReview, contributingFactors, wentWell, wentBadly, lucky, actionItems, custom } = pm;
  const content: DraftContent = {
    summary,
    impact,
    verdictReview,
    contributingFactors,
    wentWell,
    wentBadly,
    lucky,
    actionItems,
    custom: custom?.map(({ id, text, evidenceIds }) => ({ id, text, evidenceIds })),
  };
  for (const k of Object.keys(content) as (keyof DraftContent)[]) if (content[k] === undefined) delete content[k];
  return content;
}

const headingOf = (markdown: string) => /^## (.*)$/m.exec(markdown)?.[1] ?? "";

// The document as far as it's written. `writing`: still coming, with the
// caret at `at`, the reveal's cursor. `stopped`: a failed write, everything
// it got to, with `at` the section it stopped in.
export function DraftDocument({
  incident,
  content,
  template,
  at,
  mode,
  thinking,
}: {
  incident: Incident;
  content: DraftContent;
  template: Template;
  at: string | undefined;
  mode: "writing" | "stopped";
  thinking?: string;
}) {
  const pm = incident.postmortem;
  const parts = useMemo(() => {
    // Only the draft's content: none of a finished record's shows through
    // ahead of the reveal.
    const draft = {
      status: "writing",
      startedAt: pm?.startedAt ?? new Date(0).toISOString(),
      model: pm?.model ?? "",
      provider: pm?.provider,
      template,
      ...content,
    } as Postmortem;
    return postmortemParts({ ...incident, postmortem: draft }, { drafting: true });
  }, [incident, pm?.startedAt, pm?.model, pm?.provider, template, content]);
  const states = useMemo(
    () =>
      mode === "writing"
        ? sectionStates(template, at)
        : new Map(
            template.sections.map((s): [string, SectionState] => {
              const key = s.kind === "builtin" ? s.key : `custom:${s.id}`;
              return [key, key === at ? "writing" : sectionStarted(content, key) || key === "timeline" ? "done" : "pending"];
            }),
          ),
    [mode, template, content, at],
  );
  const done = [...states.values()].every((s) => s === "done");
  const writing = mode === "writing" ? [...states].find(([, s]) => s === "writing")?.[0] : undefined;
  const writingRef = useFollow(writing);
  // Before anything is written, the model's thought stands where the text
  // will appear.
  const thought = mode === "writing" && Object.keys(content).length === 0 ? thinking : undefined;

  return (
    <article className="flex flex-col gap-3 rounded-lg border px-4 py-5 sm:px-8 sm:py-7" aria-busy={mode === "writing"}>
      <MarkdownDoc text={parts.header} />
      {parts.sections.map(({ key, markdown }) => {
        const state: SectionState = states.get(key) ?? "pending";
        if (mode === "stopped" && state === "pending") return null;
        return (
          <DraftSection
            key={key}
            markdown={markdown}
            state={state}
            stopped={mode === "stopped"}
            sectionRef={key === writing ? writingRef : undefined}
            thought={key === writing ? thought : undefined}
          />
        );
      })}
      {mode === "writing" && done && <MarkdownDoc text={parts.end} className="opacity-60" />}
    </article>
  );
}

// Keeps the section being written in view as the writing moves down, the
// way an editor follows the cursor: only while the reader is following it
// (the next section starts within a screen or so of the view), so someone
// who scrolled back up to read stays where they are.
function useFollow(writing: string | undefined): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!writing || !el) return;
    const { top } = el.getBoundingClientRect();
    const view = window.innerHeight;
    if (top < view * 0.6 || top > view * 1.6) return;
    el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [writing]);
  return ref;
}

function DraftSection({
  markdown,
  state,
  stopped,
  sectionRef,
  thought,
}: {
  markdown: string;
  state: SectionState;
  stopped: boolean;
  sectionRef?: RefObject<HTMLElement | null>;
  thought?: string;
}) {
  if (state === "pending") {
    return (
      <section className="flex flex-col gap-2.5 pt-1" aria-hidden>
        <h4 className="mt-4 border-b pb-1.5 font-heading font-semibold text-base text-muted-foreground/60">{headingOf(markdown)}</h4>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </section>
    );
  }
  if (state === "done") return <MarkdownDoc text={markdown} />;
  // The section being written reads like the rest of the document, with
  // the caret where the text ends, or the model's thought (as the Ask
  // section shows one) before it has written anything.
  if (thought) {
    return (
      <section ref={sectionRef} className="flex flex-col gap-3">
        <MarkdownDoc text={`## ${headingOf(markdown)}`} />
        <p className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 text-sm leading-relaxed">
          <BrainIcon aria-label="Thought" className="mt-[4px] size-3.5 text-brand" />
          <span className="line-clamp-3 text-muted-foreground">{thought}</span>
        </p>
      </section>
    );
  }
  return (
    <section ref={sectionRef}>
      <MarkdownDoc text={markdown} caret={!stopped} />
      {stopped && <p className="mt-3 text-destructive text-xs">Stopped here.</p>}
    </section>
  );
}

// m:ss, from 0:00.
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Seconds since `from`, ticking. Undefined until mounted, so the server's
// render and the first client render agree.
function useElapsed(from: string | undefined): number | undefined {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (!from) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [from]);
  return from && now !== undefined ? now - Date.parse(from) : undefined;
}

// The row above the document while it's written, in the place and shape of
// the finished document's toolbar, which takes its place when it's done:
// how long it's been at it, the model, how many of the template's
// sections are written, and why it's rewriting when its last submission
// was turned back. What it's thinking shows in the document itself.
export function DraftStatus({
  startedAt,
  attempt,
  problems,
  model,
  written,
  sections,
}: {
  startedAt: string | undefined;
  attempt: number;
  problems: string[] | undefined;
  model: string | undefined;
  written: number;
  sections: number;
}) {
  const elapsed = useElapsed(startedAt);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-muted-foreground text-xs">
        <p className="flex min-w-0 items-center gap-2" aria-live="polite">
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          <span className="min-w-0 truncate">
            Writing
            {elapsed !== undefined && <> · {clock(elapsed)}</>}
            {model && <> · {model}</>}
            {attempt > 1 && <> · draft {attempt}</>}
          </span>
        </p>
        <span className="tabular-nums">
          {written} of {sections} sections
        </span>
      </div>
      {problems && (
        <p className="line-clamp-2 text-muted-foreground text-xs">
          The last draft didn&apos;t pass the checks, so it&apos;s being rewritten: {problems.join("; ")}
        </p>
      )}
    </div>
  );
}

export const templateOf = (incident: Incident) => incident.postmortem?.template ?? defaultTemplate;
