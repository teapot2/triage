<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Forms

These are the defaults Triage's forms have settled on. They're recommendations, not rules. Start from them, and depart when a form's job is better served by something else. A new pattern that reads better is welcome; leave a comment saying why, so the next form can borrow it. When in doubt, lean toward usability first and as little on screen as does the job.

### Building blocks

Full-page forms are built from `@/components/form-fields`. [endpoint-form.tsx](src/components/watch/endpoint-form.tsx) and [rule-form.tsx](src/components/watch/rule-form.tsx) show them in use.

- `FormSection`: a short title over a bordered two-column grid.
- `FormRows` and `FormRow`: one row per repeated thing, with the same columns in each.
- `FormAdvanced`: rarely changed fields, closed, with their values on one line.
- `FormField`: a label, the control, then a hint or the error in the hint's place. `info` puts an `InfoTip` beside the label instead: an info icon with a popover, for what a field means when the reader needs it once rather than on every visit.
- `NumberInput`: a number with its unit inside the field.

Settings edits in place instead, with `DisclosureRow` from [settings-list.tsx](src/components/settings-list.tsx).

A section's own settings on another page (the Watch page's dependency audit, say) can go in a dialog instead, opened from a Settings button in the section's header. That suits settings that are rarely changed, set once, and sit beside content the page is really for: a settings row inside a list reads as one of its items and takes the space the list needs. Keep what they're set to readable without opening anything, in the section's summary line ("every 6 h · next in 5 h"), so the dialog is only for changing them. The dialog follows the Footer rule below: Cancel and one primary verb.

### Layout

- **Order by what only the person can supply.** The thing being created (a URL, a route) tends to come first and full width. Fields with good defaults follow, and what rarely changes usually reads best folded under `FormAdvanced`, with its current values in the summary.
- **A few short sections.** Titles work well as nouns or short phrases ("Endpoint", "Condition", "Opens an incident"). Group by what the person is deciding, not by how the data is stored.
- **Pair fields that belong together.** Two columns suit a pair, like a threshold and how long it has to last. Unrelated fields side by side make the eye zigzag.
- **Repeated things as rows.** When several things share the same fields (one rule per row, say), `FormRows` lines up their columns and saves repeating labels. Detail like severity fits beside the row's title better than in a hint.

### Words

- **Let the label and the unit carry the meaning.** Units sit inside `NumberInput`, and labels can read on into them ("For [3] checks in a row").
- **Hints only when the label can't carry it.** Syntax (a trailing `*`) or a consequence that isn't obvious is worth a hint. Restating the label isn't.
- **Read the result back.** The page header can say in one sentence what the form will do, from the first render. When a value is still missing, a stand-in ("the URL") beats an empty line.

### Behaviour

- **Defaults that work, and derive what you can.** A new form ought to be savable after filling in only what's unique to it. A value worked out from another (a name from the URL's host) can show as the placeholder, so leaving the field blank is visibly fine.
- **Pick lists for a few sensible choices.** Intervals and windows tend to be clearer as a `Select`. Free entry suits true numbers.
- **Errors after the first Save.** Show each error in its field's place, saying what's wrong and the allowed range. If it's inside Advanced, open Advanced.
- **On/off state lives on the object's page.** Pause and resume work best as a deliberate button there, and an edit leaves that state as the server has it.
- **Footer.** Cancel (ghost) and one primary verb ("Create endpoint", "Save changes"), with Delete on the left when editing. Cancel with unsaved changes asks first, and so does leaving the page.

## Exports

Anything a page shows can usually be offered as a download through `src/lib/export/` (see the README's Exports section).

- **A new export is a dataset and an entry.** Define the columns once in `src/lib/export/datasets/` with `defineDataset` (browser-safe: no server imports). For stored data, append a `defineExport({ dataset, params, load })` to `src/lib/export/exports.ts`; for data only the page has, pass `rows` instead. Then put `<ExportMenu exports={[...]} />` where that data is shown.
- **Columns are the allowlist.** Name each one in snake_case with its unit (`response_ms`), and never add one for a secret. A full-record JSON (`json`) is a deliberate choice, made only where the record holds no secrets.
- **Don't offer an empty file.** Leave a dataset out of the menu when it has no rows; the route answers 404 for it anyway.

## Running the dependency advisory flow

The end-to-end check for dependency advisories (README: Dependency advisories): a planted Shopfront release adds a vulnerable package, Triage's audit finds it, the exposure stage and the Fix stage run, a person approves, the PR merges, and the next audit resolves the incident. Commands run from the repo root in Git Bash unless a section says otherwise; ports are Triage 3000 and Shopfront 3001 (`.claude/launch.json` has both servers).

### Before you start

- Postgres and the collector up (`pnpm infra:up`), Shopfront and Triage dev servers running, the watch on (the sidebar says "Watching shopfront").
- A model for the investigate stage (`MODEL_API_KEY` in `.env.local`), registry access (the deploy and the sandbox both install), and `gh` signed in for the PR.
- No release deployed and no flag on in Shopfront's `/ops`: one fault at a time.
- After editing Triage's server code, restart its dev server before a run. Hot reload can leave old copies of a module loaded beside the new one (seen with `dependencies/audit.ts`: the audit kept failing with `spawn pnpm ENOENT` from a stale chunk).

### The run

1. **Cut the release** (no-op if `main` hasn't moved): `pnpm --filter @triage/shopfront release vulnerable-dep`. It is one commit on `shopfront-release/vulnerable-dep` adding `semver` 7.5.1 (GHSA-c2qf-rxjj-qqgw, high) used by `src/lib/runtime.ts` for `/api/health`.
2. **Deploy it**: "Vulnerable dependency" on Shopfront's `/ops`, or `curl -X POST -H 'content-type: application/json' -d '{"action":"deploy","name":"vulnerable-dep"}' http://localhost:3001/api/ops`. It applies `package.json` and the lockfile, runs `pnpm install --frozen-lockfile --filter @triage/shopfront`, then applies the code. `/api/health` gains a `runtime` field.
3. **Audit now** on the Watch page's Dependencies section, or `curl -X POST http://localhost:3000/api/watch/dependencies/audit`. The audit finds semver at high on a runtime dependency (over the default floor, high) and opens a sev3 incident; the moderate glob, minimatch and esbuild findings stay listed only.
4. **Wait about a minute.** The exposure stage should say Reachable, citing `src/lib/runtime.ts`; there is no mitigation; the Fix tab shows semver 7.5.1 → 7.5.2 with five runs: Audit before the bump fails, then Install, Re-audit, Typecheck and Tests pass. Status: awaiting approval.
5. **Push the release branch** before approving: the PR targets the deployed release's branch, and `openPullRequest` fetches it from origin. `git push origin refs/heads/shopfront-release/vulnerable-dep:refs/heads/shopfront-release/vulnerable-dep`.
6. **Approve** on the incident page (Approve fix, then confirm) or from Slack. Triage opens a draft PR `fix(deps): bump semver to 7.5.2 (GHSA-c2qf-rxjj-qqgw)` with the `package.json` bump and a regenerated `pnpm-lock.yaml`.
7. **Merge it**: `gh pr ready <n> && gh pr merge <n> --squash`. Then load the incident page: Triage checks the PR at most once a minute on a page load, records the merge and starts the `after: "dependencies"` verification, which audits at once. That audit still finds 7.5.1 and says so in the verification's note: merging on GitHub doesn't change the local checkout.
8. **Land the merge in the checkout**, as a deploy would:
   ```bash
   git fetch origin shopfront-release/vulnerable-dep
   git diff <merge-sha>^ <merge-sha> -- apps/shopfront pnpm-lock.yaml > /tmp/fix.patch
   git apply -C1 /tmp/fix.patch
   pnpm install --frozen-lockfile --filter @triage/shopfront
   ```
9. **Audit again** (Audit now, or Verify again on the incident, which runs the audit for a dependency incident). The audit no longer finds the advisory and the incident resolves; the header reads Resolved, No longer found, PR #n merged.

### Cleaning up

- Reverse the bump, then roll the release back (it reinstalls, removing semver): `git apply -C1 -R /tmp/fix.patch`, then Roll back on `/ops` or `curl -X POST -H 'content-type: application/json' -d '{"action":"rollback"}' http://localhost:3001/api/ops`.
- On Windows the applies leave `pnpm-lock.yaml` and `src/app/api/health/route.ts` showing as modified with CRLF line endings only. Check with `git diff --ignore-cr-at-eol --quiet -- <files>` and, when it's clean, `git checkout -- <files>`.
- Leave the local `shopfront-release/vulnerable-dep` at the vulnerable commit so the run can be repeated; origin's copy holds the merged fix.

### Without the live servers

From `apps/triage`:

- Unit and loop tests: `npx tsx --test src/lib/investigation/dependencies.test.ts src/lib/investigation/dependencies/*.test.ts`.
- The exposure stage on the recorded scenario: `pnpm benchmark --runs 20 --models spark --scenarios vulnerable-dependency` (Nov 3: 20/20 on Spark, median 15 s, $0.02 a run). The grader wants Reachable, `src/lib/runtime.ts` named or cited, and no mitigation.
- A real audit outside Next: `runAudit({ service: "shopfront", dir: path.resolve("../shopfront") })` from a tsx script in apps/triage.

### Reading the state

- `GET /api/watch/dependencies`: the loop's status, settings, findings (gone ones for a week) and the last audits, each failed one with its error.
- An incident's dependency block, exposure, fix and verification are in its JSON body in `.data/triage.db` (`SELECT body FROM incidents WHERE id = ?`).

### Gotchas

- Next's bundler folds `process.platform` and `os.platform()` into constants in the server build. Code that spawns pnpm (a `.cmd` shim on Windows) branches on `process.env.OS === "Windows_NT"` instead.
- pnpm 12 ignores `pnpm.overrides` in `package.json`. A transitive bump's override goes in the workspace's `pnpm-workspace.yaml`, keyed on the vulnerable range.
- A finding opens an incident only when it's runtime and at or over the floor (Settings document `dependency-audit`; `PATCH /api/watch/dependencies`). Lowering the floor to moderate opens real incidents on Shopfront's current tree and starts model runs.
- Running the release script for a release whose branch was cut from an older `main` moves that branch onto the current `main` (same diff, new sha).
