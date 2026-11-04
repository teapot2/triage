import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Incident } from "../schema";
import { findLockfile, runPackageManager } from "../dependencies/audit";
import { type DeployedRelease, dependencyPrBase } from "../dependencies/fix";
import { dataChangeOf } from "./data-change";

// Stage 5: once a human approves a proven fix, open a pull request with the
// patch and its regression test. Works in a temporary git worktree on a new
// branch cut from the remote's base branch (the rolled-back release's branch
// when the mitigation was a rollback), so the checkout people work in is
// never touched. Nothing merges: a person reviews and merges the PR.

const run = promisify(execFile);

export type PullRequestTarget = {
  // A dependency bump's: the release deployed now, which may be the base
  // (dependencies/fix.ts dependencyPrBase). Defaults to Shopfront's ops API.
  release?: () => Promise<DeployedRelease | undefined>;
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

const proofTable = (validation: Incident["validation"]) =>
  (validation ?? [])
    .map((r) => `| ${r.label} | \`${r.command}\` | ${r.exitCode} | ${r.tests.map((t) => `${t.status}`).join(", ") || "–"} |`)
    .join("\n");

const exposureLabels = { reachable: "Reachable", transitive_only: "Transitive only", not_reachable: "Not reachable" } as const;

// A dependency fix's PR: the advisory, whether the service's code reaches
// the package, the bump, and the install-based proof. `lockfile` says
// whether the PR's commit carries the regenerated lockfile (openPullRequest
// regenerates it when it can).
function dependencyPullRequestText(incident: Incident, lockfile?: "regenerated" | "failed"): { title: string; body: string } {
  const { report, fix, validation, dependency: advisory } = incident;
  const bump = fix!.bump!;
  const id = advisory?.advisoryId ?? "the advisory";
  const title = `fix(deps): bump ${bump.package} to ${bump.to} (${id})`.slice(0, 120);
  const runs = validation ?? [];
  const offline = runs.some((r) => r.label === "Install (lockfile only)");
  const exposure = report?.exposure;
  const chains = (advisory?.paths ?? []).slice(0, 5).map((p) => `  - \`${p}\``);
  const how =
    bump.kind === "direct"
      ? `**Direct dependency.** \`${bump.package}\` is the service's own dependency, so its range in \`package.json\` is raised to take ${bump.to}.`
      : `**Override.** \`${bump.package}\` only comes in through other packages, so a pnpm override in the workspace root's \`pnpm-workspace.yaml\` moves the vulnerable copies to ${bump.to} (pnpm reads overrides only there). Keyed on the vulnerable range, it leaves the copies that are already safe alone.`;
  const lock =
    lockfile === "regenerated"
      ? "`pnpm-lock.yaml` was regenerated for this change with `pnpm install --lockfile-only`."
      : "`pnpm-lock.yaml` is not in this PR: run `pnpm install` on the branch to regenerate it (a frozen-lockfile install in CI fails until it is committed).";
  const major = bump.major
    ? `
> [!WARNING]
> **This crosses a major version** (${bump.from} to ${bump.to}). The sandbox installed it, typechecked the app and ran its tests, but read the package's changelog for breaking changes the tests don't cover.
`
    : "";
  const proof = offline
    ? `The sandbox couldn't reach the registry, so nothing was installed: the lockfile was resolved from pnpm's cache with the bump, and \`pnpm audit\` no longer lists ${id} there. **Typecheck and tests did not run.**`
    : `In a sandbox copy of the service with its own install: \`pnpm audit\` lists ${id} before the bump and not after it, \`pnpm install\` succeeds with the bump, the app typechecks against the installed versions, and its tests pass.`;
  const body = `${fix!.summary}
${major}
## Advisory

- **[${id}](${advisory?.url ?? ""})**${advisory?.title ? `: ${advisory.title}` : ""}
- Severity: ${advisory?.severity ?? "unknown"}${advisory?.cwe.length ? ` · ${advisory.cwe.join(", ")}` : ""}
- Package: \`${bump.package}\` ${advisory?.versions.join(", ") ?? bump.from} (vulnerable: \`${advisory?.vulnerable || "unknown"}\`, patched: \`${advisory?.patched ?? "none"}\`)
${chains.length ? `- Pulled in by:\n${chains.join("\n")}` : ""}

## Exposure

${exposure ? `**${exposureLabels[exposure.verdict]}.** ${exposure.rationale.text}` : "No exposure verdict was recorded."}

## The bump

${how}

- ${bump.from} to ${bump.to}${bump.major ? " (major)" : ""}
- ${lock}

## Proof

${proof}

| Run | Command | Exit code | Tests |
| --- | --- | --- | --- |
${proofTable(validation)}

Risk: ${fix!.risk}. Approved in Triage (incident \`${incident.id}\`). Opened as a draft: nothing is deployed until it is marked ready and merged. Once it is merged, Triage audits again, and the incident resolves when the audit no longer finds ${id}.

---
Opened by Triage, an AI SRE.
`;
  return { title, body };
}

// `pnpm install --lockfile-only` at the worktree's copy of the workspace
// root, once the bump's patch is applied there. Only the lockfile changes;
// nothing is installed. On a failure the worktree's lockfile is put back.
async function regenerateLockfile(appDir: string, root: string, worktree: string): Promise<"regenerated" | "failed"> {
  const lock = await findLockfile(appDir);
  if (lock?.packageManager !== "pnpm") return "failed";
  const cwd = path.join(worktree, path.relative(root, lock.root));
  const r = await runPackageManager("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"], cwd, 120_000);
  if (r.exitCode !== 0 || r.timedOut) {
    console.error(`[triage] couldn't regenerate the lockfile for the PR: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`);
    await git(cwd, ["checkout", "--", "pnpm-lock.yaml"]).catch(() => undefined);
    return "failed";
  }
  return "regenerated";
}

// The PR's title and commit message, as a Conventional Commit:
// "fix(shopfront): connection pool leak in getStock". The first letter is
// lowered only on a capitalised word, so "N+1 queries" or "DB pool" keep
// theirs. The dependency PR's "fix(deps): …" is made on its own.
export function conventionalTitle(service: string, subject: string): string {
  const s = subject.trim().replace(/\.$/, "");
  const lowered = /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  return `fix(${service}): ${lowered}`.slice(0, 120);
}

// What the PR says: the diagnosis, the change, and the sandbox proof, so a
// reviewer can judge it without opening Triage.
export function pullRequestText(incident: Incident, opts: { lockfile?: "regenerated" | "failed" } = {}): { title: string; body: string } {
  const { report, fix, validation } = incident;
  if (!report || !fix) throw new Error("no proven fix to open a PR for");
  if (fix.bump) return dependencyPullRequestText(incident, opts.lockfile);
  const verdict = report.verdict;
  const cause = verdict.kind === "root_cause" ? report.hypotheses.find((h) => h.id === verdict.hypothesisId) : undefined;
  const title = conventionalTitle(incident.service, cause?.title ?? incident.title);
  const runs = proofTable(validation);
  // A data change the sandbox couldn't prove gets a warning and a checklist
  // at the top, where a reviewer reads first.
  const data = dataChangeOf(fix);
  const unproven = data.unproven.map((f) => `\`${f}\``).join(", ");
  const dataSection = data.detected
    ? `
> [!WARNING]
> **This fix changes stored data.** The sandbox ran the tests against a throwaway copy of the database and never ran the fix's migrations, so the data change was not proven there${unproven ? ` (${unproven} never ran)` : ""}.

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

// The branch the PR is opened against, when the incident itself says: a
// rolled-back release's branch, since the fix was proven against that
// release's code and belongs on it, not on the default branch the release
// hasn't reached. Undefined otherwise, for the remote's default branch.
export function pullRequestBase(incident: Incident): string | undefined {
  const m = incident.mitigation;
  return m?.kind === "rollback" && m.branch ? m.branch : undefined;
}

// A patch whose paths are relative to the app, with any file outside it
// ("../../pnpm-workspace.yaml", a dependency override at the workspace
// root) among them, rewritten relative to the repository root: git apply
// refuses ".." in a path, so such a patch is applied from the root instead
// of with --directory. Undefined when every file is inside the app.
export function repoRootPatch(patch: string, prefix: string): string | undefined {
  const header = /^(--- a\/|\+\+\+ b\/)(.+?)(\r?)$/;
  const lines = patch.split("\n");
  if (!lines.some((l) => header.exec(l)?.[2].startsWith("../"))) return undefined;
  return lines
    .map((l) => {
      const m = header.exec(l);
      if (!m) return l;
      const file = path.posix.normalize(path.posix.join(prefix, m[2]));
      if (file.startsWith("../")) throw new Error(`${m[2]} is outside the repository`);
      return `${m[1]}${file}${m[3]}`;
    })
    .join("\n");
}

export async function openPullRequest(incident: Incident, target: PullRequestTarget): Promise<string> {
  if (!incident.fix) throw new Error("no proven fix to open a PR for");
  const { title } = pullRequestText(incident);

  let root: string;
  try {
    root = await git(target.appDir, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("the app isn't in a git repository yet, so there's nowhere to open a PR");
  }
  // Where the app sits in the repo, e.g. "apps/shopfront", so the patch's
  // app-relative paths land in the right place.
  const prefix = (await git(target.appDir, ["rev-parse", "--show-prefix"])).replace(/\/$/, "");

  // The release branch when the fix is for a rolled-back release, or, for a
  // dependency bump, the deployed release that brought the package in
  // (main doesn't have it then); else the remote's default branch (or
  // TRIAGE_PR_BASE), freshly fetched.
  let base =
    pullRequestBase(incident) ??
    (incident.fix.bump ? await dependencyPrBase(incident, target.appDir, target.release) : undefined) ??
    process.env.TRIAGE_PR_BASE ??
    "";
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
    const fromRoot = repoRootPatch(incident.fix.patch, prefix);
    const apply = async (patch: string) => {
      await writeFile(patchFile, `${patch}\n`);
      await git(dir, ["apply", "-p1", ...(prefix && !fromRoot ? [`--directory=${prefix}`] : []), patchFile]);
    };
    const original = fromRoot ?? incident.fix.patch;
    try {
      await apply(original);
    } catch (err) {
      // A fix proven in a checkout made with core.autocrlf=true diffs CRLF
      // files, while this worktree has the repository's LF ones: try again
      // with the line endings the base branch has.
      const lf = original.replace(/\r\n/g, "\n");
      const retried = lf !== original && (await apply(lf).then(() => true, () => false));
      if (!retried) {
        throw new Error(`the patch no longer applies to ${base}; the code changed since the fix was proven (${why(err)})`);
      }
    }
    // A bump's lockfile, regenerated in the worktree so the PR installs with
    // a frozen lockfile; without it the PR says to run pnpm install.
    const lockfile = incident.fix.bump ? await regenerateLockfile(target.appDir, root, dir) : undefined;
    const { body } = pullRequestText(incident, { lockfile });
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
