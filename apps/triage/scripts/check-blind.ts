// Checks that Triage investigates Shopfront blind: nothing its tools can
// read (source files and git history, outside Shopfront's demo harness)
// names the planted bug, the fault switches, or Triage itself. A diagnosis
// is only worth something if the agent found it in the evidence.
//
//   pnpm --filter @triage/web check:blind
//
// Exits 1 and lists every hit.

import { gitLog, listSourceFiles, shopfrontDir } from "../src/lib/investigation/live/live-source";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Words that describe the bug or the setup, not the app. "Triage" is
// case-sensitive so the "triage" database user doesn't count.
const giveaways = [/leak/i, /planted/i, /\bfaults?\b/i, /\bTriage\b/, /pool[- ]exhaust/i, /stuck connection/i];

const hits: string[] = [];
const scan = (where: string, text: string) => {
  text.split("\n").forEach((line, i) => {
    if (giveaways.some((re) => re.test(line))) hits.push(`${where}:${i + 1}: ${line.trim()}`);
  });
};

async function main() {
  const files = await listSourceFiles();
  for (const rel of files) scan(rel, await readFile(path.join(shopfrontDir, rel), "utf8"));

  const commits = await gitLog({ limit: 1000 });
  for (const c of commits) scan(`commit ${c.sha}`, `${c.message}\n${c.files.join("\n")}`);

  if (hits.length) {
    console.error(`check:blind: ${hits.length} giveaway(s) Triage can read:\n${hits.map((h) => `  ${h}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`check:blind: clean (${files.length} files, ${commits.length} commits).`);
  }
}

main().catch((err) => {
  console.error(`check:blind failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
