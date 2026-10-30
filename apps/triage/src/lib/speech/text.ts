// An answer as a voice should read it: the markdown marks and the evidence
// citations an answer carries mean nothing aloud ("asterisk asterisk",
// "bracket e v underscore log"). Pure, so it is tested without a browser and
// shared by every engine.

// The citation brackets of an answer ([ev_log_3], or several IDs in one
// bracket), with the space before them: the same pattern as plainAnswer in
// ask/rules.ts.
const citation = /[ \t]*\[[^\]\n]*\bev_[a-z0-9]+(?:_[a-z0-9]+)*[^\]\n]*\]/g;

const fence = /^\s*(?:```|~~~)/;
const heading = /^\s{0,3}#{1,6}\s+/;
// An item whose only content was a citation is left as a bare mark, so the
// space after it is optional at the end of the line.
const bullet = /^\s*(?:[-*•]|\d+[.)])(?:\s+|$)/;

// A sentence already ends here, whether or not a quote or bracket closes it.
const endsSentence = /[.!?:;]["'”’)\]]*$/;

// [text](url) and ![alt](url) read as their text.
function unlink(line: string): string {
  return line.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
}

// `code`, **bold**, __bold__ and *italic* read as their text.
function unmark(line: string): string {
  return line
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([^\n]*?\S)__/g, "$1")
    .replace(/(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1");
}

type Segment = { text: string; closed: boolean };

export function speakableText(text: string): string {
  const segments: Segment[] = [];
  let paragraph: string[] = [];

  // A paragraph is its lines joined; it is closed (given an end mark) when
  // something follows it, and left as written at the very end.
  const flush = (closed: boolean) => {
    const joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (joined) segments.push({ text: joined, closed });
  };
  const item = (line: string) => {
    flush(true);
    const clean = line.replace(/\s+/g, " ").trim();
    if (clean) segments.push({ text: clean, closed: true });
  };

  for (const raw of text.replace(citation, "").split(/\r?\n/)) {
    if (fence.test(raw)) {
      flush(true);
      continue;
    }
    const line = unmark(unlink(raw));
    if (!line.trim()) flush(true);
    else if (heading.test(line)) item(line.replace(heading, ""));
    else if (bullet.test(line)) item(line.replace(bullet, ""));
    else paragraph.push(line);
  }
  flush(false);

  return segments
    .map(({ text: spoken, closed }) => (closed && !endsSentence.test(spoken) ? `${spoken}.` : spoken))
    .join(" ")
    .trim();
}
