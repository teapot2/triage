import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Incident } from "../schema";

// Stage 5: once a human approves a proven fix, open a pull request with the
// patch and its regression test. Works in a temporary git worktree on a new
// branch cut from the remote's base branch, so the checkout people work in
// is never touched. Nothing merges: a person reviews and merges the PR.

const run = promisify(execFile);

export type PullRequestTarget = {
  // The app's folder inside its git repository (the patch's paths are
  // relative to it).
  appDir: string;
  // Opens the PR and returns its URL. Defaults to the GitHub CLI.
  create?: (pr: { cwd: string; base: string; branch: string; title: string; body: string }) => Promise<string>;
};

// The useful line of a failed command: its stderr, else the error itself.
const why = (err: unknown) => {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr || e.message || String(err)).trim().split("\n");
  return text.find((l) => /error|fatal|failed/i.test(l)) ?? text[0];
};

async function git(cwd: string, args: string[]) {
  const { stdout } = await run("git", ["-c", "core.autocrlf=false", ...args], { cwd, windowsHide: true, maxBuffer: 1 << 24 });
  return stdout.trim();
}

async function ghCreate({ cwd, base, branch, title, body }: Parameters<NonNullable<PullRequestTarget["create"]>>[0]) {
  const bodyFile = path.join(cwd, ".triage-pr-body.md");
  await writeFile(bodyFile, body);
  try {
    const { stdout } = await run(
      "gh",
      // A draft, so it can't be merged without someone first marking it
      // ready for review.
      ["pr", "create", "--draft", "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile],
      { cwd, windowsHide: true },
    );
    // gh prints the PR's URL as its last line.
    return stdout.trim().split("\n").at(-1) ?? "";
  } finally {
    await rm(bodyFile, { force: true });
  }
}

// What the PR says: the diagnosis, the change, and the sandbox proof, so a
// reviewer can judge it without opening Triage.
export function pullRequestText(incident: Incident): { title: string; body: string } {
  const { report, fix, validation } = incident;
  if (!report || !fix) throw new Error("no proven fix to open a PR for");
  const verdict = report.verdict;
  const cause = verdict.kind === "root_cause" ? report.hypotheses.find((h) => h.id === verdict.hypothesisId) : undefined;
  const title = `Fix: ${cause?.title ?? incident.title}`.slice(0, 120);
  const runs = (validation ?? [])
    .map((r) => `| ${r.label} | \`${r.command}\` | ${r.exitCode} | ${r.tests.map((t) => `${t.status}`).join(", ") || "–"} |`)
    .join("\n");
  const body = `${fix.summary}

## Why

${report.summary ?? ""}

${cause ? `- **Symptom:** ${cause.causalChain.symptom.text}\n- **Propagation:** ${cause.causalChain.propagation.text}\n- **Root cause:** ${cause.causalChain.rootCause.text}` : ""}

## Proof

The regression test \`${fix.regressionTest.file}\` ("${fix.regressionTest.name}") was run in a sandbox copy of the app: it fails on the current code and passes with this change, and the patched app typechecks.

| Run | Command | Exit code | Tests |
| --- | --- | --- | --- |
${runs}

Risk: ${fix.risk}${fix.touchesData ? " · touches data" : ""}. Approved in Triage (incident \`${incident.id}\`). Opened as a draft: nothing is deployed until it is marked ready and merged.

---
Opened by Triage, an AI SRE.
`;
  return { title, body };
}

export async function openPullRequest(incident: Incident, target: PullRequestTarget): Promise<string> {
  if (!incident.fix) throw new Error("no proven fix to open a PR for");
  const { title, body } = pullRequestText(incident);

  let root: string;
  try {
    root = await git(target.appDir, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("the app isn't in a git repository yet, so there's nowhere to open a PR");
  }
  // Where the app sits in the repo, e.g. "apps/shopfront", so the patch's
  // app-relative paths land in the right place.
  const prefix = (await git(target.appDir, ["rev-parse", "--show-prefix"])).replace(/\/$/, "");

  // The remote's default branch, freshly fetched.
  let base = process.env.TRIAGE_PR_BASE ?? "";
  if (!base) {
    const head = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "origin/main");
    base = head.replace(/^origin\//, "");
  }
  try {
    await git(root, ["fetch", "origin", base]);
  } catch (err) {
    throw new Error(`couldn't fetch ${base} from origin: ${why(err)}`);
  }

  const branch = `triage/${incident.id.replace(/^inc_/, "").replace(/_/g, "-")}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "triage-pr-"));
  const patchFile = path.join(os.tmpdir(), `${path.basename(dir)}.patch`);
  try {
    await git(root, ["worktree", "add", "-B", branch, dir, `origin/${base}`]);
    await writeFile(patchFile, `${incident.fix.patch}\n`);
    try {
      await git(dir, ["apply", "-p1", ...(prefix ? [`--directory=${prefix}`] : []), patchFile]);
    } catch (err) {
      throw new Error(`the patch no longer applies to ${base}; the code changed since the fix was proven (${why(err)})`);
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", title, "-m", incident.fix.summary]);
    try {
      await git(dir, ["push", "--force-with-lease", "-u", "origin", branch]);
    } catch (err) {
      throw new Error(`couldn't push ${branch}: ${why(err)}`);
    }
    let url: string;
    try {
      url = await (target.create ?? ghCreate)({ cwd: dir, base, branch, title, body });
    } catch (err) {
      throw new Error(`couldn't open the PR: ${why(err)}`);
    }
    if (!/^https?:\/\//.test(url)) throw new Error(`the PR was not created: ${url || "no URL returned"}`);
    return url;
  } finally {
    await git(root, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(patchFile, { force: true });
    // The branch lives on the remote now; the local copy is only clutter.
    await git(root, ["branch", "-D", branch]).catch(() => undefined);
  }
}
