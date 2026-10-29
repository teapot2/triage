"use client";

import { getToolName, isToolUIPart, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import {
  ArrowUpIcon,
  BrainIcon,
  ChevronRightIcon,
  CircleXIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Timestamp } from "@/components/timestamp";
import { TriageMark } from "@/components/triage-mark";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { askRefusal, MAX_QUESTION_CHARS } from "@/lib/investigation/ask/rules";
import { type Incident, type InvestigationStep, type Question, toolNameSchema } from "@/lib/investigation/schema";
import { sourceKind } from "@/lib/investigation/source-kind";
import { modelLabel } from "@/lib/models/labels";
import { sseJsonStream } from "@/lib/sse";
import { cn } from "@/lib/utils";
import { AnswerText } from "./answer-text";
import { formatDuration, formatTime } from "./format";
import { StepRow } from "./investigation-timeline";

// Follow-up questions on a finished incident: the thread oldest first, then
// a composer. Finished questions (and ones another tab is asking) come from
// the incident, which the page refreshes every second while one is being
// answered. The one this tab asked renders from its own stream until it
// ends, so the text arrives token by token rather than in one-second steps;
// then the saved copy takes over. The state lives in useAskQuestion, in
// the incident view, so switching sections mid-answer doesn't drop the
// stream.

// When a tool call began and ended, by this tab's clock: the stream carries
// no timestamps.
type Timing = Map<string, { start: number; end?: number }>;

export interface LiveQuestion {
  // Known once the server accepts the question.
  id?: string;
  text: string;
  startedAt: string;
  status: "posting" | "streaming" | "done" | "failed";
  message?: UIMessage;
  timing: Timing;
  error?: string;
}

export interface Ask {
  live: LiveQuestion | undefined;
  // Why the composer is disabled, or undefined when it can take a question.
  refusal: string | undefined;
  // The last request the server turned down, shown by the composer.
  error: string | undefined;
  draft: string;
  setDraft: (text: string) => void;
  send: (text: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

export function useAskQuestion(incident: Incident): Ask {
  const router = useRouter();
  const [live, setLive] = useState<LiveQuestion>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const busy = useRef(false);

  // The saved copy takes over once it has caught up: after the stream ends
  // it is final (the server saves before closing the stream), and after a
  // broken stream it keeps growing through the page's refresh.
  const saved = live?.id ? incident.questions?.find((q) => q.id === live.id) : undefined;
  useEffect(() => {
    if (!live || !saved) return;
    if (live.status === "failed" || (live.status === "done" && saved.status !== "answering")) {
      setLive(undefined);
      busy.current = false;
    }
  }, [live, saved]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy.current) return;
      busy.current = true;
      setError(undefined);
      setDraft("");
      const timing: Timing = new Map();
      setLive({ text: trimmed, startedAt: new Date().toISOString(), status: "posting", timing });

      let res: Response;
      try {
        res = await fetch(`/api/incidents/${incident.id}/questions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        });
      } catch (err) {
        res = Response.json({ error: `Couldn't reach the server: ${errorText(err)}` }, { status: 0 });
      }
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setLive(undefined);
        setDraft(trimmed);
        setError(data.error ?? `HTTP ${res.status}`);
        busy.current = false;
        return;
      }

      const id = res.headers.get("x-question-id") ?? undefined;
      setLive((l) => l && { ...l, id, status: "streaming" });
      try {
        const stream = sseJsonStream<UIMessageChunk>(res.body);
        for await (const message of readUIMessageStream({ stream, terminateOnError: true })) {
          const now = Date.now();
          for (const part of message.parts) {
            if (!isToolUIPart(part)) continue;
            const t = timing.get(part.toolCallId);
            if (!t) timing.set(part.toolCallId, { start: now });
            else if (t.end === undefined && (part.state === "output-available" || part.state === "output-error")) t.end = now;
          }
          setLive((l) => l && { ...l, message });
        }
        setLive((l) => l && { ...l, status: "done" });
      } catch (err) {
        setLive((l) => l && { ...l, status: "failed", error: errorText(err) });
      }
      router.refresh();
    },
    [incident.id, router],
  );

  return { live, refusal: live ? "Wait for the current question to finish" : composerRefusal(incident), error, draft, setDraft, send };
}

// The server's rule, in the composer's words.
function composerRefusal(incident: Incident): string | undefined {
  const refusal = askRefusal(incident);
  if (!refusal) return undefined;
  if (!incident.report) return "Questions open once the investigation has a report";
  return "Wait for the current question to finish";
}

// Whoever opens the Questions section to ask (the verdict card's button,
// the palette) focuses the composer, which may still be mounting.
const FOCUS_EVENT = "triage:focus-composer";
let focusPending = false;

export function requestComposerFocus() {
  focusPending = true;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

// From the report: why each ruled-out cause was ruled out, what changed,
// the slowest request, and whether the mitigation worked.
export function suggestedQuestions(incident: Incident): string[] {
  const out: string[] = [];
  for (const h of incident.report?.hypotheses ?? []) {
    if (h.status === "rejected") out.push(`Why was ${h.title} ruled out?`);
  }
  out.push("What changed in the hour before the alert?", "Show me the slowest request");
  if (incident.mitigation?.state === "applied") out.push("Is the pool back to normal?");
  return out;
}

// One question as the thread shows it, from the saved record or the stream.
interface QuestionView {
  key: string;
  text: string;
  askedAt: string;
  status: Question["status"];
  answer: string;
  error?: string;
  steps: InvestigationStep[];
  // What the model wrote between tool calls, each with when.
  thoughts: { key: string; at: string; text: string }[];
  mode?: Question["mode"];
  model?: string;
  provider?: string;
  answeredAt?: string;
}

function savedView(q: Question): QuestionView {
  // The last model call's text is the answer itself, recorded as a thought
  // like every call's; the thread shows it once, as the answer.
  const answer = q.answer.trim();
  return {
    key: q.id,
    text: q.text,
    askedAt: q.askedAt,
    status: q.status,
    answer: q.answer,
    error: q.error,
    steps: q.steps,
    thoughts: (q.thoughts ?? []).flatMap((t) => {
      if (t.text && answer && answer.startsWith(t.text.trim())) return [];
      const text = t.text ?? t.reasoning?.split("\n").find((l) => l.trim())?.trim();
      return text ? [{ key: t.id, at: t.startedAt, text }] : [];
    }),
    mode: q.mode,
    model: q.model,
    provider: q.provider,
    answeredAt: q.answeredAt,
  };
}

// The stream's parts: tool parts are steps; the text after the last tool
// call is the answer, and text (or reasoning) before it is the model
// thinking aloud, as the server records it.
function liveView(live: LiveQuestion): QuestionView {
  const parts = live.message?.parts ?? [];
  const lastTool = parts.findLastIndex((p) => isToolUIPart(p));
  const steps: InvestigationStep[] = [];
  const thoughts: QuestionView["thoughts"] = [];
  let answer = "";
  parts.forEach((part, i) => {
    if (isToolUIPart(part)) {
      const tool = toolNameSchema.safeParse(getToolName(part));
      if (!tool.success) return;
      const t = live.timing.get(part.toolCallId);
      const start = t?.start ?? Date.now();
      const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
      const output = part.state === "output-available" ? (part.output as { summary?: string; evidence?: { id: string }[] } | undefined) : undefined;
      steps.push({
        id: part.toolCallId,
        tool: tool.data,
        input,
        status: part.state === "output-available" ? "completed" : part.state === "output-error" ? "error" : "running",
        startedAt: new Date(start).toISOString(),
        durationMs: t?.end !== undefined ? t.end - start : undefined,
        summary: output?.summary,
        evidenceIds: output?.evidence?.map((e) => e.id) ?? [],
        error: part.state === "output-error" ? part.errorText : undefined,
      });
      return;
    }
    if (part.type === "text" || part.type === "reasoning") {
      if (i > lastTool && part.type === "text") answer += part.text;
      else {
        const text = part.text.trim();
        // Parts come in the order things happened: a thought sits just
        // after the last tool call before it, or at the start.
        const last = steps.at(-1);
        const at = last ? new Date(Date.parse(last.startedAt) + 1).toISOString() : live.startedAt;
        if (text) thoughts.push({ key: `p${i}`, at, text: text.split("\n").find((l) => l.trim())?.trim() ?? text });
      }
    }
  });
  const status: Question["status"] = live.status === "failed" ? "failed" : live.status === "done" ? "answered" : "answering";
  return {
    key: live.id ?? "live",
    text: live.text,
    askedAt: live.startedAt,
    status,
    answer,
    error: live.error,
    steps,
    thoughts,
  };
}

export function QuestionsPanel({ incident, ask }: { incident: Incident; ask: Ask }) {
  const { live } = ask;
  // This tab's question is shown from its stream, not its saved copy; while
  // the POST is in flight the copy has no ID here yet, so any answering one
  // is it.
  const saved = (incident.questions ?? []).filter(
    (q) => !live || (q.id !== live.id && !(live.status === "posting" && q.status === "answering")),
  );
  const views = [...saved.map(savedView), ...(live ? [liveView(live)] : [])];
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const focusComposer = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    if (focusPending) {
      focusPending = false;
      focusComposer();
    }
    const onFocus = () => {
      focusPending = false;
      focusComposer();
    };
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVENT, onFocus);
  }, [focusComposer]);

  // A question this tab asks scrolls the composer and the new card into view.
  const liveKey = live ? "live" : undefined;
  useEffect(() => {
    if (liveKey) endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [liveKey]);

  const askAgain = (text: string) => {
    ask.setDraft(text);
    requestAnimationFrame(focusComposer);
  };

  return (
    <div className="flex flex-col gap-5">
      {views.length === 0 ? (
        <div className="flex flex-col gap-3">
          {/* Without a source to read again (a bundled example, or a run
              whose scenario is gone) answers come from the recorded
              evidence alone (evidence_only), as the route decides. */}
          <p className="text-muted-foreground text-sm leading-relaxed">
            {sourceKind(incident)
              ? "Ask Triage about this incident. It answers with the investigation's read-only tools over the alert's window and cites its evidence, like the report."
              : "Ask Triage about this incident. It answers from the evidence the investigation recorded and cites it, like the report."}
          </p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
            {suggestedQuestions(incident).map((q) => (
              <li key={q}>
                <button
                  type="button"
                  disabled={ask.refusal !== undefined}
                  onClick={() => ask.send(q)}
                  className="rounded-full border px-3 py-1 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ol className="flex flex-col gap-4">
          {views.map((v) => (
            <QuestionCard key={v.key} view={v} onAskAgain={askAgain} />
          ))}
        </ol>
      )}
      <div ref={endRef}>
        <Composer ask={ask} textareaRef={textareaRef} />
      </div>
    </div>
  );
}

const enterMotion = "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none";

function QuestionCard({ view, onAskAgain }: { view: QuestionView; onAskAgain: (text: string) => void }) {
  const answering = view.status === "answering";
  const t0 = Date.parse(view.askedAt);
  const took =
    view.answeredAt !== undefined ? formatDuration(Date.parse(view.answeredAt) - t0) : undefined;
  const rows = useMemo(
    () =>
      [
        ...view.thoughts.map((t) => ({ kind: "thought" as const, key: t.key, at: Date.parse(t.at), text: t.text })),
        ...view.steps.map((s) => ({ kind: "step" as const, key: s.id, at: Date.parse(s.startedAt), step: s })),
      ].sort((a, b) => a.at - b.at),
    [view.thoughts, view.steps],
  );
  // What the folded rows hold: "3 tool calls", or "2 thoughts" when the
  // model answered from the evidence it had.
  const calls = view.steps.length;
  const thoughts = view.thoughts.length;
  const folded = [
    calls > 0 && `${calls} tool ${calls === 1 ? "call" : "calls"}`,
    calls === 0 && thoughts > 0 && `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const meta = [
    took,
    view.model && modelLabel(view.model, view.provider),
    view.mode === "evidence_only" && "from the recorded evidence",
  ].filter(Boolean);

  const list = (
    <ol className="-mx-2 flex flex-col">
      {rows.map((row) =>
        row.kind === "step" ? (
          <StepRow
            key={row.key}
            step={row.step}
            offsetMs={row.at - t0}
            query=""
            highlighted={false}
            running={answering}
          />
        ) : (
          <li
            key={row.key}
            className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 px-2 py-1.5 text-sm", answering && enterMotion)}
          >
            <BrainIcon aria-label="Thought" className="mt-[3px] size-3.5 text-brand" />
            <span className="truncate text-muted-foreground">{row.text}</span>
          </li>
        ),
      )}
    </ol>
  );

  return (
    <li className={cn("flex flex-col rounded-lg border", answering && enterMotion)}>
      <div className="flex flex-col gap-1.5 p-4">
        <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5">
            <MessageSquareTextIcon className="size-3.5" />
            Question
          </span>
          <Timestamp date={view.askedAt}>{formatTime(view.askedAt)} UTC</Timestamp>
        </div>
        <p className="whitespace-pre-wrap font-medium text-sm leading-relaxed">{view.text}</p>
      </div>

      {rows.length > 0 &&
        (answering ? (
          <div className="border-t px-4 py-2">{list}</div>
        ) : (
          <Collapsible className="group/calls border-t">
            <CollapsibleTrigger className="flex w-full items-center gap-1 px-4 py-2 text-muted-foreground text-xs transition-colors hover:text-foreground">
              <ChevronRightIcon className="size-3.5 transition-[rotate] duration-200 group-data-[state=open]/calls:rotate-90 motion-reduce:transition-none" />
              {folded}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-2">{list}</div>
            </CollapsibleContent>
          </Collapsible>
        ))}

      <div className="flex flex-col gap-2 border-t p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5">
            {answering ? (
              <>
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Answering
              </>
            ) : view.status === "failed" ? (
              <>
                <CircleXIcon className="size-3.5 text-destructive" />
                No answer
              </>
            ) : (
              <>
                <TriageMark className="size-3.5" />
                Triage
              </>
            )}
          </span>
          {meta.length > 0 && <span className="truncate">{meta.join(" · ")}</span>}
        </div>
        {view.status === "failed" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-destructive text-sm leading-relaxed">{view.error ?? "The answer failed."}</p>
            <Button variant="outline" size="sm" onClick={() => onAskAgain(view.text)}>
              <RotateCcwIcon />
              Ask again
            </Button>
          </div>
        ) : (
          <AnswerText text={view.answer} streaming={answering} />
        )}
      </div>
    </li>
  );
}

// A textarea that sends on Enter (Shift+Enter for a new line), capped at
// the server's limit; disabled, with the reason on hover, while a question
// is being answered or there's no report yet.
function Composer({ ask, textareaRef }: { ask: Ask; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const disabled = ask.refusal !== undefined;
  const length = ask.draft.length;
  const canSend = !disabled && ask.draft.trim().length > 0 && length <= MAX_QUESTION_CHARS;

  const submit = () => {
    if (canSend) ask.send(ask.draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  const box = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn(
        "flex flex-col rounded-lg border bg-background transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        disabled && "opacity-60",
      )}
    >
      <label htmlFor="ask-triage" className="sr-only">
        Ask Triage about this incident
      </label>
      <textarea
        id="ask-triage"
        ref={textareaRef}
        value={ask.draft}
        onChange={(e) => ask.setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={2}
        maxLength={MAX_QUESTION_CHARS}
        placeholder={disabled ? ask.refusal : "Ask about this incident…"}
        aria-invalid={ask.error ? true : undefined}
        aria-describedby={ask.error ? "ask-triage-error" : undefined}
        className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <span className="pl-1 text-muted-foreground text-xs">
          <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
          {length > MAX_QUESTION_CHARS * 0.8 && (
            <span className={cn("tabular-nums sm:ml-2", length >= MAX_QUESTION_CHARS && "text-destructive")}>
              {length}/{MAX_QUESTION_CHARS}
            </span>
          )}
        </span>
        <Button type="submit" size="icon-sm" disabled={!canSend} aria-label="Send">
          <ArrowUpIcon />
        </Button>
      </div>
    </form>
  );

  return (
    <div className="flex flex-col gap-2">
      {disabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div>{box}</div>
          </TooltipTrigger>
          <TooltipContent>{ask.refusal}</TooltipContent>
        </Tooltip>
      ) : (
        box
      )}
      {ask.error && (
        <p id="ask-triage-error" role="alert" className="flex items-center gap-1.5 text-destructive text-xs">
          <CircleXIcon className="size-3.5 shrink-0" />
          {ask.error}
        </p>
      )}
    </div>
  );
}
