import type { DataChange, Fix } from "../schema";

// Whether a fix changes stored data, worked out from what it edits rather
// than taken from the model's word. The sandbox runs tests against the
// app's Postgres read-only and never runs migrations, so the data half of a
// fix can't be proven there: a person has to read it before approving.
// Pure, and safe to import from client components.

// What one file gains from a fix: an edit's `replace` text, or a patch's
// added lines. `created` when the file is new.
export type FileChange = { file: string; text: string; created?: boolean };

// Drizzle's list of migrations to run. Triage adds a new migration's entry
// itself (migration.ts); the model never edits it.
export const JOURNAL = "drizzle/meta/_journal.json";

// SQL files run against the database when they ship (Drizzle's migrations
// live under drizzle/); the sandbox doesn't run them.
export const isSqlFile = (file: string) => file.startsWith("drizzle/") || file.endsWith(".sql");

// The one kind of file an edit may create: a new migration, written as an
// edit with an empty `find` and the whole file as `replace`.
export const isNewMigrationPath = (file: string) => /^drizzle\/[\w.-]+\.sql$/.test(file);

// A statement that writes rows or changes the schema, at the start of a
// statement: a line, or after `;`, `(` or the quote or backtick that opens a
// SQL string. Upper case only, as SQL in the app's code is written, so code
// like `deleteItem(` or a "Delete from cart" label doesn't count. Drizzle's
// query builder (`db.insert(...)`, `db.update(...)`) doesn't count either:
// that's the app's own behaviour, which the regression test exercises, not
// a one-off change to the rows already stored.
const STATEMENT = new RegExp(
  [
    String.raw`(?:^|[;(\x60'"])\s*`,
    "(",
    [
      String.raw`INSERT\s+INTO`,
      String.raw`UPDATE\s+[\w."]+(?:\s+(?:AS\s+)?\w+)?\s+SET`,
      String.raw`DELETE\s+FROM`,
      String.raw`(?:ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|SCHEMA|FUNCTION|TRIGGER|EXTENSION)`,
      String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|SCHEMA|FUNCTION|TRIGGER|EXTENSION)`,
      "TRUNCATE",
    ].join("|"),
    String.raw`)\b`,
  ].join(""),
  "gm",
);

// The statement keywords a text adds, in the order they first appear.
export function sqlStatements(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(STATEMENT)) found.add(m[1].split(/\s/)[0]);
  return [...found];
}

export function detectDataChange(changes: FileChange[], touchesData: boolean): DataChange {
  const byFile = new Map<string, { statements: Set<string>; created: boolean }>();
  for (const c of changes) {
    const entry = byFile.get(c.file) ?? { statements: new Set<string>(), created: false };
    for (const s of sqlStatements(c.text)) entry.statements.add(s);
    entry.created ||= c.created === true;
    byFile.set(c.file, entry);
  }
  const reasons: string[] = [];
  const files: string[] = [];
  for (const [file, { statements, created }] of byFile) {
    const what = statements.size ? ` (${[...statements].join(", ")})` : "";
    if (file === JOURNAL) {
      reasons.push(`Registers the migration in ${JOURNAL} (written by Triage)`);
    } else if (isSqlFile(file)) {
      reasons.push(`${created ? "Adds" : "Changes"} ${file.startsWith("drizzle/") ? "migration" : "SQL file"} ${file}${what}`);
    } else if (statements.size) {
      reasons.push(`Adds SQL that changes data in ${file}${what}`);
    } else continue;
    files.push(file);
  }
  if (touchesData) reasons.push("The model that wrote the fix says it changes stored data");
  return { detected: files.length > 0 || touchesData, reasons, files, unproven: files.filter(isSqlFile) };
}

// The files a unified diff touches, with the lines it adds to each. A file
// that was /dev/null before is new.
export function patchChanges(patch: string): FileChange[] {
  const changes: FileChange[] = [];
  const lines = patch.split("\n");
  let current: { file: string; added: string[]; created: boolean } | undefined;
  const flush = () => current && changes.push({ file: current.file, text: current.added.join("\n"), created: current.created });
  lines.forEach((line, i) => {
    const prev = lines[i - 1] ?? "";
    if (line.startsWith("+++ ") && prev.startsWith("--- ")) {
      flush();
      current = {
        file: line.slice(4).trim().replace(/^b\//, ""),
        added: [],
        created: prev.slice(4).trim() === "/dev/null",
      };
    } else if (current && line.startsWith("+")) current.added.push(line.slice(1));
  });
  flush();
  return changes;
}

// The part of a unified diff that touches the given files.
export function patchFor(patch: string, files: string[]): string {
  const wanted = new Set(files);
  const lines = patch.split("\n");
  const kept: string[] = [];
  let keep = false;
  lines.forEach((line, i) => {
    const next = lines[i + 1] ?? "";
    if (line.startsWith("--- ") && next.startsWith("+++ ")) {
      const before = line.slice(4).trim().replace(/^a\//, "");
      const after = next.slice(4).trim().replace(/^b\//, "");
      keep = wanted.has(after) || wanted.has(before);
    }
    if (keep) kept.push(line);
  });
  return kept.join("\n");
}

// The fix's data change: as worked out when it was proven, or, for a fix
// saved before Triage worked it out, from its patch (the regression test
// left out: a test may clean up the rows it creates).
export function dataChangeOf(fix: Fix): DataChange {
  if (fix.dataChange) return fix.dataChange;
  const changes = patchChanges(fix.patch).filter((c) => c.file !== fix.regressionTest.file);
  return detectDataChange(changes, fix.touchesData);
}
