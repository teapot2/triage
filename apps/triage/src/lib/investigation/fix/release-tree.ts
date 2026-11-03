import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { harnessPaths } from "../live/live-source";
import type { Incident } from "../schema";

// The app's source as a commit has it, read from git rather than the
// working tree. A fix for a rolled-back release is written and proven
// against the release's code: the rollback takes the release's files out of
// the live checkout while the fix stage is still reading them, and the fix
// PR targets the release branch, so the live tree is the wrong one to read
// either way.

const run = promisify(execFile);
// A source file is well under this; it keeps a stray large blob from
// failing the read.
const MAX_BUFFER = 32 * 1024 * 1024;

const git = async (cwd: string, args: string[]) => (await run("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER })).stdout;

// The commit a fix must be written against: the release the mitigation
// rolls back, when it does. Undefined for every other incident (a flag
// turned off, no mitigation), which read the live tree.
export function releaseShaOf(incident: Pick<Incident, "mitigation">): string | undefined {
  const m = incident.mitigation;
  return m?.kind === "rollback" && m.target ? m.target : undefined;
}

// Where the app sits in its repository: the checkout's root and the app's
// folder inside it ("apps/shopfront/"), which every path in a commit's tree
// starts with. Read once per app.
const repos = new Map<string, Promise<{ root: string; prefix: string }>>();
export function repoOf(appDir: string): Promise<{ root: string; prefix: string }> {
  let repo = repos.get(appDir);
  if (!repo) {
    repo = (async () => {
      const root = (await git(appDir, ["rev-parse", "--show-toplevel"])).trim();
      const prefix = (await git(appDir, ["rev-parse", "--show-prefix"])).trim();
      return { root, prefix };
    })();
    repos.set(appDir, repo);
  }
  return repo;
}

export async function hasCommit(appDir: string, sha: string): Promise<boolean> {
  try {
    await git(appDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// Every file under the app at the commit, relative to the app, with forward
// slashes, as git lists them.
export async function listFilesAt(appDir: string, sha: string): Promise<string[]> {
  const { root, prefix } = await repoOf(appDir);
  const out = await git(root, ["ls-tree", "-r", "--name-only", "--full-tree", "-z", sha, ...(prefix ? [prefix] : [])]);
  return out
    .split("\0")
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
}

// A file's contents at the commit, as committed (LF line endings, whatever
// the checkout uses); undefined when the commit has no such file.
export async function readFileAt(appDir: string, sha: string, rel: string): Promise<string | undefined> {
  const { root, prefix } = await repoOf(appDir);
  try {
    return await git(root, ["show", `${sha}:${prefix}${rel}`]);
  } catch {
    return undefined;
  }
}

// Writes the app's files at the commit (those `keep` allows) under `dir`,
// laid out as in the app. One `git cat-file --batch` for all of them, so
// the contents are byte for byte what readFileAt returns. Returns the files
// written.
export async function exportTreeAt(
  appDir: string,
  sha: string,
  dir: string,
  keep: (rel: string) => boolean = () => true,
): Promise<string[]> {
  const { root, prefix } = await repoOf(appDir);
  const files = (await listFilesAt(appDir, sha)).filter(keep);
  await mkdir(dir, { recursive: true });
  const blobs = await catFileBatch(
    root,
    files.map((f) => `${sha}:${prefix}${f}`),
  );
  const written: string[] = [];
  for (const [i, file] of files.entries()) {
    const blob = blobs[i];
    if (!blob) continue;
    const target = path.join(dir, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, blob);
    written.push(file);
  }
  return written;
}

// `git cat-file --batch`: each requested object comes back in order as a
// header line (`<oid> <type> <size>`) followed by that many bytes and a
// newline, or `<request> missing`. Undefined for a missing one.
async function catFileBatch(root: string, requests: string[]): Promise<(Buffer | undefined)[]> {
  if (requests.length === 0) return [];
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", root, "cat-file", "--batch"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (error += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`git cat-file failed: ${error.trim()}`));
    });
    child.stdin.end(requests.map((r) => `${r}\n`).join(""));
  });
  const blobs: (Buffer | undefined)[] = [];
  let at = 0;
  for (let i = 0; i < requests.length; i++) {
    const eol = output.indexOf(0x0a, at);
    if (eol === -1) throw new Error("git cat-file ended early");
    const header = output.subarray(at, eol).toString();
    at = eol + 1;
    if (header.endsWith(" missing")) {
      blobs.push(undefined);
      continue;
    }
    const size = Number(header.split(" ")[2]);
    blobs.push(output.subarray(at, at + size));
    // The newline after the object's bytes.
    at += size + 1;
  }
  return blobs;
}

// What the fix stage may read at the commit: the same files the live
// source's read_source opens (live-source.ts listSourceFiles), the app's
// code and migrations, never the harness that plants the faults.
const sourceExt = /\.(ts|tsx|js|mjs|css|sql|json)$/;
const rootFiles = ["package.json", "next.config.ts", "drizzle.config.ts"];
const isHarness = (rel: string) => harnessPaths.some((h) => (h.endsWith("/") ? rel.startsWith(h) : rel === h));

export async function sourceFilesAt(appDir: string, sha: string): Promise<string[]> {
  const files = await listFilesAt(appDir, sha);
  return files
    .filter(
      (f) =>
        rootFiles.includes(f) || (f.startsWith("src/") && sourceExt.test(f)) || (f.startsWith("drizzle/") && f.endsWith(".sql")),
    )
    .filter((f) => !isHarness(f))
    .sort();
}
