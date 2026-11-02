"use client";

import { getToolName, isToolUIPart, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CircleXIcon,
  CopyIcon,
  CornerDownLeftIcon,
  CornerDownRightIcon,
  EllipsisIcon,
  GitCommitHorizontalIcon,
  ImageIcon,
  LoaderCircleIcon,
  type LucideIcon,
  PaperclipIcon,
  PencilIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  TimerIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LevelBars, MicButton } from "@/components/speech/mic-button";
import { SpeakButton } from "@/components/speech/speak-button";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDictation, useDictationSupported } from "@/hooks/use-dictation";
import { useSpeechPreferences } from "@/hooks/use-speech-preferences";
import { type ShrunkImage, shrinkImage, UnreadableImage } from "@/lib/images/shrink";
import { askRefusal, DEFAULT_IMAGE_QUESTION, MAX_QUESTION_CHARS, plainAnswer } from "@/lib/investigation/ask/rules";
import { type Incident, type InvestigationStep, type Question, toolNameSchema } from "@/lib/investigation/schema";
import { sourceKind } from "@/lib/investigation/source-kind";
import { contextLimit, contextShare } from "@/lib/models/context";
import { modelLabel, providerLabels } from "@/lib/models/labels";
import { effortLabels, type ReasoningEffort } from "@/lib/models/stages";
import { sseJsonStream } from "@/lib/sse";
import { cn } from "@/lib/utils";
import { AnswerText } from "./answer-text";
import { formatShare } from "./context-meter";
import { type ContextSegment, ContextWindow } from "./context-window";
import { formatCompact, formatDuration } from "./format";
import { StepRow } from "./investigation-timeline";
import { errorMessage } from "@/lib/errors";

// Follow-up questions on a finished incident: the thread oldest first, then
// a composer. Finished questions (and ones another tab is asking) come from
// the incident, which the page refreshes every second while one is being
// answered. The one this tab asked renders from its own stream until it
// ends, so the text arrives token by token rather than in one-second steps;
// then the saved copy takes over. Asked while an answer is still coming
// (here or in another tab), a question waits in a queue above the composer
// and goes out once the one before it is answered. The state lives in
// useAskQuestion, in the incident view, so switching sections mid-answer
// doesn't drop the stream or the queue.

// When a tool call began and ended, by this tab's clock: the stream carries
// no timestamps.
type Timing = Map<string, { start: number; end?: number }>;

// A screenshot attached to a question, already shrunk (lib/images/shrink),
// with an object URL for its thumbnail until the saved copy takes over.
export interface Attachment extends ShrunkImage {
  url: string;
}

export interface LiveQuestion {
  // The turn's key from the moment it's sent; the server's ID comes later.
  key: string;
  // Known once the server accepts the question.
  id?: string;
  text: string;
  image?: Attachment;
  startedAt: string;
  status: "posting" | "streaming" | "done" | "failed";
  message?: UIMessage;
  timing: Timing;
  error?: string;
}

export interface QueuedQuestion {
  key: string;
  text: string;
  image?: Attachment;
}

export interface Ask {
  live: LiveQuestion | undefined;
  // Why the composer is disabled (no report yet), or undefined when it can
  // take a question.
  refusal: string | undefined;
  // A question is being answered, here or in another tab: what's sent now
  // waits in the queue.
  busy: boolean;
  // Questions waiting their turn, in the order they'll be asked.
  queue: QueuedQuestion[];
  // The server turned the queue's next question down: it waits at the front
  // until resumed.
  paused: boolean;
  // The last request the server turned down, shown by the composer.
  error: string | undefined;
  draft: string;
  setDraft: (text: string) => void;
  // The screenshot attached to the draft, and whether one is being shrunk.
  image: Attachment | undefined;
  attaching: boolean;
  // Shrinks a pasted, dropped or picked image and attaches it, replacing
  // any other; one it can't read leaves the error.
  attach: (file: Blob) => void;
  detach: () => void;
  // Asks now, or queues behind the answer in progress. With an image and no
  // text it asks DEFAULT_IMAGE_QUESTION.
  send: (text: string, image?: Attachment) => void;
  unqueue: (key: string) => void;
  // Takes a queued question back into the composer to change it.
  editQueued: (key: string) => void;
  resume: () => void;
  // The key a saved question's turn renders under: the one it streamed
  // under, if this tab asked it, so the saved copy taking over (or the ID
  // arriving) doesn't remount the turn and replay its entrance.
  keyFor: (id: string) => string;
}

const errorText = (err: unknown) => errorMessage(err).split("\n")[0];

// Turn and queue keys, unique in this tab.
let lastKey = 0;
const newKey = () => `c${++lastKey}`;

// A question put back into the composer goes before whatever is typed there.
const withDraft = (text: string) => (draft: string) => (draft.trim() ? `${text}\n${draft}` : text);

// Lets go of an attachment no turn, queue entry or draft shows any more.
const release = (image: Attachment | undefined) => {
  if (image) URL.revokeObjectURL(image.url);
};

// The request for one question: JSON as before, or a form with the image
// and its size when one is attached.
function questionRequest(question: QueuedQuestion): RequestInit {
  if (!question.image) {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: question.text }),
    };
  }
  const form = new FormData();
  form.append("text", question.text);
  form.append("image", question.image.blob, `screenshot.${question.image.mediaType.split("/")[1]}`);
  form.append("width", String(question.image.width));
  form.append("height", String(question.image.height));
  return { method: "POST", body: form };
}

export function useAskQuestion(incident: Incident): Ask {
  const router = useRouter();
  const [live, setLive] = useState<LiveQuestion>();
  const [queue, setQueue] = useState<QueuedQuestion[]>([]);
  const [paused, setPaused] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [image, setImage] = useState<Attachment>();
  const [attaching, setAttaching] = useState(false);
  const busy = useRef(false);
  // The latest attach, so a slow shrink doesn't land after a newer one.
  const attachSeq = useRef(0);

  // The draft's image, swapped for another (or none), letting go of the one
  // it replaces.
  const putImage = useCallback((next: Attachment | undefined) => {
    setImage((prev) => {
      if (prev !== next) release(prev);
      return next;
    });
  }, []);

  const attach = useCallback(
    (file: Blob) => {
      const seq = ++attachSeq.current;
      setAttaching(true);
      setError(undefined);
      shrinkImage(file).then(
        (shrunk) => {
          if (seq !== attachSeq.current) return;
          putImage({ ...shrunk, url: URL.createObjectURL(shrunk.blob) });
          setAttaching(false);
        },
        (err) => {
          if (seq !== attachSeq.current) return;
          setError(err instanceof UnreadableImage ? err.message : `Couldn't attach that image: ${errorText(err)}`);
          setAttaching(false);
        },
      );
    },
    [putImage],
  );
  const detach = useCallback(() => {
    attachSeq.current++;
    setAttaching(false);
    putImage(undefined);
  }, [putImage]);

  // The saved copy takes over once it has caught up: after the stream ends
  // it is final (the server saves before closing the stream), and after a
  // broken stream it keeps growing through the page's refresh. Without an
  // ID (the response lost its header) there's no copy to wait for.
  const saved = live?.id ? incident.questions?.find((q) => q.id === live.id) : undefined;
  useEffect(() => {
    if (!live || (live.status !== "done" && live.status !== "failed")) return;
    if (!live.id || (saved && (live.status === "failed" || saved.status !== "answering"))) {
      // The saved copy shows its image from the server.
      release(live.image);
      setLive(undefined);
      busy.current = false;
    }
  }, [live, saved]);

  // Asks one question. Typed, it clears the composer; from the queue, it
  // leaves what's being typed alone.
  const ask = useCallback(
    async (question: QueuedQuestion, queued: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setError(undefined);
      if (!queued) {
        setDraft("");
        // Moves to the turn, which lets go of it later.
        setImage(undefined);
      }
      const timing: Timing = new Map();
      setLive({
        key: question.key,
        text: question.text,
        image: question.image,
        startedAt: new Date().toISOString(),
        status: "posting",
        timing,
      });

      let res: Response;
      try {
        res = await fetch(`/api/incidents/${incident.id}/questions`, questionRequest(question));
      } catch (err) {
        res = Response.json({ error: `Couldn't reach the server: ${errorText(err)}` }, { status: 0 });
      }
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setLive(undefined);
        // Turned down, a typed question goes back into the composer; a
        // queued one back to the front of the queue, which then waits for
        // the person rather than trying again on its own.
        if (queued) {
          setQueue((q) => [question, ...q]);
          setPaused(true);
        } else {
          setDraft(withDraft(question.text));
          if (question.image) putImage(question.image);
        }
        setError(data.error ?? `HTTP ${res.status}`);
        busy.current = false;
        return;
      }

      const id = res.headers.get("x-question-id") ?? undefined;
      if (id) setKeys((k) => ({ ...k, [id]: question.key }));
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
    [incident.id, router, putImage],
  );

  const refusal = composerRefusal(incident);
  const waiting = live !== undefined || (incident.questions ?? []).some((q) => q.status === "answering");

  // The queue's next question goes out once nothing is being answered.
  useEffect(() => {
    if (queue.length === 0) {
      if (paused) setPaused(false);
      return;
    }
    if (waiting || paused || refusal) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void ask(next, true);
  }, [queue, waiting, paused, refusal, ask]);

  // Behind an answer, or behind questions already waiting, a new one joins
  // the end of the queue so they go out in the order asked.
  const send = useCallback(
    (text: string, image?: Attachment) => {
      const trimmed = text.trim();
      if (!trimmed && !image) return;
      const question = { key: newKey(), text: trimmed || DEFAULT_IMAGE_QUESTION, image };
      if (waiting || paused || queue.length > 0 || busy.current) {
        setQueue((q) => [...q, question]);
        setDraft("");
        // Moves to the queue entry.
        if (image) setImage(undefined);
      } else {
        void ask(question, false);
      }
    },
    [waiting, paused, queue.length, ask],
  );

  const unqueue = useCallback(
    (key: string) => {
      release(queue.find((x) => x.key === key)?.image);
      setQueue((q) => q.filter((x) => x.key !== key));
    },
    [queue],
  );
  const editQueued = useCallback(
    (key: string) => {
      const question = queue.find((x) => x.key === key);
      if (!question) return;
      setQueue((q) => q.filter((x) => x.key !== key));
      setDraft(withDraft(question.text));
      if (question.image) putImage(question.image);
    },
    [queue, putImage],
  );
  const resume = useCallback(() => {
    setPaused(false);
    setError(undefined);
  }, []);
  const keyFor = useCallback((id: string) => keys[id] ?? id, [keys]);

  return {
    live,
    refusal,
    busy: waiting,
    queue,
    paused,
    error,
    draft,
    setDraft,
    image,
    attaching,
    attach,
    detach,
    send,
    unqueue,
    editQueued,
    resume,
    keyFor,
  };
}

// The server's rule, in the composer's words: closed until there's a
// report. Its other refusal, a question already being answered, the queue
// waits out instead.
function composerRefusal(incident: Incident): string | undefined {
  if (!askRefusal(incident) || (incident.questions ?? []).some((q) => q.status === "answering")) return undefined;
  return "Questions open once the investigation has a report";
}

// Whoever opens the Ask section to ask (the palette) focuses the
// composer, which may still be mounting.
const FOCUS_EVENT = "triage:focus-composer";
let focusPending = false;

export function requestComposerFocus() {
  focusPending = true;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

// A suggested question: the text sent, with what it asks about (a ruled-out
// cause's title) set apart where the list shows it.
interface Suggestion {
  text: string;
  icon: LucideIcon;
  label: ReactNode;
}

// From the report: why each ruled-out cause was ruled out, what changed,
// the slowest request, and whether the mitigation worked.
export function suggestedQuestions(incident: Incident): Suggestion[] {
  const plain = (text: string, icon: LucideIcon): Suggestion => ({ text, icon, label: text });
  const out: Suggestion[] = [];
  for (const h of incident.report?.hypotheses ?? []) {
    if (h.status !== "rejected") continue;
    out.push({
      text: `Why was "${h.title}" ruled out?`,
      icon: CircleSlashIcon,
      label: (
        <>
          Why was <span className="font-medium text-foreground">{h.title}</span> ruled out?
        </>
      ),
    });
  }
  out.push(
    plain("What changed in the hour before the alert?", GitCommitHorizontalIcon),
    plain("Show me the slowest request", TimerIcon),
  );
  if (incident.mitigation?.state === "applied") out.push(plain("Is the pool back to normal?", ActivityIcon));
  return out;
}

// One question as the thread shows it, from the saved record or the stream.
interface QuestionView {
  key: string;
  text: string;
  // The attached screenshot: this tab's copy while it streams, then the
  // server's.
  image?: { url: string; width: number; height: number };
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
  reasoningEffort?: ReasoningEffort;
  context?: Question["context"];
  answeredAt?: string;
}

function savedView(q: Question, key: string, incidentId: string): QuestionView {
  // The last model call's text is the answer itself, recorded as a thought
  // like every call's; the thread shows it once, as the answer.
  const answer = q.answer.trim();
  return {
    key,
    text: q.text,
    image: q.image && {
      url: `/api/incidents/${incidentId}/questions/${q.id}/image`,
      width: q.image.width,
      height: q.image.height,
    },
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
    reasoningEffort: q.reasoningEffort,
    context: q.context,
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
    key: live.key,
    text: live.text,
    image: live.image && { url: live.image.url, width: live.image.width, height: live.image.height },
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
  // the copy has no ID here (the POST is in flight, or the header was lost)
  // any answering one is it.
  const saved = (incident.questions ?? []).filter(
    (q) => !live || !(live.id ? q.id === live.id : q.status === "answering"),
  );
  const views = [...saved.map((q) => savedView(q, ask.keyFor(q.id), incident.id)), ...(live ? [liveView(live)] : [])];
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

  // The conversation opens at its latest message where it scrolls in its
  // own box; a question this tab asks scrolls to it; then the conversation
  // follows the answer down as it streams, as long as the reader stays at
  // the bottom.
  const boxRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  useFitToWindow(boxRef, views.length > 0);
  useScrollingFlag(threadRef, views.length > 0);
  useLayoutEffect(() => {
    if (scrollsItself(threadRef.current)) scrollToEnd(threadRef.current, endRef.current);
  }, []);
  const liveKey = live?.key;
  useEffect(() => {
    if (liveKey) scrollToEnd(threadRef.current, endRef.current, "smooth");
  }, [liveKey]);
  const last = views.at(-1);
  useFollowBottom(
    threadRef,
    endRef,
    // Once the answer is done, one more value: the reply's actions appear
    // under it then, and the end has moved down by their height.
    last?.status === "answering" ? last.answer.length + last.steps.length + last.thoughts.length : last && -1,
    views.length > 0,
  );

  // A failed question goes back into the composer, with its screenshot
  // fetched back from the server.
  const askAgain = (view: QuestionView) => {
    ask.setDraft(view.text);
    if (view.image) {
      void fetch(view.image.url)
        .then((res) => (res.ok ? res.blob() : undefined))
        .then((blob) => blob && ask.attach(blob))
        .catch(() => undefined);
    }
    requestAnimationFrame(focusComposer);
  };

  // Without a source to read again (a bundled example, or a run whose
  // scenario is gone) answers come from the recorded evidence alone
  // (evidence_only), as the route decides.
  const mode: Question["mode"] = sourceKind(incident) ? "tools" : "evidence_only";
  const composer = (
    <Composer
      ask={ask}
      mode={mode}
      incidentId={incident.id}
      textareaRef={textareaRef}
      contextWindow={conversationContext(incident.questions ?? [])}
    />
  );
  const suggestions = suggestedQuestions(incident);

  // Nothing asked yet: the composer first, then questions to start from.
  if (views.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div ref={endRef}>{composer}</div>
        <Suggestions suggestions={suggestions} disabled={ask.refusal !== undefined} onPick={ask.send} />
      </div>
    );
  }

  // Follow-ups to offer under the last answer: suggestions not asked yet.
  const asked = new Set(views.map((v) => v.text));
  const followUps = suggestions.filter((s) => !asked.has(s.text)).slice(0, 3);

  // Beside the section menu (a wide report), the conversation scrolls in its
  // own box, with the composer under it, and the page doesn't scroll: the
  // box reaches at most from where it starts down to the window's bottom
  // (useFitToWindow). Narrower, where the menu is a row on top and the
  // window is small, the conversation scrolls with the page and the
  // composer sticks to the bottom of the window.
  return (
    <div ref={boxRef} className="flex flex-col @2xl:max-h-[var(--chat-max,calc(100dvh_-_6.5rem))]">
      <div
        ref={threadRef}
        // Wider than the column by a gutter each side, padded back in: a
        // scroll box clips what overflows it, and the copy button (pulled
        // left to line up with the text) and focus rings sit just outside
        // the text; on the right the gutter holds the scrollbar. The bottom
        // padding (taken off the gap to the composer) holds what moves past
        // the last line while an answer comes in: a new turn sliding up 4px,
        // a spinner's corners as it turns. Without it a box that just fits
        // overflows by a pixel or two, and its scrollbar blinks on and off,
        // pushing the text sideways each time.
        className="@2xl:-mr-3 @2xl:-ml-2 @2xl:min-h-0 @2xl:flex-1 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:pr-3 @2xl:pb-2 @2xl:pl-2 @2xl:scrollbar-subtle"
      >
        <ol aria-label="Conversation with Triage" className="flex flex-col gap-9">
          {views.map((v) => (
            <ChatTurn key={v.key} view={v} latest={v === last} onAskAgain={askAgain} />
          ))}
        </ol>
      </div>
      {/* Follow-ups sit right above the composer, outside the scrolling
          conversation, so picking one is next to where you'd type. */}
      <div
        ref={endRef}
        className="sticky bottom-0 z-10 mt-6 flex flex-col gap-2 bg-background pb-4 @2xl:relative @2xl:mt-4 @2xl:pb-0"
      >
        {/* Under what follows (-z-10), so it doesn't cut the top of their
            focus rings; still over the conversation, as this row is z-10. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-6 -z-10 h-6 bg-linear-to-t from-background" />
        {last?.status === "answered" && followUps.length > 0 && (
          <FollowUps suggestions={followUps} disabled={ask.refusal !== undefined} onPick={ask.send} />
        )}
        {composer}
      </div>
    </div>
  );
}

// Whether the conversation scrolls in its own box (wide reports) rather
// than with the page.
function scrollsItself(thread: HTMLElement | null): thread is HTMLElement {
  return thread !== null && getComputedStyle(thread).overflowY !== "visible";
}

// How far the conversation is from its latest message, in pixels.
function distanceFromEnd(thread: HTMLElement | null): number {
  if (scrollsItself(thread)) return thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  return document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
}

// Scrolls the conversation to its latest message. In its own box the
// composer is in the window already, unless the window is too short for
// the box's minimum height; then the page brings it into view.
function scrollToEnd(thread: HTMLElement | null, composer: HTMLElement | null, behavior: ScrollBehavior = "auto") {
  if (scrollsItself(thread)) {
    thread.scrollTo({ top: thread.scrollHeight, behavior });
    composer?.scrollIntoView({ block: "nearest", behavior });
  } else {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }
}

// Caps the conversation's box at what's left of the window below where it
// starts on the page, less the page's bottom padding (pb-8), so the page
// itself has nothing to scroll; 20rem at least, for very short windows.
// Its top moves when the header above wraps or the window resizes, so it
// is measured again then. `mounted` says the box is on screen.
function useFitToWindow(boxRef: RefObject<HTMLElement | null>, mounted: boolean) {
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const top = Math.ceil(box.getBoundingClientRect().top + window.scrollY);
      box.style.setProperty("--chat-max", `max(20rem, calc(100dvh - ${top}px - 2rem))`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(document.body);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [boxRef, mounted]);
}

// Marks the box data-scrolling while it scrolls and for a moment after,
// so its scrollbar (scrollbar-subtle) shows then as well as on hover.
// `mounted` says the box is on screen.
function useScrollingFlag(ref: RefObject<HTMLElement | null>, mounted: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      el.dataset.scrolling = "";
      clearTimeout(timer);
      timer = setTimeout(() => delete el.dataset.scrolling, 800);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
    };
  }, [ref, mounted]);
}

// Keeps the conversation at its latest message while `signal` changes, if
// the reader was there: scrolling up to read stops it, scrolling back down
// picks it up again. Undefined stops following. `mounted` says the
// conversation is on screen (it isn't before the first question).
function useFollowBottom(
  threadRef: RefObject<HTMLElement | null>,
  composerRef: RefObject<HTMLElement | null>,
  signal: number | undefined,
  mounted: boolean,
) {
  const atEnd = useRef(true);
  useEffect(() => {
    const thread = threadRef.current;
    const onScroll = () => {
      atEnd.current = distanceFromEnd(threadRef.current) < 96;
    };
    onScroll();
    thread?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      thread?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, [threadRef, mounted]);
  useLayoutEffect(() => {
    if (signal !== undefined && atEnd.current) scrollToEnd(threadRef.current, composerRef.current);
  }, [signal, threadRef, composerRef]);
}

// Suggested follow-ups after the last answer, as chips above the composer.
function FollowUps({
  suggestions,
  disabled,
  onPick,
}: {
  suggestions: Suggestion[];
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <ul aria-label="Suggested follow-ups" className={cn("flex flex-wrap gap-1.5", enterMotion)}>
      {suggestions.map(({ text, icon: Icon, label }) => (
        <li key={text} className="min-w-0 max-w-full">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(text)}
            className="flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// The suggested questions as a list; picking one asks it.
function Suggestions({
  suggestions,
  disabled,
  onPick,
}: {
  suggestions: Suggestion[];
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <section aria-labelledby="ask-suggestions" className="flex flex-col gap-1">
      <h3 id="ask-suggestions" className="text-muted-foreground text-xs">
        Suggestions
      </h3>
      <ul className="-mx-2 flex flex-col">
        {suggestions.map(({ text, icon: Icon, label }) => (
          <li key={text} className="border-b last:border-b-0">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              className="group/suggestion my-0.5 flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              <Icon className="mt-[3px] size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{label}</span>
              <CornerDownLeftIcon
                aria-hidden
                className="mt-[3px] size-3.5 shrink-0 opacity-0 transition-opacity group-hover/suggestion:opacity-100 group-focus-visible/suggestion:opacity-100"
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const enterMotion = "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none";

// One exchange in the conversation: the question as the person's message,
// on the right; Triage's reply under it, on the left, without a bubble.
// The work behind the reply (tool calls, thoughts) folds into one line
// above it, open while it runs; a copy button and its details (model, time)
// sit under it, shown for the latest reply and on hover for earlier ones.
function ChatTurn({
  view,
  latest,
  onAskAgain,
}: {
  view: QuestionView;
  latest: boolean;
  onAskAgain: (view: QuestionView) => void;
}) {
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
  const folded =
    calls > 0
      ? `${calls} tool ${calls === 1 ? "call" : "calls"}`
      : thoughts > 0
        ? `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}`
        : undefined;
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

  // The line above the reply: what Triage is doing, then what it did.
  const status = answering ? (
    <>
      <LoaderCircleIcon className="size-3.5 animate-spin" />
      {rows.length > 0 ? "Working" : "Thinking"}
    </>
  ) : (
    [view.status === "failed" ? "Stopped" : took ? `Worked for ${took}` : "Answered", folded].filter(Boolean).join(" · ")
  );

  return (
    <li className={cn("group/turn relative flex flex-col gap-3", answering && enterMotion)}>
      <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
        {view.image && <QuestionImage image={view.image} />}
        <p className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-sm leading-relaxed">
          {view.text}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {rows.length > 0 && !answering ? (
          <Collapsible className="group/work">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground">
              {status}
              <ChevronRightIcon className="size-3.5 transition-[rotate] duration-200 group-data-[state=open]/work:rotate-90 motion-reduce:transition-none" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 border-l pl-3">{list}</div>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-muted-foreground text-xs" aria-live="polite">
              {status}
            </p>
            {rows.length > 0 && <div className="mt-1 border-l pl-3">{list}</div>}
          </div>
        )}

        {view.status === "failed" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="flex items-start gap-1.5 text-destructive text-sm leading-relaxed">
              <CircleXIcon className="mt-[3px] size-3.5 shrink-0" />
              {view.error ?? "The answer failed."}
            </p>
            <Button variant="outline" size="sm" onClick={() => onAskAgain(view)}>
              <RotateCcwIcon />
              Ask again
            </Button>
          </div>
        ) : (
          (view.answer || !answering) && <AnswerText text={view.answer} streaming={answering} />
        )}

        {view.status === "answered" && (
          <div
            className={cn(
              "-ml-2 flex items-center gap-0.5 text-muted-foreground transition-opacity",
              // Under an earlier reply it floats in the gap before the next
              // question, so it takes no room while hidden. It stays shown
              // while one of its tooltips is open (the trigger's data-state
              // is delayed-open or instant-open) or its details are (the
              // trigger's aria-expanded: the tooltip's data-state wins on a
              // trigger that has both), or while its answer is read aloud
              // (the speak button's aria-pressed), since the pointer can move
              // onto them and so off the turn.
              !latest &&
                "absolute inset-x-0 top-full pt-1 opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 has-[[data-state$=open]]:opacity-100 has-[[aria-expanded=true]]:opacity-100 has-[[aria-pressed=true]]:opacity-100",
            )}
          >
            <CopyAnswer answer={view.answer} />
            <SpeakButton id={view.key} text={view.answer} />
            <ReplyDetails view={view} />
          </div>
        )}
      </div>
    </li>
  );
}

// The screenshot sent with a question, above its bubble: at most 160 px
// tall, and full size in a dialog on click. Its width and height are set
// from the record so the thread doesn't jump as it loads.
function QuestionImage({ image }: { image: NonNullable<QuestionView["image"]> }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Open the screenshot"
          className="overflow-hidden rounded-xl rounded-br-md border bg-muted outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {/* A local API route or object URL: nothing for next/image to optimize. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt="Screenshot attached to the question"
            width={image.width}
            height={image.height}
            className="block h-auto max-h-40 w-auto max-w-full object-contain"
          />
        </button>
      </DialogTrigger>
      <DialogContent className="w-auto max-w-[calc(100vw-2rem)] p-2 sm:max-w-[min(90vw,1600px)]">
        <DialogTitle className="sr-only">Screenshot attached to the question</DialogTitle>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.url}
          alt="Screenshot attached to the question"
          width={image.width}
          height={image.height}
          className="h-auto max-h-[calc(100dvh-4rem)] w-auto max-w-full rounded-lg object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}

// Copies a reply as plain text, without its citations. The clipboard is
// missing outside a secure context (http on a LAN address) and a write can
// be denied; either says so instead of throwing.
function CopyAnswer({ answer }: { answer: string }) {
  const [result, setResult] = useState<"copied" | "failed">();
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), 1500);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainAnswer(answer));
      setResult("copied");
    } catch {
      setResult("failed");
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Copy answer" onClick={() => void copy()}>
          {result === "copied" ? <CheckIcon /> : result === "failed" ? <CircleXIcon /> : <CopyIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{result === "copied" ? "Copied" : result === "failed" ? "Couldn't copy" : "Copy answer"}</TooltipContent>
    </Tooltip>
  );
}

// How full the conversation's context is, for under the composer: what
// the latest question started from (its first model call), part by part.
// Each question sends the instructions, the report, all the evidence so
// far and the last few questions again, so the next one starts about
// there. Nothing before a question records it, or for a model whose
// window Triage isn't sure of.
function conversationContext(questions: Question[]): ReactNode {
  const q = questions.findLast((q) => q.start && contextLimit(q.provider, q.model));
  const limit = q && contextLimit(q.provider, q.model);
  if (!q?.start || !limit) return undefined;
  const { parts, history } = q.start;
  const segments: ContextSegment[] = [
    { key: "instructions", label: "Instructions", tokens: parts.instructions },
    { key: "tools", label: "Tools", tokens: parts.tools },
    { key: "report", label: "Incident report", tokens: parts.report },
    { key: "evidence", label: "Evidence", tokens: parts.evidence },
    {
      key: "history",
      label: "Earlier questions",
      tokens: parts.history,
      // Older ones drop out of the prompt: say so rather than hide it.
      detail: history.asked > history.included ? `last ${history.included} of ${history.asked}` : undefined,
    },
    { key: "question", label: "Question", tokens: parts.question },
    { key: "screenshot", label: "Screenshot", tokens: parts.screenshot ?? 0 },
  ];
  return (
    <ContextWindow
      used={q.start.inputTokens}
      limit={limit}
      segments={segments}
      note={`${modelLabel(q.model, q.provider)} · as the last question started · parts estimated from their length`}
      className="-mr-2 ml-auto"
    />
  );
}

// The reply's details behind a "⋯", so the row under it stays quiet: the
// model that wrote it, how full its fullest call's context got, where it
// read from, and when it was asked.
function ReplyDetails({ view }: { view: QuestionView }) {
  const rows: [string, ReactNode][] = [];
  if (view.model) rows.push(["Model", view.model]);
  if (view.provider) rows.push(["Provider", providerLabels[view.provider] ?? view.provider]);
  if (view.reasoningEffort) rows.push(["Effort", effortLabels[view.reasoningEffort]]);
  const peak = view.model ? contextShare({ ...view, model: view.model }) : undefined;
  if (peak !== undefined && view.context) {
    rows.push(["Peak context", `${formatShare(peak)} · ${formatCompact(view.context.inputTokens)} tokens`]);
  }
  if (view.mode === "evidence_only") rows.push(["Source", "Recorded evidence only"]);
  rows.push(["Asked", <Timestamp key="asked" date={view.askedAt} />]);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Reply details">
              <EllipsisIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Details</TooltipContent>
      </Tooltip>
      {/* Above, off the composer that sits under the latest reply. */}
      <PopoverContent side="top" align="start" className="w-auto min-w-56 max-w-80 p-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

// The questions waiting their turn, as a tab on the composer's top edge:
// how many and when they go out, then a line each, with buttons (on hover
// or focus, or always on touch screens) to take one back into the composer
// or drop it. Paused, after the server turned the next one down, it says so
// and offers to carry on.
function QueueTab({ ask, onEdit }: { ask: Ask; onEdit: (key: string) => void }) {
  return (
    <section
      aria-label="Queued questions"
      className={cn("mx-3 flex flex-col rounded-t-lg border border-b-0 bg-muted/50 p-1", enterMotion)}
    >
      <div className="flex h-6 items-center gap-2 px-2 text-muted-foreground text-xs">
        <span className="min-w-0 flex-1 truncate">
          {ask.queue.length} queued · {ask.paused ? "paused" : "sent when Triage finishes"}
        </span>
        {ask.paused && (
          <Button variant="ghost" size="xs" onClick={ask.resume}>
            Resume
          </Button>
        )}
      </div>
      <ol className="flex flex-col">
        {ask.queue.map((q) => (
          <li
            key={q.key}
            className="group/queued flex items-center gap-2 rounded-md py-0.5 pr-0.5 pl-2 text-xs transition-colors hover:bg-muted"
          >
            <CornerDownRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {q.image && <ImageIcon aria-label="With a screenshot" className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate" title={q.text}>
              {q.text}
            </span>
            <div className="flex text-muted-foreground opacity-0 transition-opacity group-focus-within/queued:opacity-100 group-hover/queued:opacity-100 [@media(hover:none)]:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="Edit queued question" onClick={() => onEdit(q.key)}>
                    <PencilIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="Remove from queue" onClick={() => ask.unqueue(q.key)}>
                    <XIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove</TooltipContent>
              </Tooltip>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// What the answer will read from, behind the composer's mode icon.
const modeHint: Record<Question["mode"], { icon: LucideIcon; text: string; detail: string }> = {
  tools: {
    icon: ScanSearchIcon,
    text: "Read-only tools, alert window",
    detail: "Answers with the investigation's read-only tools over the alert's window, citing evidence like the report.",
  },
  evidence_only: {
    icon: ArchiveIcon,
    text: "Recorded evidence only",
    detail: "No run to read again: answers from the evidence the investigation recorded, citing it like the report.",
  },
};

// The draft's screenshot, above the text: a thumbnail, its size as sent,
// and × to take it off; "Preparing image" while it's being shrunk.
function AttachmentChip({ image, onRemove }: { image: Attachment | undefined; onRemove: () => void }) {
  const kb = image && Math.max(1, Math.round(image.blob.size / 1000));
  return (
    <div className={cn("flex items-center gap-2 self-start rounded-md border bg-muted/50 p-1 text-xs", enterMotion)}>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- an object URL: nothing for next/image to optimize
        <img src={image.url} alt="Attached screenshot" className="h-10 max-w-20 rounded-sm object-cover" />
      ) : (
        <span className="flex size-10 items-center justify-center rounded-sm bg-muted">
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
        </span>
      )}
      <span className="text-muted-foreground tabular-nums">
        {image ? `${image.width} × ${image.height} · ${kb} KB` : "Preparing image…"}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove the screenshot" onClick={onRemove}>
            <XIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Remove</TooltipContent>
      </Tooltip>
    </div>
  );
}

// What was typed before dictating, then what is being said.
const withDictation = (typed: string, said: string) =>
  [typed.trimEnd(), said.trim()].filter(Boolean).join(typed.endsWith("\n") ? "\n" : " ");

// One row: a textarea that grows with what's typed (up to 10 rem, then
// scrolls), sends on Enter (Shift+Enter for a new line) and is capped at
// the server's limit; then the mode icon, which says on hover or focus
// what the answer reads from, the microphone when voice input is on in
// Settings, and the send button. Disabled, with the reason on hover, while
// there's no report yet. While a question is being answered it stays open:
// what's sent then waits in the queue, a tab on the composer's top edge,
// and ↑ in an empty composer takes the last one back to change it.
//
// Dictating writes the transcript into the textarea as it streams in, after
// whatever was typed, with a level meter and a "Listening" line so it's
// plain the microphone is on. The mic button stops it and leaves the text
// to edit and send; Enter stops it and sends; Escape drops what was said.
// With "Send when transcription finishes" on, stopping sends too.
//
// A screenshot comes in by pasting, dropping it on the composer, or the
// paperclip; it's shrunk in the browser and shown as a chip above the text,
// and Send then works with no text (the question becomes "What does this
// screenshot show…"). One per question: another replaces it.
function Composer({
  ask,
  mode,
  incidentId,
  textareaRef,
  contextWindow,
}: {
  ask: Ask;
  mode: Question["mode"];
  incidentId: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  contextWindow?: ReactNode;
}) {
  const disabled = ask.refusal !== undefined;
  const length = ask.draft.length;
  const hasContent = ask.draft.trim().length > 0 || ask.image !== undefined;
  const canSend = !disabled && !ask.attaching && hasContent && length <= MAX_QUESTION_CHARS;
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hint = modeHint[mode];
  const HintIcon = hint.icon;

  const { preferences } = useSpeechPreferences();
  const canRecord = useDictationSupported();
  // The draft when dictation started, which the transcript follows.
  const typed = useRef("");
  const { setDraft } = ask;
  const dictation = useDictation((said) => setDraft(withDictation(typed.current, said)), incidentId);
  const dictating = dictation.status !== "idle";
  const showMic = preferences.voiceInput && canRecord;

  // Voice input was turned off in another tab.
  const { cancel } = dictation;
  useEffect(() => {
    if (!showMic) cancel();
  }, [showMic, cancel]);

  // The newest words stay in view once the text outgrows the box.
  useEffect(() => {
    const el = textareaRef.current;
    if (dictating && el) el.scrollTop = el.scrollHeight;
  }, [dictating, ask.draft, textareaRef]);

  const startDictating = () => {
    typed.current = ask.draft;
    dictation.start();
  };
  const stopDictating = async (send: boolean) => {
    const said = await dictation.finish();
    if (said === undefined) return;
    const text = withDictation(typed.current, said);
    setDraft(text);
    if ((send || preferences.voiceAutoSend) && (text.trim() || ask.image) && !ask.attaching && text.length <= MAX_QUESTION_CHARS) {
      ask.send(text, ask.image);
    } else textareaRef.current?.focus();
  };
  const cancelDictating = () => {
    dictation.cancel();
    setDraft(typed.current);
  };

  const submit = () => {
    if (dictation.status === "listening") void stopDictating(true);
    else if (dictating) return;
    else if (canSend) ask.send(ask.draft, ask.image);
  };

  // An image pasted with the text keeps the text's paste as it is; only a
  // clipboard holding a file attaches it.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    ask.attach(file);
  };
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: DragEvent<HTMLFormElement>) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLFormElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };
  // Whatever file is dropped is tried: one that isn't an image says so.
  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    setDragging(false);
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const file = files.find((f) => f.type.startsWith("image/")) ?? files[0];
    if (file) ask.attach(file);
    textareaRef.current?.focus();
  };
  const editQueued = (key: string) => {
    ask.editQueued(key);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && dictating) {
      e.preventDefault();
      cancelDictating();
      return;
    }
    const lastQueued = ask.queue.at(-1);
    if (e.key === "ArrowUp" && !ask.draft && !dictating && lastQueued) {
      e.preventDefault();
      editQueued(lastQueued.key);
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  const statusLine = ask.error || (showMic && (dictation.status !== "idle" || dictation.error));
  const box = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-background p-1.5 pl-3 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        dragging && "border-ring border-dashed ring-3 ring-ring/50",
        disabled && "opacity-60",
      )}
    >
      {(ask.image || ask.attaching) && <AttachmentChip image={ask.image} onRemove={ask.detach} />}
      <div className="flex items-end gap-1">
        <label htmlFor="ask-triage" className="sr-only">
          Ask Triage about this incident
        </label>
        <textarea
          id="ask-triage"
          ref={textareaRef}
          value={ask.draft}
          onChange={(e) => ask.setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          readOnly={dictating}
          rows={1}
          maxLength={MAX_QUESTION_CHARS}
          placeholder={
            disabled
              ? ask.refusal
              : dictating
                ? "Listening…"
                : ask.busy
                  ? "Ask a follow-up, sent when Triage finishes…"
                  : ask.image
                    ? "Ask about this screenshot…"
                    : "Ask about this incident…"
          }
          aria-invalid={ask.error ? true : undefined}
          aria-describedby={ask.error ? "ask-triage-error" : "ask-triage-mode"}
          className="field-sizing-content max-h-40 min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {length > MAX_QUESTION_CHARS * 0.8 && (
          <span
            className={cn(
              "self-center px-1 text-muted-foreground text-xs tabular-nums",
              length >= MAX_QUESTION_CHARS && "text-destructive",
            )}
          >
            {length}/{MAX_QUESTION_CHARS}
          </span>
        )}
        <span id="ask-triage-mode" className="sr-only">
          {hint.detail}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) ask.attach(file);
            // The same file picked again still fires a change.
            e.target.value = "";
            textareaRef.current?.focus();
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label="Attach a screenshot"
              className="text-muted-foreground"
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Attach a screenshot · or paste or drop one</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={`Answers from: ${hint.text}`}
              className="text-muted-foreground"
            >
              <HintIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 flex-col items-start gap-0.5">
            <span className="font-medium">{hint.text}</span>
            <span className="opacity-70">{hint.detail}</span>
          </TooltipContent>
        </Tooltip>
        {showMic && (
          <>
            {dictation.status === "listening" && <LevelBars level={dictation.level} className="mx-1 self-center" />}
            <MicButton
              status={dictation.status}
              disabled={disabled}
              onClick={() => {
                if (dictation.status === "idle") startDictating();
                else if (dictation.status === "listening") void stopDictating(false);
                else if (dictation.status === "starting") cancelDictating();
                textareaRef.current?.focus();
              }}
            />
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              size="icon-sm"
              disabled={dictation.status === "listening" ? disabled : !canSend || dictating}
              aria-label={ask.busy ? "Queue" : "Send"}
            >
              <ArrowUpIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {ask.busy ? "Enter to queue" : "Enter to send"} · Shift+Enter for a new line
          </TooltipContent>
        </Tooltip>
      </div>
    </form>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col">
        {ask.queue.length > 0 && <QueueTab ask={ask} onEdit={editQueued} />}
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
      </div>
      {/* Under the box: what went wrong or the microphone's state on the
          left, how full the conversation's context is on the right. */}
      {(statusLine || contextWindow) && (
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
      {ask.error && (
        <p id="ask-triage-error" role="alert" className="flex items-center gap-1.5 text-destructive text-xs">
          <CircleXIcon className="size-3.5 shrink-0" />
          {ask.error}
        </p>
      )}
      {showMic && dictation.status !== "idle" && (
        <p aria-live="polite" className="flex items-center gap-1.5 text-muted-foreground text-xs">
          {dictation.status === "listening" ? (
            <>
              <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" />
              <span>
                <span className="text-foreground">Listening</span>, transcribing as you speak · Enter to send · Esc to
                cancel
              </span>
            </>
          ) : dictation.status === "starting" ? (
            "Starting the microphone…"
          ) : (
            "Finishing the transcript…"
          )}
        </p>
      )}
      {showMic && dictation.status === "idle" && dictation.error && (
        <p role="alert" className="flex items-center gap-1.5 text-destructive text-xs">
          <CircleXIcon className="size-3.5 shrink-0" />
          Voice input: {dictation.error}
        </p>
      )}
        </div>
        {contextWindow}
      </div>
      )}
    </div>
  );
}
