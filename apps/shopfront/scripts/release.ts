// Cuts a release branch for the demo store: `shopfront-release/<name>` is
// one commit on top of the repo's current `main`, applying
// releases/<name>.patch, so a deploy from /ops has a real commit behind it
// for Triage's git_log to find. Runs on a private index (GIT_INDEX_FILE)
// and plumbing only: nothing is checked out and the working tree and index
// stay as they are. Nothing is pushed.
//
//   pnpm --filter @triage/shopfront release formatted-price
//
// Running it again leaves the branch alone when main hasn't moved; when it
// has, the branch is moved onto the new main.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One commit message per release, in the team's voice: it shows in git log.
const messages: Record<string, string> = {
  "formatted-price": "feat(shopfront): return a formatted price from the product API",
  "journal-copy": "chore(shopfront): reword the journal page intro",
  "vulnerable-dep": "feat(shopfront): report the Node runtime and its engines check on /api/health",
};

async function git(args: string[], env?: Record<string, string>) {
  const { stdout } = await run("git", args, {
    cwd: appDir,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 20_000,
    windowsHide: true,
  });
  return stdout.trim();
}

async function main() {
  const name = process.argv[2];
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    console.error("usage: pnpm --filter @triage/shopfront release <name>   (a file releases/<name>.patch)");
    process.exitCode = 1;
    return;
  }
  const message = messages[name];
  const patch = path.join(appDir, "releases", `${name}.patch`);
  if (!message || !(await readFile(patch, "utf8").catch(() => null))) {
    console.error(`No release named ${name}: expected releases/${name}.patch and a commit message in scripts/release.ts.`);
    process.exitCode = 1;
    return;
  }

  const branch = `shopfront-release/${name}`;
  const base = await git(["rev-parse", "--verify", "main^{commit}"]);

  // The private index starts as main's tree, takes the patch, and becomes
  // the commit's tree. It lives outside the repo and goes when we're done.
  const dir = await mkdtemp(path.join(os.tmpdir(), "shopfront-release-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    await git(["read-tree", base], env);
    // From the repo root: run in the app, git apply would skip the paths
    // outside it, the workspace lockfile among them.
    const root = await git(["rev-parse", "--show-toplevel"]);
    await git(["-C", root, "apply", "--cached", patch], env);
    const tree = await git(["write-tree"], env);

    // Same parent and same tree: the branch is already this release.
    const existing = await git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]).catch(() => "");
    if (existing) {
      const [parent, existingTree] = await Promise.all([
        git(["rev-parse", "--verify", "--quiet", `${existing}^`]).catch(() => ""),
        git(["rev-parse", `${existing}^{tree}`]),
      ]);
      if (parent === base && existingTree === tree) {
        console.log(`${branch} ${await git(["rev-parse", "--short", existing])} (already on main ${base.slice(0, 7)})`);
        return;
      }
    }

    const commit = await git(["commit-tree", tree, "-p", base, "-m", message]);
    await git(["update-ref", "-m", `release: cut ${name}`, `refs/heads/${branch}`, commit]);
    console.log(`${branch} ${await git(["rev-parse", "--short", commit])} (on main ${base.slice(0, 7)})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`release failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
