import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { flagStates } from "@/lib/flags";
import { logger } from "@/lib/logger";

// Releases for the demo: a commit on a `shopfront-release/<name>` branch
// (cut by scripts/release.ts from releases/<name>.patch) that /ops deploys
// into the running store and rolls back. There is no build: a deploy
// applies the commit's diff to the working tree with `git apply` and the
// dev server picks the files up; a rollback applies it in reverse. The
// deploy is logged at warn, as a deploy system would, so Triage sees a
// release go out and can find the commit in git. Triage can't read this
// file.

const GIT_TIMEOUT_MS = 20_000;
const appDir = process.cwd();
const releasesDir = path.join(appDir, "releases");
const branchOf = (name: string) => `shopfront-release/${name}`;

export type Release = {
  name: string;
  branch: string;
  // null until the branch has been cut.
  sha: string | null;
  message: string | null;
  // The files the commit touches, relative to the app.
  files: string[];
};

export type CurrentRelease = {
  name: string;
  sha: string;
  branch: string;
  message: string;
  deployedAt: string;
  // HEAD's short sha when the release went out: what a rollback returns to.
  previous: string;
};

// On globalThis so dev hot reloads keep what is deployed and the list of
// releases, which costs a few git calls to build.
const globalForReleases = globalThis as unknown as {
  shopfrontRelease?: CurrentRelease | null;
  shopfrontReleases?: Promise<Release[]> | null;
  shopfrontRepoRoot?: Promise<string>;
};

export const currentRelease = () => globalForReleases.shopfrontRelease ?? null;

function git(args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim().split("\n")[0] || err.message));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input ?? "");
  });
}

// Diffs name paths from the repo root, so git runs there.
const repoRoot = () =>
  (globalForReleases.shopfrontRepoRoot ??= git(["rev-parse", "--show-toplevel"], appDir).then((s) => s.trim()));

const filesIn = (patch: string) =>
  [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1].replace(/^apps\/shopfront\//, ""));

// Fresh from git: one patch in releases/ is one release.
export async function listReleases(): Promise<Release[]> {
  const root = await repoRoot();
  const names = (await readdir(releasesDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".patch"))
    .map((f) => f.slice(0, -".patch".length))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const branch = branchOf(name);
      const files = filesIn(await readFile(path.join(releasesDir, `${name}.patch`), "utf8"));
      const sha = await git(["rev-parse", "--short", "--verify", "--quiet", `${branch}^{commit}`], root)
        .then((s) => s.trim() || null)
        .catch(() => null);
      const message = sha ? (await git(["log", "-1", "--format=%s", sha], root)).trim() : null;
      return { name, branch, sha, message, files };
    }),
  );
}

// The list /ops shows, built once per process and again after each deploy
// or rollback. A list with a branch still to cut isn't kept, so the branch
// shows up once the script has run, without a restart.
export async function releases(): Promise<Release[]> {
  const list = await (globalForReleases.shopfrontReleases ??= listReleases());
  if (list.some((r) => !r.sha)) refreshReleases();
  return list;
}
const refreshReleases = () => {
  globalForReleases.shopfrontReleases = null;
};

// Applied with one line of context, not three: an uncommitted edit near
// the changed lines would otherwise refuse a commit that fits fine.
const applyArgs = ["apply", "-C1"];

// The app's files, and the workspace lockfile: a release that adds a
// dependency changes both.
const diffOf = (root: string, sha: string) => git(["diff", `${sha}^`, sha, "--", "apps/shopfront", "pnpm-lock.yaml"], root);

// A release that changes dependencies (vulnerable-dep) goes out in two
// steps: package.json and the lockfile, then an install, then the code that
// imports the new package, so the dev server never compiles an import of a
// package that isn't there yet. A rollback runs the same steps backwards.
const manifests = ["apps/shopfront/package.json", "pnpm-lock.yaml"];
const only = manifests.map((m) => `--include=${m}`);
const except = manifests.map((m) => `--exclude=${m}`);
const changesDependencies = (diff: string) => manifests.some((m) => diff.includes(`diff --git a/${m} `));

const INSTALL_TIMEOUT_MS = 180_000;

// pnpm installs what the lockfile says, from the workspace root; it's a .cmd
// shim on Windows, which only a shell starts. The command is fixed.
function install(root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = "pnpm install --frozen-lockfile --filter @triage/shopfront";
    // From the environment: Next's bundler folds process.platform and
    // os.platform() into constants in the server build.
    const windows = process.env.OS === "Windows_NT";
    execFile(
      windows ? "cmd.exe" : "sh",
      windows ? ["/d", "/s", "/c", command] : ["-c", command],
      { cwd: root, timeout: INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`pnpm install failed: ${(stderr || stdout).trim().split("\n").at(-1) || err.message}`));
        else resolve();
      },
    );
  });
}

export async function deploy(name: string): Promise<CurrentRelease> {
  const deployed = currentRelease();
  if (deployed) throw new Error(`“Release ${deployed.name}” is already deployed. Roll it back first: only one fault runs at a time.`);
  const flag = flagStates().find((f) => f.enabled);
  if (flag) throw new Error(`${flag.name} is on. Turn it off first: only one fault runs at a time.`);
  const release = (await listReleases()).find((r) => r.name === name);
  if (!release) throw new Error(`There is no release named ${name}.`);
  if (!release.sha || !release.message) {
    throw new Error(`${release.branch} hasn't been cut: run pnpm --filter @triage/shopfront release ${name}.`);
  }

  const root = await repoRoot();
  const diff = await diffOf(root, release.sha);
  await git([...applyArgs, "--check"], root, diff).catch((err: Error) => {
    throw new Error(`Release ${name} doesn't apply to the working tree (${err.message}).`);
  });
  const previous = (await git(["rev-parse", "--short", "HEAD"], root)).trim();
  if (changesDependencies(diff)) {
    await git([...applyArgs, ...only], root, diff);
    await install(root).catch(async (err: Error) => {
      await git([...applyArgs, "-R", ...only], root, diff);
      throw new Error(`Release ${name} adds dependencies that couldn't be installed (${err.message}).`);
    });
    await git([...applyArgs, ...except], root, diff);
  } else await git(applyArgs, root, diff);

  const current: CurrentRelease = {
    name,
    sha: release.sha,
    branch: release.branch,
    message: release.message,
    deployedAt: new Date().toISOString(),
    previous,
  };
  globalForReleases.shopfrontRelease = current;
  refreshReleases();
  logger.warn(`deploy: ${current.sha} ${current.message}`, {
    "deploy.sha": current.sha,
    "deploy.message": current.message,
    "deploy.kind": "deploy",
    "deploy.branch": current.branch,
  });
  return current;
}

export async function rollback(): Promise<void> {
  const deployed = currentRelease();
  if (!deployed) throw new Error("No release is deployed.");
  const root = await repoRoot();
  const diff = await diffOf(root, deployed.sha);
  const reverse = (extra: string[]) =>
    git([...applyArgs, "-R", ...extra], root, diff).catch((err: Error) => {
      throw new Error(`Release ${deployed.name} can't be rolled back (${err.message}).`);
    });
  if (changesDependencies(diff)) {
    await reverse(except);
    await reverse(only);
    await install(root);
  } else await reverse([]);
  globalForReleases.shopfrontRelease = null;
  refreshReleases();
  logger.warn(`deploy: rolled back ${deployed.sha}`, {
    "deploy.sha": deployed.sha,
    "deploy.kind": "rollback",
    "deploy.previous": deployed.previous,
  });
}
