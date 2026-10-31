import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Incident } from "../schema";
import { dataChangeOf } from "./data-change";

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
  // A data change the sandbox couldn't prove gets a warning and a checklist
  // at the top, where a reviewer reads first.
  const data = dataChangeOf(fix);
  const unproven = data.unproven.map((f) => `\`${f}\``).join(", ");
  const dataSection = data.detected
    ? `
> [!WARNING]
> **This fix changes stored data.** The sandbox runs tests against the database read-only, so the data change was not proven there${unproven ? ` (${unproven} never ran)` : ""}.

${data.reasons.map((r) => `- ${r}`).join("\n")}

Before marking it ready:

- [ ] Review the SQL: which rows it touches, and that it's safe to run more than once.
- [ ] Run it against a copy of the production data first and check the result.
- [ ] It ships with the deploy: merging this runs it against production.
`
    : "";
  const body = `${fix.summary}
${dataSection}
## Why

${report.summary ?? ""}

${cause ? `- **Symptom:** ${cause.causalChain.symptom.text}\n- **Propagation:** ${cause.causalChain.propagation.text}\n- **Root cause:** ${cause.causalChain.rootCause.text}` : ""}

## Proof

The regression test \`${fix.regressionTest.file}\` ("${fix.regressionTest.name}") was run in a sandbox copy of the app: it fails on the current code and passes with this change, and the patched app typechecks.

| Run | Command | Exit code | Tests |
| --- | --- | --- | --- |
${runs}

Risk: ${fix.risk}${data.detected ? " · changes stored data" : ""}. Approved in Triage (incident \`${incident.id}\`). Opened as a draft: nothing is deployed until it is marked ready and merged.

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
    const apply = async (patch: string) => {
      await writeFile(patchFile, `${patch}\n`);
      await git(dir, ["apply", "-p1", ...(prefix ? [`--directory=${prefix}`] : []), patchFile]);
    };
    try {
      await apply(incident.fix.patch);
    } catch (err) {
      // A fix proven in a checkout made with core.autocrlf=true diffs CRLF
      // files, while this worktree has the repository's LF ones: try again
      // with the line endings the base branch has.
      const lf = incident.fix.patch.replace(/\r\n/g, "\n");
      const retried = lf !== incident.fix.patch && (await apply(lf).then(() => true, () => false));
      if (!retried) {
        throw new Error(`the patch no longer applies to ${base}; the code changed since the fix was proven (${why(err)})`);
      }
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
