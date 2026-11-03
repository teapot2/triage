import { z } from "zod";
import { checksSchema, type UptimeCheck } from "./model";
import { InvalidLegacyFile, storedDocument } from "../../documents";

// The configured uptime checks (the model is in model.ts), saved whole as
// the "uptime-checks" document in .data/triage.db (documents.ts), as
// { checks: [] }. They used to be .data/uptime-checks.json, which moves in
// the first time they're read. Nothing saved means no checks.

export * from "./model";

const checksDocument = storedDocument("uptime-checks", "uptime-checks.json", (v) =>
  z.object({ checks: checksSchema }).parse(v),
);

// An old file that doesn't parse isn't read as no checks, and stops a save
// too: a save from there would drop the ones it meant to hold.
function fromFile<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof InvalidLegacyFile)) throw err;
    throw new Error(`${err.file} isn't valid (${err.why}). Fix it, or delete it to start with no checks.`, { cause: err });
  }
}

export async function readChecks(): Promise<UptimeCheck[]> {
  return fromFile(() => checksDocument.read()?.checks ?? []);
}

export async function saveChecks(checks: UptimeCheck[]) {
  fromFile(() => checksDocument.write({ checks }));
}
