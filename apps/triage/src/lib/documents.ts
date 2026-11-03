import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getDb, transaction } from "./db";
import { errorMessage } from "./errors";

// Whole JSON documents saved under a name in .data/triage.db (db.ts): the
// settings, the uptime checks. Each used to be a file in .data, and moves in
// the first time it's read or written: the file is checked against the
// document's parse, inserted (a row already there is newer and stays), read
// back, and only then deleted. A file that doesn't parse stays where it is
// and every read or write throws, naming it, until someone fixes or deletes
// it: starting from nothing would let the next save drop what it held.

type Row = { body: string };

// An old file that couldn't be read or doesn't parse.
export class InvalidLegacyFile extends Error {
  constructor(
    readonly file: string,
    readonly why: string,
    options?: ErrorOptions,
  ) {
    super(`${file} isn't valid (${why}). Fix it, or delete it to start over.`, options);
  }
}

// What's wrong with a file's text, without quoting it: a JSON error can echo
// part of the file, and the settings hold keys. Zod's issues name the field
// and what it expected, never the value.
function whyInvalid(err: unknown): string {
  if (err instanceof z.ZodError) return z.prettifyError(err);
  if (err instanceof SyntaxError) return `not valid JSON${/ at position \d+( \(line \d+ column \d+\))?/.exec(err.message)?.[0] ?? ""}`;
  return errorMessage(err);
}

export type StoredDocument<T> = {
  // The saved value, or undefined when nothing is saved.
  read(): T | undefined;
  // Saves the value whole, after checking it with parse.
  write(value: T): void;
  // Reads, changes and saves in one transaction: no other write, from this
  // process or another, lands in between. fn must be synchronous.
  change(fn: (current: T | undefined) => T): T;
};

// name: the row's name. legacyFile: the old file's name in .data, resolved
// from the working directory on each call (tests chdir). parse: checks a
// value read or about to be written, throwing when it isn't valid.
export function storedDocument<T>(name: string, legacyFile: string, parse: (value: unknown) => T): StoredDocument<T> {
  // The handles whose old file is dealt with: imported, or never there.
  const settled = new WeakSet<DatabaseSync>();

  function db(): DatabaseSync {
    const d = getDb();
    if (!settled.has(d) && importFile(d)) settled.add(d);
    return d;
  }

  // True once there's no old file left to import.
  function importFile(d: DatabaseSync): boolean {
    const file = path.join(process.cwd(), ".data", legacyFile);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw new InvalidLegacyFile(file, errorMessage(err), { cause: err });
    }
    const has = d.prepare("SELECT 1 FROM documents WHERE name = ?").get(name);
    if (!has) {
      let value: T;
      try {
        value = parse(JSON.parse(text));
      } catch (err) {
        throw new InvalidLegacyFile(file, whyInvalid(err));
      }
      transaction(d, () =>
        d
          .prepare("INSERT OR IGNORE INTO documents (name, body, updated_at) VALUES (?, ?, ?)")
          .run(name, JSON.stringify(value), Date.now()),
      );
    }
    // Inside a caller's transaction the row isn't committed yet: the file
    // waits for a read outside one, which finds the row and deletes it.
    if (d.isTransaction) return false;
    try {
      const row = d.prepare("SELECT body FROM documents WHERE name = ?").get(name) as Row | undefined;
      if (!row) throw new Error("no row");
      parse(JSON.parse(row.body));
    } catch (err) {
      console.error(`[triage] ${file} imported but didn't read back; not deleted`, err);
      return false;
    }
    try {
      unlinkSync(file);
    } catch (err) {
      console.error(`[triage] ${file} imported but not deleted`, err);
    }
    if (!has) console.log(`[triage] imported ${legacyFile} into the database`);
    return true;
  }

  function readRow(d: DatabaseSync): T | undefined {
    const row = d.prepare("SELECT body FROM documents WHERE name = ?").get(name) as Row | undefined;
    return row && parse(JSON.parse(row.body));
  }

  function writeRow(d: DatabaseSync, value: T) {
    d.prepare("INSERT OR REPLACE INTO documents (name, body, updated_at) VALUES (?, ?, ?)").run(
      name,
      JSON.stringify(parse(value)),
      Date.now(),
    );
  }

  return {
    read: () => readRow(db()),
    write(value) {
      const d = db();
      transaction(d, () => writeRow(d, value));
    },
    change(fn) {
      const d = db();
      return transaction(d, () => {
        const next = fn(readRow(d));
        writeRow(d, next);
        return next;
      });
    },
  };
}
