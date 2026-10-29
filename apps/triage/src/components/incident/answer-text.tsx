"use client";

import { type ReactNode, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Citations, useEvidence } from "./evidence";

// An answer to a follow-up question, as the model writes it: plain
// paragraphs and short bullets, with evidence cited inline as [ev_log_3]
// (or several in one bracket). The citations become the report's numbered
// chips; an ID no tool returned is struck, as a claim nobody can check.
// While the answer streams, an unknown ID may still be on its way (the tool
// result is saved a beat after the chunk), so it shows plain until the
// stream ends. The text grows token by token behind a thin caret.

const bracketed = /\[([^\]\n]*)\]/g;
const evidenceId = /\bev_[a-z0-9]+(?:_[a-z0-9]+)*/g;
const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
const numbered = /^\s*\d+[.)]\s+/;
const inlineMark = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

type Block = { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; items: string[] };

// Paragraphs are separated by a blank line; a run of bullet lines is a list
// wherever it sits. Lines inside a paragraph join with a space, as in
// Markdown.
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const closeParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      closeParagraph();
      continue;
    }
    if (bullet.test(line)) {
      closeParagraph();
      const ordered = numbered.test(line);
      const last = blocks.at(-1);
      const item = line.replace(bullet, "");
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    paragraph.push(line.trim());
  }
  closeParagraph();
  return blocks;
}

export function AnswerText({
  text,
  streaming = false,
  className,
}: {
  text: string;
  // The stream is still open: a caret at the end, unknown IDs not yet struck.
  streaming?: boolean;
  className?: string;
}) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  const caret = streaming ? <Caret /> : null;
  return (
    <div className={cn("flex flex-col gap-2 text-sm leading-relaxed", className)}>
      {blocks.map((block, i) => {
        const last = i === blocks.length - 1;
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={i}
              className={cn("flex flex-col gap-1 pl-5 marker:text-muted-foreground", block.ordered ? "list-decimal" : "list-disc")}
            >
              {block.items.map((item, j) => (
                <li key={j} className="pl-0.5">
                  <Inline text={item} streaming={streaming} />
                  {last && j === block.items.length - 1 && caret}
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            <Inline text={block.text} streaming={streaming} />
            {last && caret}
          </p>
        );
      })}
      {blocks.length === 0 && caret && <p>{caret}</p>}
    </div>
  );
}

// A paragraph's text: citations, then the light inline marks the model
// uses (`code` and **bold**).
function Inline({ text, streaming }: { text: string; streaming: boolean }) {
  const { byId } = useEvidence();
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(bracketed)) {
    const ids = [...new Set([...match[1].matchAll(evidenceId)].map((m) => m[0]))];
    if (ids.length === 0) continue;
    const before = text.slice(last, match.index);
    if (before) out.push(<Marks key={`t${last}`} text={before} />);
    const known = ids.filter((id) => byId.has(id));
    const unknown = ids.filter((id) => !byId.has(id));
    out.push(
      <span key={`c${match.index}`} className="inline-flex flex-wrap items-baseline gap-0.5 align-baseline">
        {known.length > 0 && <Citations ids={known} />}
        {unknown.map((id) => (
          <span
            key={id}
            title={streaming ? `${id}: not received yet` : `${id}: no tool returned this evidence. The claim is not verified.`}
            className={cn("font-mono text-[11px] text-muted-foreground", !streaming && "line-through")}
          >
            {id}
          </span>
        ))}
      </span>,
    );
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest) out.push(<Marks key={`t${last}`} text={rest} />);
  return out;
}

function Marks({ text }: { text: string }) {
  const parts = text.split(inlineMark);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith("`")) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return (
      <strong key={i} className="font-medium">
        {part.slice(2, -2)}
      </strong>
    );
  });
}

// A thin bar that blinks at the end of the text while it streams.
function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-px translate-y-[0.15em] bg-foreground align-baseline animate-blink motion-reduce:animate-none"
    />
  );
}
