import { readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb, transaction } from "../db";
import { type ArchivedFilter, filterArchived } from "./archive";
import { exampleIncidents } from "./fixtures";
import { type IncidentSummary, SUMMARY_VERSION, toSummary } from "./list-summary";
import { type Incident, incidentSchema } from "./schema";

// Incidents in .data/triage.db (db.ts): one row each, the incident as JSON
// plus columns copied from it on every write, so lists and lookups use
// indexes. Every function here is the only way in; a hosted deploy that
// needs another database swaps what's behind them.

const checkId = (id: string) => {
  if (!/^inc_[a-z0-9_]+$/.test(id)) throw new Error(`invalid incident id: ${id}`);
  return id;
};

const time = (iso: string | undefined) => (iso === undefined ? null : Date.parse(iso));

// Opens the database, bringing in the old incident files the first time.
const imported = new WeakSet<DatabaseSync>();
function db(): DatabaseSync {
  const d = getDb();
  if (!imported.has(d)) {
    imported.add(d);
    importIncidentFiles(d);
  }
  return d;
}

type Row = { body: string; version: number };

function readRow(d: DatabaseSync, id: string): Incident | undefined {
  const row = d.prepare("SELECT body FROM incidents WHERE id = ?").get(id) as Row | undefined;
  return row && incidentSchema.parse(JSON.parse(row.body));
}

// Writes the incident whole, its columns and summary taken from it so they
// can't drift from the body.
function writeRow(d: DatabaseSync, incident: Incident) {
  const previous = d.prepare("SELECT version FROM incidents WHERE id = ?").get(incident.id) as Row | undefined;
  d.prepare(
    `INSERT OR REPLACE INTO incidents
      (id, title, service, severity, status, sort_at, detected_at, resolved_at, archived_at, rule_id,
       version, updated_at, summary, summary_version, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    checkId(incident.id),
    incident.title,
    incident.service,
    incident.severity,
    incident.status,
    Date.parse(incident.run?.startedAt ?? incident.detectedAt),
    Date.parse(incident.detectedAt),
    time(incident.resolvedAt),
    time(incident.archivedAt),
    incident.trigger.rule?.id ?? null,
    (previous?.version ?? 0) + 1,
    Date.now(),
    JSON.stringify(toSummary(incident)),
    SUMMARY_VERSION,
    JSON.stringify(incident),
  );
}

// Saves an incident whole: a new one, or one read under withIncidentLock.
// A change to part of one goes through patchIncident instead.
export async function saveIncident(incident: Incident): Promise<void> {
  const d = db();
  transaction(d, () => writeRow(d, incident));
}

export async function getIncident(id: string): Promise<Incident | undefined> {
  return readRow(db(), checkId(id)) ?? exampleIncidents.find((i) => i.id === id);
}

// Async work on one incident (a read, model calls, then a write), chained so
// two never interleave in this process. On globalThis: one chain per id
// across dev hot reloads.
const g = globalThis as unknown as { triageIncidentWrites?: Map<string, Promise<unknown>> };
const writes = (g.triageIncidentWrites ??= new Map());

export function withIncidentLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (writes.get(id) ?? Promise.resolve()).then(fn);
  writes.set(id, run.catch(() => {}));
  return run;
}

// Read, change and save one incident in a single transaction, so no other
// write (from this process or another) lands between the read and the
// write. Every change to a saved incident goes through here. `fn` returning
// the incident it was given leaves it unsaved (nothing to change, e.g.
// archiving one already archived); throwing saves nothing either.
export function patchIncident(id: string, fn: (incident: Incident) => Incident): Promise<Incident> {
  return withIncidentLock(id, async () => {
    const d = db();
    return transaction(d, () => {
      const incident = readRow(d, checkId(id)) ?? exampleIncidents.find((i) => i.id === id);
      if (!incident) throw new Error(`unknown incident: ${id}`);
      const next = fn(incident);
      if (next !== incident) writeRow(d, next);
      return next;
    });
  });
}

const archivedWhere: Record<ArchivedFilter, string> = {
  exclude: "archived_at IS NULL",
  include: "1",
  only: "archived_at IS NOT NULL",
};

const exampleIds = exampleIncidents.map((e) => e.id);
const notExample = `id NOT IN (${exampleIds.map(() => "?").join(", ")})`;
const isExampleRow = `id IN (${exampleIds.map(() => "?").join(", ")})`;

// Which incidents a list holds: the active ones by default (an archived
// one is left out unless asked for, archive.ts), and optionally only one
// service's, or only those one watch rule opened.
export type IncidentQuery = { archived?: ArchivedFilter; service?: string; ruleId?: string };

// What a list is filtered on, in either shape.
type Listed = Pick<Incident, "id" | "service" | "archivedAt"> & { trigger: { rule?: { id: string } } };

// The runs' rows, newest first, with the query in SQL (the columns are
// indexed copies of the body's fields).
function runRows(d: DatabaseSync, columns: string, { archived = "exclude", service, ruleId }: IncidentQuery): unknown[] {
  const where = [archivedWhere[archived], notExample];
  const params: string[] = [...exampleIds];
  if (service !== undefined) {
    where.push("service = ?");
    params.push(service);
  }
  if (ruleId !== undefined) {
    where.push("rule_id = ?");
    params.push(ruleId);
  }
  return d.prepare(`SELECT ${columns} FROM incidents WHERE ${where.join(" AND ")} ORDER BY sort_at DESC, id`).all(...params);
}

// Runs newest first, then the bundled examples in their own order. An
// example is saved once someone changes it (e.g. decides its approval); the
// saved copy then stands in for the bundled one, in the examples' place.
// The few examples are filtered here rather than in SQL, so a saved copy
// is judged as it is now and the bundled one never stands in for it.
function listed<T extends Listed>(
  runs: T[],
  savedExamples: T[],
  bundled: (e: Incident) => T,
  { archived = "exclude", service, ruleId }: IncidentQuery,
): T[] {
  const saved = new Map(savedExamples.map((e) => [e.id, e]));
  const examples = exampleIncidents
    .map((e) => saved.get(e.id) ?? bundled(e))
    .filter((e) => (service === undefined || e.service === service) && (ruleId === undefined || e.trigger.rule?.id === ruleId));
  return [...runs, ...filterArchived(examples, archived)];
}

// Whole incidents; a page that only lists them reads listIncidentSummaries.
export async function listIncidents(query: IncidentQuery = {}): Promise<Incident[]> {
  const d = db();
  const parse = (rows: unknown[]) => (rows as Row[]).map((r) => incidentSchema.parse(JSON.parse(r.body)));
  const examples = d.prepare(`SELECT body FROM incidents WHERE ${isExampleRow}`).all(...exampleIds);
  return listed(parse(runRows(d, "body", query)), parse(examples), (e) => e, query);
}

type SummaryRow = { id: string; summary: string; summary_version: number };

// The same list as listIncidents, as summaries (list-summary.ts): no
// incident body is parsed unless its summary is out of date.
export async function listIncidentSummaries(query: IncidentQuery = {}): Promise<IncidentSummary[]> {
  const d = db();
  const runs = runRows(d, "id, summary, summary_version", query) as SummaryRow[];
  const examples = d
    .prepare(`SELECT id, summary, summary_version FROM incidents WHERE ${isExampleRow}`)
    .all(...exampleIds) as SummaryRow[];
  return listed(summaries(d, runs), summaries(d, examples), bundledSummary, query);
}

const bundledSummaries = new Map<string, IncidentSummary>();
const bundledSummary = (e: Incident) => {
  let s = bundledSummaries.get(e.id);
  if (!s) bundledSummaries.set(e.id, (s = toSummary(e)));
  return s;
};

// Summaries as saved, with any saved under an older SUMMARY_VERSION made
// again from the body and written back.
function summaries(d: DatabaseSync, rows: SummaryRow[]): IncidentSummary[] {
  const update = d.prepare("UPDATE incidents SET summary = ?, summary_version = ? WHERE id = ?");
  return rows.map((row) => {
    if (row.summary_version === SUMMARY_VERSION) return JSON.parse(row.summary) as IncidentSummary;
    const incident = readRow(d, row.id);
    if (!incident) return JSON.parse(row.summary) as IncidentSummary;
    const summary = toSummary(incident);
    update.run(JSON.stringify(summary), SUMMARY_VERSION, row.id);
    return summary;
  });
}

// Removes the incident's row, for a permanent delete (archive-store.ts). A
// bundled example has none to remove.
export async function removeIncident(id: string): Promise<void> {
  const d = db();
  transaction(d, () => d.prepare("DELETE FROM incidents WHERE id = ?").run(checkId(id)));
}

export function isExample(id: string): boolean {
  return exampleIncidents.some((i) => i.id === id);
}

// Incidents used to be one JSON file each, .data/incidents/<id>.json. They
// move in the first time the database is opened: every file that parses in
// one transaction, then each is read back, and only when all of them are
// there are the files deleted. A row already in the database is newer than
// its file and stays. A file that doesn't parse is left for someone to look
// at; a read-back that fails deletes nothing.
function importIncidentFiles(d: DatabaseSync) {
  const dir = path.join(process.cwd(), ".data", "incidents");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[triage] ${dir} unreadable, incidents not imported`, err);
    return;
  }
  const parsed: { file: string; incident: Incident }[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const incident = incidentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (`${incident.id}.json` !== name) throw new Error(`holds ${incident.id}`);
      parsed.push({ file, incident });
    } catch (err) {
      console.error(`[triage] ${file} unreadable, left in place`, err);
    }
  }
  if (parsed.length === 0) return;

  const has = d.prepare("SELECT 1 FROM incidents WHERE id = ?");
  transaction(d, () => {
    for (const { incident } of parsed) if (!has.get(incident.id)) writeRow(d, incident);
  });
  const missing = parsed.filter(({ incident }) => {
    try {
      return readRow(d, incident.id) === undefined;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    console.error(`[triage] ${missing.length} of ${parsed.length} incident files didn't read back; none deleted`);
    return;
  }
  for (const { file } of parsed) {
    try {
      unlinkSync(file);
    } catch (err) {
      console.error(`[triage] ${file} imported but not deleted`, err);
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // Not empty: a file that didn't parse, or a stray temp file.
  }
  console.log(`[triage] imported ${parsed.length} incidents into the database`);
}
