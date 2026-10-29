// Unified diffs as data, for the diff viewer: files, their hunks, and each
// line with its number on either side. Reads what `git diff` and Triage's
// sandbox write (with or without "diff --git" headers); index, mode and
// "\ No newline at end of file" lines are skipped.

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  // The line's number in the old file (context and removed lines) and the
  // new one (context and added lines).
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  // What follows the @@ range: the enclosing function, as git finds it.
  section?: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath?: string;
  newPath?: string;
  // The path to show: the new one, or the old one for a deleted file.
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const stripPrefix = (p: string) => {
  const path = p.trim().split("\t")[0];
  return path === "/dev/null" ? undefined : path.replace(/^[ab]\//, "");
};

// "@@ -39,14 +39,17 @@ section"; a count left out is 1.
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  // Lines the current hunk still has to come, per its header. While either
  // is above 0, every line belongs to the hunk, even one that starts with
  // "--- " or is empty.
  let oldLeft = 0;
  let newLeft = 0;
  const inHunk = () => hunk !== undefined && (oldLeft > 0 || newLeft > 0);

  const startFile = () => {
    file = { path: "", status: "modified", hunks: [], additions: 0, deletions: 0 };
    files.push(file);
    hunk = undefined;
  };

  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (inHunk() && file && hunk) {
      if (line.startsWith("\\")) continue;
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context";
      const text = kind === "context" && !line.startsWith(" ") ? line : line.slice(1);
      if (kind === "add") {
        hunk.lines.push({ kind, text, newNo: newNo++ });
        file.additions++;
        newLeft--;
      } else if (kind === "del") {
        hunk.lines.push({ kind, text, oldNo: oldNo++ });
        file.deletions++;
        oldLeft--;
      } else {
        hunk.lines.push({ kind, text, oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      startFile();
    } else if (line.startsWith("--- ")) {
      // A second "--- " without a "diff --git" in between is the next file.
      if (!file || file.hunks.length > 0 || file.oldPath !== undefined || file.newPath !== undefined) startFile();
      file!.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ") && file) {
      file.newPath = stripPrefix(line.slice(4));
    } else {
      const header = hunkHeader.exec(line);
      if (header && file) {
        oldNo = Number(header[1]);
        newNo = Number(header[3]);
        oldLeft = header[2] === undefined ? 1 : Number(header[2]);
        newLeft = header[4] === undefined ? 1 : Number(header[4]);
        hunk = { oldStart: oldNo, newStart: newNo, section: header[5]?.trim() || undefined, lines: [] };
        file.hunks.push(hunk);
      }
    }
  }

  for (const f of files) {
    f.path = f.newPath ?? f.oldPath ?? "";
    f.status =
      f.oldPath === undefined
        ? "added"
        : f.newPath === undefined
          ? "deleted"
          : f.oldPath !== f.newPath
            ? "renamed"
            : "modified";
  }
  return files.filter((f) => f.path);
}

// The changed middle of a removed line and the added line that replaced it:
// what's left once the text they share at either end is taken off. Only for
// lines that are mostly alike; for unrelated lines it would mark nonsense.
export function changedRange(before: string, after: string): { del: [number, number]; add: [number, number] } | undefined {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const shared = start + end;
  if (shared === 0 || shared / Math.max(before.length, after.length) < 0.5) return undefined;
  if (shared === before.length && shared === after.length) return undefined;
  return { del: [start, before.length - end], add: [start, after.length - end] };
}

// A hunk's lines side by side, as split views show them: context on both
// sides; in each run of removed lines and the added lines after it, the
// lines that match (the same once indentation is set aside, or mostly the
// same) face each other, so code wrapped in a new block still lines up with
// what it was. Between matches, what's left pairs in order, the longer
// side's extra lines against a blank.
export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

const alike = (a: DiffLine, b: DiffLine) =>
  (a.text.trim() !== "" && a.text.trim() === b.text.trim()) || changedRange(a.text, b.text) !== undefined;

// The longest run of matching pairs, in order: [dels index, adds index].
function matchRuns(dels: DiffLine[], adds: DiffLine[]): [number, number][] {
  const n = dels.length;
  const m = adds.length;
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      best[i][j] = alike(dels[i], adds[j]) ? best[i + 1][j + 1] + 1 : Math.max(best[i + 1][j], best[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (alike(dels[i], adds[j]) && best[i][j] === best[i + 1][j + 1] + 1) pairs.push([i++, j++]);
    else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  const inOrder = (dels: DiffLine[], adds: DiffLine[]) => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    let d = 0;
    let a = 0;
    for (const [di, ai] of matchRuns(dels, adds)) {
      inOrder(dels.slice(d, di), adds.slice(a, ai));
      rows.push({ left: dels[di], right: adds[ai] });
      d = di + 1;
      a = ai + 1;
    }
    inOrder(dels.slice(d), adds.slice(a));
  }
  return rows;
}
