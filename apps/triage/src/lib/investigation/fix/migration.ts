import { isNewMigrationPath, JOURNAL, sqlStatements } from "./data-change";
import type { Edit } from "./prove";

// A fix that repairs stored data adds a migration under drizzle/. Drizzle
// runs only the migrations its journal lists, so Triage registers the new
// one there itself; the model never writes the journal. The number is
// Triage's call too: the model can't read the journal, so a new file is
// renamed to NNNN_<name>.sql with NNNN the next index, keeping its name.
// No meta/NNNN_snapshot.json is written: a data-only migration doesn't
// change the schema, so the next db:generate still diffs from the last one.

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

// Statements that change the schema, which only drizzle-kit generate may
// write (it keeps the snapshot in step).
const SCHEMA_STATEMENTS = new Set(["ALTER", "CREATE", "DROP"]);

export type MigrationPlan = {
  // The edits with the new migration renamed, if it needed it.
  edits: Edit[];
  // The journal with the new migration's entry, when the fix adds one.
  journal?: string;
  problems: string[];
};

// Pure: `existing` is the files the edits touch that exist already, and
// `journalText` the journal as it stands (undefined if there is none).
export function planMigration(
  edits: Edit[],
  existing: Set<string>,
  journalText: string | undefined,
  now: number,
): MigrationPlan {
  const created = [...new Set(edits.filter((e) => e.find === "" && isNewMigrationPath(e.file) && !existing.has(e.file)).map((e) => e.file))];
  if (created.length === 0) return { edits, problems: [] };
  if (created.length > 1) {
    return { edits, problems: [`the fix adds ${created.length} migrations (${created.join(", ")}); put the whole data repair in one`] };
  }
  const [file] = created;
  const problems: string[] = [];

  const sql = edits.filter((e) => e.file === file).map((e) => e.replace).join("\n");
  const schema = sqlStatements(sql).filter((s) => SCHEMA_STATEMENTS.has(s));
  if (schema.length) {
    problems.push(
      `${file} changes the schema (${schema.join(", ")}); a migration in a fix may only repair data (INSERT, UPDATE, DELETE). Schema changes go through drizzle-kit generate.`,
    );
  }

  let journal: Journal | undefined;
  try {
    journal = journalText === undefined ? undefined : (JSON.parse(journalText) as Journal);
  } catch {
    journal = undefined;
  }
  if (!journal || !Array.isArray(journal.entries)) {
    problems.push(`${JOURNAL} is missing or unreadable, so a new migration can't be registered`);
    return { edits, problems };
  }

  // The name after any number the model gave it: "backfill_prices" from
  // drizzle/0004_backfill_prices.sql or drizzle/backfill_prices.sql.
  const name = file.slice("drizzle/".length, -".sql".length).replace(/^\d+_?/, "");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    problems.push(`name the migration drizzle/<number>_<words>.sql, e.g. drizzle/0001_backfill_prices.sql; got ${file}`);
  }
  if (problems.length) return { edits, problems };

  const last = journal.entries.at(-1);
  const idx = last ? last.idx + 1 : 0;
  const tag = `${String(idx).padStart(4, "0")}_${name}`;
  const target = `drizzle/${tag}.sql`;
  const entry: JournalEntry = {
    idx,
    version: last?.version ?? journal.version,
    // Drizzle's migrator runs only migrations whose `when` is later than
    // the last one applied, so it never goes backwards (a clock behind the
    // last migration's author's, say).
    when: Math.max(now, (last?.when ?? 0) + 1),
    tag,
    breakpoints: last?.breakpoints ?? true,
  };
  // Formatted as drizzle-kit writes it, with the file's own line endings.
  let text = JSON.stringify({ ...journal, entries: [...journal.entries, entry] }, null, 2);
  if (journalText!.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
  if (/\r?\n$/.test(journalText!)) text += journalText!.includes("\r\n") ? "\r\n" : "\n";
  return {
    edits: edits.map((e) => (e.file === file ? { ...e, file: target } : e)),
    journal: text,
    problems: [],
  };
}
