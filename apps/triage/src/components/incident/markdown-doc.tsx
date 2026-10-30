"use client";

import { type ReactNode, useMemo } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { type Block, splitBlocks } from "./answer-text";
import { Citations, useEvidence } from "./evidence";

// A Markdown document (the postmortem export) as the page's prose. What an
// answer has (paragraphs, lists, `code`, **bold**), plus the rest of what
// the export writes: headings, pipe tables, links, ~~strikethrough~~, and
// evidence footnotes [3] shown as the report's numbered chips. The numbers
// are the page's own, so a footnote maps back to its evidence; a number with
// no evidence stays plain text.

type DocBlock =
  | Block
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

const heading = /^(#{1,3})\s+(.*)$/;
const rule = /^\s*(?:-{3,}|\*{3,})\s*$/;
const tableRow = /^\s*\|.*\|\s*$/;
const tableSeparator = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

// "| a | b \| c |" is ["a", "b | c"].
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replaceAll("\\|", "|"));
}

// Headings, tables and rules stand on their own lines; whatever runs between
// them is paragraphs and lists, split as an answer is.
function docBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = text.split("\n");
  let rest: string[] = [];
  const flush = () => {
    if (rest.length) blocks.push(...splitBlocks(rest.join("\n")));
    rest = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const h = heading.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, text: h[2].trim() });
    } else if (tableRow.test(line) && tableSeparator.test(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && tableRow.test(lines[i + 1])) rows.push(cells(lines[++i]));
      blocks.push({ kind: "table", header, rows });
    } else if (rule.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
    } else {
      rest.push(line);
    }
  }
  flush();
  return blocks;
}

// The headings sit under the section's own (an h2 for screen readers).
const headingTags = { 1: "h3", 2: "h4", 3: "h5" } as const;
const headingStyles = {
  1: "text-xl font-semibold tracking-tight",
  2: "mt-4 border-b pb-1.5 text-base font-semibold first:mt-0",
  3: "mt-2 text-sm font-semibold",
} as const;

export function MarkdownDoc({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => docBlocks(text), [text]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 text-sm leading-relaxed", className)}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "heading": {
            const Tag = headingTags[block.level];
            return (
              <Tag key={i} className={cn("font-heading text-foreground", headingStyles[block.level])}>
                <Inline text={block.text} />
              </Tag>
            );
          }
          case "table": {
            // A column of long text wraps, from a width that keeps it
            // readable; short ones stay on a line. Past that, the table
            // scrolls sideways.
            const wraps = block.header.map((_, j) => block.rows.some((row) => (row[j]?.length ?? 0) > 32));
            return (
              <Table key={i} className="text-xs">
                <TableHeader>
                  <TableRow>
                    {block.header.map((cell, j) => (
                      <TableHead key={j} className="h-8 text-muted-foreground">
                        <Inline text={cell} />
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {block.rows.map((row, r) => (
                    <TableRow key={r}>
                      {block.header.map((_, j) => (
                        <TableCell key={j} className={cn("align-top", wraps[j] && "min-w-48 whitespace-normal")}>
                          <Inline text={row[j] ?? ""} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            );
          }
          case "rule":
            return <hr key={i} className="my-2" />;
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List
                key={i}
                className={cn("flex flex-col gap-1 pl-5 marker:text-muted-foreground", block.ordered ? "list-decimal" : "list-disc")}
              >
                {block.items.map((item, j) => (
                  <li key={j} className="min-w-0 break-words pl-0.5">
                    <Inline text={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "paragraph":
            return (
              <p key={i} className="min-w-0 break-words">
                <Inline text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}

// `code`, **bold**, _italic_, ~~struck~~, [a link](url) and footnotes [3],
// in the order they appear; code first, so nothing inside it is read as a
// mark. Italic marks only stand outside a word, so snake_case and evidence
// IDs stay as they are.
const inlineToken =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])([_*])([^_*\n]+)\3(?![\w*])|~~([^~\n]+)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|\[(\d+)\]/g;
const evidenceIdOnly = /^ev_[a-z0-9]+(?:_[a-z0-9]+)*$/;
// Markdown's escapes, as the export writes them for literal characters.
const unescape = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1");

function Inline({ text }: { text: string }) {
  const { numberOf } = useEvidence();
  // Footnote number to evidence ID, the page's numbering turned around.
  const idOf = useMemo(() => new Map([...numberOf].map(([id, n]) => [n, id])), [numberOf]);

  const out: ReactNode[] = [];
  // Footnotes side by side ([3][7]) become one row of chips.
  let footnotes: string[] = [];
  let last = 0;
  const closeFootnotes = (key: number) => {
    if (footnotes.length) out.push(<Citations key={`f${key}`} ids={footnotes} className="align-baseline" />);
    footnotes = [];
  };
  for (const m of text.matchAll(inlineToken)) {
    const at = m.index;
    const before = text.slice(last, at);
    if (before) {
      closeFootnotes(at);
      out.push(unescape(before));
    }
    last = at + m[0].length;
    const [, code, bold, , italic, struck, linkText, href, footnote] = m;
    if (footnote !== undefined) {
      const id = idOf.get(Number(footnote));
      if (id) {
        footnotes.push(id);
        continue;
      }
      closeFootnotes(at);
      out.push(m[0]);
      continue;
    }
    closeFootnotes(at);
    if (code !== undefined) {
      out.push(
        <code key={at} className="rounded bg-muted px-1 py-px font-mono text-[0.85em] [overflow-wrap:anywhere]">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      out.push(
        <strong key={at} className="font-medium">
          <Inline text={bold} />
        </strong>,
      );
    } else if (italic !== undefined) {
      out.push(
        <em key={at}>
          <Inline text={italic} />
        </em>,
      );
    } else if (struck !== undefined) {
      // An evidence ID no tool returned, struck as a claim nobody can check.
      out.push(
        evidenceIdOnly.test(struck) ? (
          <del
            key={at}
            title={`${struck}: no tool returned this evidence. The claim is not verified.`}
            className="font-mono text-[11px] text-muted-foreground"
          >
            {struck}
          </del>
        ) : (
          <del key={at}>
            <Inline text={struck} />
          </del>
        ),
      );
    } else if (href !== undefined) {
      // Only web links: the text is a model's, and a javascript: URL in it
      // must not run.
      if (!/^(?:https?:|mailto:)/i.test(href)) {
        out.push(<Inline key={at} text={linkText} />);
        continue;
      }
      out.push(
        <a
          key={at}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
        >
          <Inline text={linkText} />
        </a>,
      );
    }
  }
  closeFootnotes(text.length);
  const rest = text.slice(last);
  if (rest) out.push(unescape(rest));
  return out;
}
