import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultRules, rulesSchema, type WatchRule } from "./watch-rule-model";

// What the watch listens for: rules, each a condition on the requests to
// some routes over a recent window (the model is in watch-rule-model). Saved
// server-side in .data/watch-rules.json (gitignored), since the watch runs on
// the server; until anything is saved, the defaults apply.

export * from "./watch-rule-model";

const file = path.join(process.cwd(), ".data", "watch-rules.json");

export async function readRules(): Promise<WatchRule[]> {
  try {
    return rulesSchema.parse(JSON.parse(await readFile(file, "utf8")).rules);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultRules;
    throw err;
  }
}

export async function saveRules(rules: WatchRule[]) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ rules: rulesSchema.parse(rules) }, null, 2));
  await rename(tmp, file);
}
