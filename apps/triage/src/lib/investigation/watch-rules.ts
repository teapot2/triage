import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defaultRules, rulesSchema, type WatchRule } from "./watch-rule-model";

// What the watch listens for: rules, each a condition on the requests to
// some routes over a recent window (the model is in watch-rule-model). Saved
// server-side in .data/watch-rules.json (gitignored), since the watch runs on
// the server; until anything is saved, the defaults apply.

export * from "./watch-rule-model";

const file = path.join(process.cwd(), ".data", "watch-rules.json");

export async function readRules(): Promise<WatchRule[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultRules;
    throw err;
  }
  // Rules that don't parse aren't swapped for the defaults: a save from
  // there would drop the ones the file meant to hold.
  try {
    return rulesSchema.parse(JSON.parse(text).rules);
  } catch (err) {
    const why = err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err);
    throw new Error(`${file} isn't valid (${why}). Fix it, or delete it to use the default rules.`);
  }
}

export async function saveRules(rules: WatchRule[]) {
  await mkdir(path.dirname(file), { recursive: true });
  // A tmp file per save: two saves at once must not write into the same one.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ rules: rulesSchema.parse(rules) }, null, 2));
  await rename(tmp, file);
}
