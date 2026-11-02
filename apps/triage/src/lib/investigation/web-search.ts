import type { Citation } from "ai";
import type { EvidenceDraft, EvidenceRecorder } from "./recorder";

// Meta's web search in the Fix and Ask stages (models/client.ts adds the
// tool). Meta runs the searches itself, inside one model call, and marks
// the words of the answer each page backs. Here: what a search did, in a
// line, and the cited pages as evidence, with their IDs put into the text
// where Meta marked them, so they render as chips like any other citation.
// Safe to import in the browser.

// The tool's name, as the stages and their records know it.
export const WEB_SEARCH = "web_search";

// The rules a stage with the tool gets, as lines of its instructions. The
// pages are cited from Meta's own marks, not by the model. Nothing here
// mentions citing them: told not to paste their URLs, Spark 1.3 stopped
// marking them at all (0 of 5 answers, against 6 of 6 without the line).
export const WEB_SEARCH_RULES = `
- web_search looks things up on the public web. Use it only for how a library, framework or service is documented to behave (an error message, an option, a default) when your work depends on it, never for this incident's own data.
- Search with the library's name and the error or option. Never put this team's hostnames, IDs, queries or data in a search.`;

// The parts of a model call's output read here.
export type Part = { type: string; text?: string; toolName?: string; citations?: Citation[]; output?: unknown };

type Action =
  | { type: "search"; query?: string; queries?: string[] }
  | { type: "openPage"; url?: string | null }
  | { type: "findInPage"; url?: string | null; pattern?: string | null };

export const shortUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

// One line for a search's row in the timeline, from what Meta says it did.
export function searchSummary(output: unknown): string {
  const action = (output as { action?: Action } | undefined)?.action;
  switch (action?.type) {
    case "search": {
      const query = action.queries?.join("; ") || action.query;
      return query ? `Searched "${query}"` : "Searched the web";
    }
    case "openPage":
      return action.url ? `Opened ${shortUrl(action.url)}` : "Opened a page";
    case "findInPage":
      return `Looked for "${action.pattern ?? ""}" in ${action.url ? shortUrl(action.url) : "a page"}`;
    default:
      return "Searched the web";
  }
}

// How many searches (and page reads) Meta ran over these calls, each billed.
export const countSearches = (steps: { content: readonly Part[] }[]) =>
  steps.reduce((n, s) => n + s.content.filter((p) => p.type === "tool-result" && p.toolName === WEB_SEARCH).length, 0);

// Where one model call's output splits around its last search: after it
// is the answer, before it the model saying what it'll look up.
const afterLastSearch = (content: readonly Part[]) => content.findLastIndex((p) => p.toolName === WEB_SEARCH) + 1;

// The answer in one model call's output, with its citations moved to count
// from the start of the answer's text.
export function answerOf(content: readonly Part[]): { text: string; citations: Citation[] } {
  let text = "";
  const citations: Citation[] = [];
  for (const p of content.slice(afterLastSearch(content))) {
    if (p.type !== "text" || !p.text) continue;
    for (const c of p.citations ?? []) {
      citations.push({ ...c, ...(c.endIndex !== undefined && { endIndex: c.endIndex + text.length }) });
    }
    text += p.text;
  }
  return { text, citations };
}

// The thinking aloud in a call that searched; all of a call that didn't.
export function beforeAnswer<P extends Part>(content: readonly P[]): readonly P[] {
  const at = afterLastSearch(content);
  return at ? content.slice(0, at) : content;
}

type Page = { url: string; title?: string };

export const citedPages = (citations: Citation[]): Page[] =>
  citations.flatMap(({ source }) => (source.sourceType === "url" ? [{ url: source.url, title: source.title }] : []));

// The pages a stage cited or opened over these calls, for one whose output
// isn't the text (the fix stage submits through a tool): Meta marks
// citations only in text written in the same call as the search, which
// the fix stage seldom writes.
export const usedPages = (steps: { content: readonly Part[] }[]): Page[] =>
  steps.flatMap((s) =>
    s.content.flatMap((p) => {
      if (p.type === "text") return citedPages(p.citations ?? []);
      const action = (p.output as { action?: Action } | undefined)?.action;
      return p.type === "tool-result" && p.toolName === WEB_SEARCH && action?.type === "openPage" && action.url
        ? [{ url: action.url }]
        : [];
    }),
  );

const webUrl = (url: string) => /^https?:\/\//.test(url) && URL.canParse(url);

// Each page, once, recorded as web evidence. Returns its ID by URL.
export function recordPages(recorder: EvidenceRecorder, list: Page[]): Map<string, string> {
  const pages = new Map<string, string | undefined>();
  for (const { url, title } of list) {
    if (webUrl(url) && (!pages.has(url) || (title && !pages.get(url)))) pages.set(url, title);
  }
  const drafts: EvidenceDraft[] = [...pages].map(([url, title]) => ({
    kind: "web",
    url,
    ...(title && { title }),
    summary: title || shortUrl(url),
  }));
  const evidence = drafts.length ? recorder.recordEvidence(WEB_SEARCH, drafts) : [];
  return new Map(evidence.flatMap((e) => (e.kind === "web" ? [[e.url, e.id]] : [])));
}

// The text with each cited page's evidence ID where Meta marked the end of
// the words it backs, before closing punctuation: "… no timeout [ev_web_1]."
export function withWebCitations(text: string, citations: Citation[], ids: Map<string, string>): string {
  const at = new Map<number, Set<string>>();
  for (const c of citations) {
    const id = c.source.sourceType === "url" ? ids.get(c.source.url) : undefined;
    if (!id || c.endIndex === undefined) continue;
    let i = Math.min(c.endIndex, text.length);
    while (i > 0 && /[\s.,;:!?]/.test(text[i - 1])) i--;
    at.set(i, (at.get(i) ?? new Set()).add(id));
  }
  // From the end, so the earlier positions still hold.
  for (const [i, set] of [...at].sort((a, b) => b[0] - a[0])) {
    text = `${text.slice(0, i)} [${[...set].join(", ")}]${text.slice(i)}`;
  }
  return text;
}
