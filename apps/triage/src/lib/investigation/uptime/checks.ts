import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { checksSchema, type UptimeCheck } from "./model";

// The configured uptime checks (the model is in model.ts), saved whole in
// .data/uptime-checks.json (gitignored) as { checks: [] }, the way
// watch-rules.ts saves rules. No file means no checks.

export * from "./model";

// Resolved on each call, so tests can run in a temp working directory.
const checksFile = () => path.join(process.cwd(), ".data", "uptime-checks.json");

export async function readChecks(): Promise<UptimeCheck[]> {
  const file = checksFile();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // A file that doesn't parse isn't read as no checks: a save from there
  // would drop the ones it meant to hold.
  try {
    return checksSchema.parse(JSON.parse(text).checks);
  } catch (err) {
    const why = err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err);
    throw new Error(`${file} isn't valid (${why}). Fix it, or delete it to start with no checks.`);
  }
}

export async function saveChecks(checks: UptimeCheck[]) {
  const file = checksFile();
  await mkdir(path.dirname(file), { recursive: true });
  // A tmp file per save: two saves at once must not write into the same one.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ checks: checksSchema.parse(checks) }, null, 2));
  await rename(tmp, file);
}
