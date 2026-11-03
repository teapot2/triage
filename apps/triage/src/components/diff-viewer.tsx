"use client";

import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { highlightCode, WrapLinesButton } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { changedRange, type DiffLine, type FileDiff, parsePatch, splitRows } from "@/lib/diff";
import { cn } from "@/lib/utils";

// A unified diff the way GitHub, Claude and Codex show one: a card per file
// with its path and +/− counts, each change under its @@ header with line
// numbers on both sides, highlighted as code, and the part of a line that
// changed marked within it. Unified (one column) or split (old beside new).
// Long lines scroll sideways, or wrap in place with Wrap lines on.

type View = "unified" | "split";

const languages: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  sql: "sql",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  py: "python",
  html: "html",
};
const languageOf = (path: string) => languages[path.split(".").pop()?.toLowerCase() ?? ""];

export function DiffViewer({ patch, className }: { patch: string; className?: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const [view, setView] = useState<View>("unified");
  const [wrap, setWrap] = useState(false);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground text-xs">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="font-mono tabular-nums">
          <span className="text-success">+{additions}</span> <span className="text-destructive">−{deletions}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            aria-label="Diff layout"
            value={view}
            onValueChange={setView}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />
          <WrapLinesButton wrap={wrap} onWrapChange={setWrap} size="icon-sm" />
          <CopyPatch patch={patch} />
        </div>
      </div>
      {files.map((file) => (
        <FileCard key={file.path} file={file} view={view} wrap={wrap} />
      ))}
    </div>
  );
}

function CopyPatch({ patch }: { patch: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy patch"
          onClick={() => void navigator.clipboard.writeText(patch).then(() => setCopied(true))}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy patch"}</TooltipContent>
    </Tooltip>
  );
}

const statusBadge: Record<FileDiff["status"], string | undefined> = {
  added: "New file",
  deleted: "Deleted",
  renamed: "Renamed",
  modified: undefined,
};

function FileCard({ file, view, wrap }: { file: FileDiff; view: View; wrap: boolean }) {
  const [open, setOpen] = useState(true);
  const slash = file.path.lastIndexOf("/");
  const tokens = useFileTokens(file);
  // The changed part of each line that replaced a similar one, by line.
  const marks = useMemo(() => {
    const m = new Map<DiffLine, [number, number]>();
    for (const hunk of file.hunks) {
      for (const { left, right } of splitRows(hunk.lines)) {
        if (left?.kind !== "del" || right?.kind !== "add") continue;
        const range = changedRange(left.text, right.text);
        if (!range) continue;
        m.set(left, range.del);
        m.set(right, range.add);
      }
    }
    return m;
  }, [file]);
  const longest = useMemo(() => Math.max(0, ...file.hunks.flatMap((h) => h.lines.map((l) => l.text.length))), [file]);

  return (
    <section className="overflow-hidden rounded-lg border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left text-xs hover:bg-muted/60",
          open && "border-b",
        )}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-[rotate] duration-200", open && "rotate-90")}
        />
        <span className="min-w-0 truncate font-mono">
          {slash > 0 && <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>}
          {file.path.slice(slash + 1)}
        </span>
        {statusBadge[file.status] && (
          <span className="text-muted-foreground text-xs">· {statusBadge[file.status]}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono tabular-nums">
          <span className="text-success">+{file.additions}</span>
          <span className="text-destructive">−{file.deletions}</span>
          <ChangeBar additions={file.additions} deletions={file.deletions} />
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto font-mono text-(length:--code-font-size) leading-[1.6]">
          {/* Split halves are always even. Unwrapped, they widen to fit the
              longest line (each half has 5rem of gutter) and scroll together. */}
          <table
            className={cn("w-full border-collapse", view === "split" && "table-fixed")}
            style={view === "split" && !wrap ? { minWidth: `calc(2 * (${longest}ch + 5rem))` } : undefined}
          >
            {view === "split" && (
              <colgroup>
                <col className="w-12" />
                <col className="w-5" />
                <col />
                <col className="w-12" />
                <col className="w-5" />
                <col />
              </colgroup>
            )}
            {file.hunks.map((hunk, h) => (
              <tbody key={h}>
                <tr className="bg-info/5 text-muted-foreground">
                  <td colSpan={view === "split" ? 6 : 4} className="px-3 py-1 text-[0.85em]">
                    @@ −{hunk.oldStart} +{hunk.newStart} @@
                    {hunk.section && <span className="ml-2 opacity-80">{hunk.section}</span>}
                  </td>
                </tr>
                {view === "unified"
                  ? hunk.lines.map((line, i) => (
                      <tr key={i} className={rowBg[line.kind]}>
                        <LineNo n={line.oldNo} kind={line.kind} />
                        <LineNo n={line.newNo} kind={line.kind} />
                        <Sign kind={line.kind} />
                        <td className={cn("pr-4", wrap ? codeWrap : "whitespace-pre")}>
                          <Code line={line} tokens={tokens.of(line)} mark={marks.get(line)} />
                        </td>
                      </tr>
                    ))
                  : splitRows(hunk.lines).map(({ left, right }, i) => (
                      <tr key={i}>
                        <Half line={left} side="old" wrap={wrap} tokens={left && tokens.of(left)} mark={left && marks.get(left)} />
                        <Half line={right} side="new" wrap={wrap} tokens={right && tokens.of(right)} mark={right && marks.get(right)} />
                      </tr>
                    ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
}

const codeWrap = "whitespace-pre-wrap [overflow-wrap:anywhere]";

const rowBg: Record<DiffLine["kind"], string> = {
  context: "",
  add: "bg-success/10",
  del: "bg-destructive/10",
};
const gutterBg: Record<DiffLine["kind"], string> = {
  context: "text-muted-foreground/60",
  add: "bg-success/15 text-success/80",
  del: "bg-destructive/15 text-destructive/80",
};
const markBg: Record<DiffLine["kind"], string> = {
  context: "",
  add: "rounded-[2px] bg-success/30",
  del: "rounded-[2px] bg-destructive/30",
};

function LineNo({ n, kind }: { n?: number; kind: DiffLine["kind"] }) {
  return (
    <td className={cn("w-12 select-none px-2 text-right align-top tabular-nums", gutterBg[kind])}>{n ?? ""}</td>
  );
}

function Sign({ kind }: { kind: DiffLine["kind"] }) {
  return (
    <td
      className={cn(
        "w-5 select-none text-center align-top",
        kind === "add" ? "text-success" : kind === "del" ? "text-destructive" : "",
      )}
    >
      {kind === "add" ? "+" : kind === "del" ? "−" : ""}
    </td>
  );
}

// One side of a split row: its line, or a blank where the other side's line
// has no counterpart.
function Half({
  line,
  side,
  wrap,
  tokens,
  mark,
}: {
  line?: DiffLine;
  side: "old" | "new";
  wrap: boolean;
  tokens?: ThemedToken[];
  mark?: [number, number];
}) {
  if (!line) return <td colSpan={3} className="bg-muted/40" />;
  return (
    <>
      <LineNo n={side === "old" ? line.oldNo : line.newNo} kind={line.kind} />
      <td className={cn("align-top", rowBg[line.kind])}>
        <span className={cn("block text-center", line.kind === "add" ? "text-success" : "text-destructive")}>
          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
        </span>
      </td>
      <td className={cn("pr-3 align-top", wrap ? codeWrap : "whitespace-pre", rowBg[line.kind])}>
        <Code line={line} tokens={tokens} mark={mark} />
      </td>
    </>
  );
}

// A line's text, as highlighted tokens once they're ready, with its changed
// range marked: tokens are split where the range starts and ends.
function Code({ line, tokens, mark }: { line: DiffLine; tokens?: ThemedToken[]; mark?: [number, number] }) {
  const parts = tokens ?? [{ content: line.text, offset: 0 } as ThemedToken];
  const out: React.ReactNode[] = [];
  let at = 0;
  parts.forEach((token, t) => {
    const text = token.content;
    const cuts = [0, text.length];
    if (mark) for (const edge of mark) if (edge > at && edge < at + text.length) cuts.push(edge - at);
    cuts.sort((a, b) => a - b);
    for (let c = 0; c < cuts.length - 1; c++) {
      const piece = text.slice(cuts[c], cuts[c + 1]);
      if (!piece) continue;
      const start = at + cuts[c];
      const marked = mark !== undefined && start >= mark[0] && start < mark[1];
      out.push(
        <span
          key={`${t}-${c}`}
          className={cn("dark:!text-[var(--shiki-dark)]", marked && markBg[line.kind])}
          style={{ color: token.color, ...token.htmlStyle } as CSSProperties}
        >
          {piece}
        </span>,
      );
    }
    at += text.length;
  });
  // An empty line still takes its height.
  return out.length ? out : "​";
}

// Five squares split between green and grey and red, in proportion, as
// GitHub draws a file's share of additions and deletions.
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total ? Math.round((additions / total) * 5) : 0;
  const red = total ? Math.min(5 - green, Math.round((deletions / total) * 5)) : 0;
  return (
    <span aria-hidden className="flex gap-px">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-2 rounded-[1px]",
            i < green ? "bg-success" : i < green + red ? "bg-destructive" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

// Nothing to subscribe to: tells the hydrating render apart from later ones,
// as the code block does, so the server and hydration both render plain text.
const subscribeNever = () => () => {};

// A file's lines highlighted as code: the old side (context and removed
// lines) and the new side (context and added lines) are each highlighted as
// one text, so the grammar sees lines in order, then mapped back to lines.
function useFileTokens(file: FileDiff) {
  const lang = languageOf(file.path);
  const { oldText, newText, index } = useMemo(() => {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const idx = new Map<DiffLine, { old?: number; new?: number }>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const at: { old?: number; new?: number } = {};
        if (line.kind !== "add") at.old = oldLines.push(line.text) - 1;
        if (line.kind !== "del") at.new = newLines.push(line.text) - 1;
        idx.set(line, at);
      }
    }
    return { oldText: oldLines.join("\n"), newText: newLines.join("\n"), index: idx };
  }, [file]);
  const oldTokens = useHighlighted(oldText, lang);
  const newTokens = useHighlighted(newText, lang);
  return {
    of(line: DiffLine): ThemedToken[] | undefined {
      const at = index.get(line);
      if (!at) return undefined;
      return line.kind === "del" ? oldTokens?.[at.old!] : newTokens?.[at.new!];
    },
  };
}

function useHighlighted(code: string, lang?: BundledLanguage): ThemedToken[][] | undefined {
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const cached = useMemo(
    () => (hydrated && lang && code ? highlightCode(code, lang)?.tokens : undefined),
    [hydrated, code, lang],
  );
  const [loaded, setLoaded] = useState<{ code: string; tokens: ThemedToken[][] }>();
  useEffect(() => {
    if (!lang || !code) return;
    let cancelled = false;
    highlightCode(code, lang, (result) => {
      if (!cancelled) setLoaded({ code, tokens: result.tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return (loaded?.code === code ? loaded.tokens : undefined) ?? cached;
}
