// Checks that Triage investigates Shopfront blind: nothing its tools can
// read (source files and git history, outside Shopfront's demo harness)
// names the planted bug, the fault switches, or Triage itself, and nothing
// the harness logs names the demo: Triage can't open the harness's files,
// but what they log lands in the same logs query_logs reads. A diagnosis
// is only worth something if the agent found it in the evidence.
//
//   pnpm --filter @triage/web check:blind
//
// Exits 1 and lists every hit.

import { gitLog, harnessPaths, listSourceFiles, shopfrontDir } from "../src/lib/investigation/live/live-source";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Words that describe the bug or the setup, not the app. "Triage" is
// case-sensitive so the "triage" database user doesn't count.
const giveaways = [/leak/i, /planted/i, /\bfaults?\b/i, /\bTriage\b/, /pool[- ]exhaust/i, /stuck connection/i];

// Words a harness log line may not carry either: a customer's app has no
// demo, no synthetic visitors and no scenarios. A flag flip ("ops: FF_X
// turned on") stands in for the config push a real flag system logs, so
// "ops" is allowed.
const harnessGiveaways = [/synthetic/i, /\bdemo\b/i, /harness/i, /\btraffic\b/i, /scenario/i, ...giveaways];

const hits: string[] = [];
const scan = (where: string, text: string, patterns = giveaways) => {
  text.split("\n").forEach((line, i) => {
    if (patterns.some((re) => re.test(line))) hits.push(`${where}:${i + 1}: ${line.trim()}`);
  });
};

// What a line logs: the first string argument of a logger call on it.
const logged = /\blogger\.(?:debug|info|warn|error)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/;

// The harness's files (folders walked), relative to Shopfront.
async function harnessFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const rel of harnessPaths) {
    const abs = path.join(shopfrontDir, rel);
    const info = await stat(abs).catch(() => undefined);
    if (!info) continue;
    if (!info.isDirectory()) {
      files.push(rel);
      continue;
    }
    for (const entry of await readdir(abs, { recursive: true })) {
      if (/\.(ts|tsx)$/.test(entry)) files.push(path.posix.join(rel, entry.replace(/\\/g, "/")));
    }
  }
  return files;
}

async function main() {
  const files = await listSourceFiles();
  for (const rel of files) scan(rel, await readFile(path.join(shopfrontDir, rel), "utf8"));

  // gitLog swallows git's errors and answers with no commits, which is also
  // what Triage's git_log tool sees then: say so instead of calling the
  // history clean. Seen when git refuses the checkout as "dubious
  // ownership" from a subfolder (safe.directory).
  const commits = await gitLog({ limit: 1000 });
  if (commits.length === 0) {
    console.error(
      "check:blind: git log returned no commits for Shopfront, so its history can't be checked and Triage's git_log tool reads nothing here. Run `git -C apps/shopfront log -n1` to see why.",
    );
    process.exitCode = 1;
    return;
  }
  for (const c of commits) scan(`commit ${c.sha}`, `${c.message}\n${c.files.join("\n")}`);

  // The harness's log lines: only what it logs, since the code itself is
  // out of Triage's reach and may say what it is.
  const harness = await harnessFiles();
  for (const rel of harness) {
    const lines = (await readFile(path.join(shopfrontDir, rel), "utf8")).split("\n");
    lines.forEach((line, i) => {
      const message = logged.exec(line)?.[2];
      if (message !== undefined) scan(`${rel}:${i + 1} (logged)`, message, harnessGiveaways);
    });
  }

  if (hits.length) {
    console.error(`check:blind: ${hits.length} giveaway(s) Triage can read:\n${hits.map((h) => `  ${h}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(
      `check:blind: clean (${files.length} files, ${commits.length} commits, ${harness.length} harness files' logs).`,
    );
  }
}

main().catch((err) => {
  console.error(`check:blind failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
