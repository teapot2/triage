import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { checkIdPattern, sampleSchema } from "./investigation/uptime/model";

// Triage's SQLite database, .data/triage.db (gitignored), on Node's built-in
// driver. Synchronous: a query never yields, so code between two statements
// can't interleave with another request's in this process; other processes
// (a script, a second server) wait on the lock up to busy_timeout.

// Handles by resolved path, on globalThis so a Next dev reload of this module
// reuses them instead of opening another. Keyed by path, not one singleton:
// tests chdir into temp directories, each with its own database.
const g = globalThis as typeof globalThis & { __triageDbs?: Map<string, DatabaseSync> };
const handles = (g.__triageDbs ??= new Map());

// The schema, one step per version (PRAGMA user_version counts the steps
// applied). A change is a new step at the end; never edit a shipped one.
const migrations: string[] = [
  `CREATE TABLE uptime_samples (
    check_id TEXT NOT NULL,
    at INTEGER NOT NULL, -- epoch ms, UTC
    ms INTEGER NOT NULL,
    status INTEGER,
    outcome TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (check_id, at)
  ) WITHOUT ROWID;
  CREATE TABLE uptime_hourly (
    check_id TEXT NOT NULL,
    hour INTEGER NOT NULL, -- start of the UTC hour, epoch ms
    checks INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    slow INTEGER NOT NULL,
    down INTEGER NOT NULL,
    avg_ms REAL NOT NULL,
    max_ms INTEGER NOT NULL,
    PRIMARY KEY (check_id, hour)
  ) WITHOUT ROWID;`,
];

export function getDb(): DatabaseSync {
  const dir = path.join(process.cwd(), ".data");
  const file = path.resolve(dir, "triage.db");
  let db = handles.get(file);
  if (db) return db;
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
    migrate(db);
    importUptimeFiles(db, dir);
  } catch (err) {
    db.close();
    throw err;
  }
  handles.set(file, db);
  return db;
}

// Closes every open database; tests call it before removing their temp
// directory (Windows won't delete an open file).
export function closeDb() {
  for (const db of handles.values()) db.close();
  handles.clear();
}

// Runs fn in a write transaction: all of it lands or none of it. IMMEDIATE
// takes the write lock up front, so two processes can't both read and then
// deadlock upgrading to write.
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

function migrate(db: DatabaseSync) {
  const version = () => Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  while (version() < migrations.length) {
    // Read again inside the lock: another process may have just migrated.
    transaction(db, () => {
      const v = version();
      if (v >= migrations.length) return;
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

// Endpoint results used to be one JSON file per check, .data/uptime/<id>.json
// as { samples: [] }. Each moves in on open: its rows in one transaction, the
// file deleted only once they're committed. A crash between the two imports
// it again on the next open, and INSERT OR IGNORE drops the rows already in.
// A file that can't be read stays where it is, for someone to look at.
const uptimeFileSchema = z.object({ samples: z.array(sampleSchema) });

function importUptimeFiles(db: DatabaseSync, dataDir: string) {
  const dir = path.join(dataDir, "uptime");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[triage] ${dir} unreadable, samples not imported`, err);
    return;
  }
  const insert = db.prepare(
    "INSERT OR IGNORE INTO uptime_samples (check_id, at, ms, status, outcome, error) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const name of names) {
    const checkId = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !checkIdPattern.test(checkId)) continue;
    const file = path.join(dir, name);
    try {
      const { samples } = uptimeFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      transaction(db, () => {
        for (const s of samples) insert.run(checkId, Date.parse(s.at), s.ms, s.status ?? null, s.outcome, s.error ?? null);
      });
    } catch (err) {
      console.error(`[triage] ${file} unreadable, left in place`, err);
      continue;
    }
    try {
      unlinkSync(file);
    } catch (err) {
      console.error(`[triage] ${file} imported but not deleted`, err);
    }
  }
}
