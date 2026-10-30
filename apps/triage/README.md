# @triage/web

Next.js 16 (App Router) app for Triage.

## Environment

From this app directory, create the local env file:

```sh
cp .env.example .env.local
```

Set `MODEL_API_KEY` (and `OPENROUTER_API_KEY` / `FIREWORKS_API_KEY` for hosted open weights) here, not at the workspace root. Each stage's provider and model is chosen in Settings → Models; see the root README. Never commit `.env.local`.

## Scripts

```sh
pnpm dev        # http://localhost:3000
pnpm build
pnpm start
pnpm lint
pnpm typecheck
pnpm check:blind    # nothing Triage can read gives the planted bug away
pnpm check:sandbox  # proves a known-good fix in the sandbox, no model calls
```

## Endpoints

- `GET /api/health` returns each stage's provider, model and any problem (`{ ok, stages }`) without calling a model.
- `GET /api/ping-model?stage=<id>` (or `?provider=<id>&model=<id>`) calls that model once and returns `{ ok, text, usage }`.
- `GET`/`PUT /api/settings/models` read and change each stage's model and the local/custom endpoints (keys are write-only). `GET /api/settings/models/list?provider=<id>` lists a provider's chat models.
- `POST /api/investigations` with `{ "scenario": "pool-leak" | "healthy" }` starts an investigation and returns `{ id }` (202). The agent runs after the response and saves progress to `.data/incidents/<id>.json` (gitignored); open `/incidents/<id>` to watch it.

## Watch (Stage 1)

`src/lib/investigation/watch.ts` starts with the server (`src/instrumentation.ts`) and watches the live store. Every 10 s it measures p95 latency and error rate on `GET /api/products/[id]` over the last minute of real requests (`routeHealth` in `live/live-source.ts`, the same measure the investigation sees).

- **Opening:** two breaching checks in a row (p95 over 500 ms or more than 5% errors, with at least 5 requests) open an incident with `openedBy: "watch"` and run the whole pipeline.
- **One incident per episode:** it opens one incident and re-arms after a minute of healthy checks.
- **UI:** the sidebar shows its state (`GET /api/watch`, polled every 5 s), toasts when it opens an incident, and pauses or resumes on click (`POST /api/watch`, in memory).
- **Off switch:** `TRIAGE_WATCH=0` keeps it off.
- **Restarts:** at startup, incidents a restart cut off mid-run are marked failed (`recover.ts`).

## Ask Triage

Once an incident has a report, its **Ask** section (also "Ask Triage" in the command palette) takes follow-up questions such as "Why was the cache ruled out?" or "Show me the slowest request", with suggestions built from the report.

- **What it answers from:** the incident (alert, verdict, leading and ruled-out hypotheses, mitigation and fix state), its recorded evidence and the last 6 questions and answers. When the run's telemetry can be read again (`source-for.ts`: a recorded scenario, or the live Shopfront anchored at the alert), the agent also has the investigation's read-only tools, and their results become the question's own evidence (`ev_q<n>_…`). Every claim cites an evidence ID; cited IDs that don't exist are listed on `unknownIds` and struck in the answer instead of shown as chips.
- **Evidence-only mode:** a bundled example (or any incident whose run can't be rebuilt) answers from the recorded evidence alone, with no tools (`mode: "evidence_only"`). The first question on a bundled example saves a copy of it to `.data/`.
- **Model:** the **Ask** stage in Settings → Models (`src/lib/investigation/ask/agent.ts`). Until it is changed it uses the Investigate stage's model.
- **Streaming:** `POST /api/incidents/<id>/questions` with `{ "text": "…" }` returns a UI message stream over SSE (header `x-question-id`), so the asking tab shows tool calls and the answer token by token. The same deltas are saved to `incident.questions` at most every 300 ms, and the stream is consumed to the end even if the tab closes: a reload or another tab shows the answer growing, and closing the tab mid-answer still leaves a complete answer.
- **Limits:** one question answering per incident at a time (a second gets 409), 500 characters per question, 10 model steps per answer with one nudge if it stops without text, and the request's 120 s limit. Every tool is read-only; an answer can point at the mitigation or fix cards but never acts.

## Postmortem

Once an incident has a finished report that isn't healthy, its **Postmortem** section (also "Write the postmortem", "Go to Postmortem" and "Copy postmortem" in the command palette) writes a blameless postmortem from the incident's record on request. It shows on the page as the document it exports, with **Copy Markdown** and **Download** (`postmortem-<incident>.md`); the Overview links to it once it's written.

- **What the model writes:** a summary, one impact sentence, 2 to 5 contributing factors, what went well and what didn't, where we got lucky, and action items (each a kind: fix this, prevent the class, detect sooner, mitigate faster; and a priority). Every claim cites evidence IDs from the incident; cited IDs that don't exist reject the submission.
- **What the renderer adds from the record:** `postmortemMarkdown(incident)` (`postmortem/render.ts`, no model) builds the header (service, severity, status, when it was detected and written), the impact numbers from the alert's series (peak, time over the threshold, baseline), the timeline from the incident's own timestamps (threshold crossed, alert, investigation, verdict, mitigation proposed, approved, applied and recovered, fix attempts, approval and PR) with time to detect, diagnose, mitigate and recover, the fix as action item 1 with the PR link, and an Evidence appendix of the cited items. Citations are numbered as the page's evidence chips, so `[3]` in the export is chip 3 on the page.
- **Checks:** `postmortem/rules.ts` turns back a submission that names a commit author or an approver, uses blaming phrases ("blame", "fault of", "should have", "failed to", "careless", "negligent"), cites evidence in the summary, or repeats the fix as an action item. A rejected submission goes back to the model with the reasons, within 3 model steps (one nudge if it stops without submitting); if none is accepted the postmortem is marked failed with the reasons and the section offers Write again.
- **Route:** `POST /api/incidents/<id>/postmortem` returns 202 and writes after the response, saving the record as `incident.postmortem` (status `writing`, then `ready` or `failed`). It answers 409 while the incident is investigating, on a healthy run, while a postmortem is already being written, while the fix stage or a mitigation runs, and when the Postmortem stage has no usable model. The first write on a bundled example saves a copy of it to `.data/`.
- **Model:** the **Postmortem** stage in Settings → Models (`postmortem/writer.ts`). Until it is changed it uses the Ask stage's model (so Investigate's, when Ask has none either).
- **Limits:** one postmortem per incident; writing again replaces it as soon as it starts. The model has no tools: it reads the record and its evidence only. The export's Owner and Due columns are blank for the team to fill in, and the document ends as a draft until the team has read it.

## Investigation agent

`src/lib/investigation/` holds Stage 2: a `ToolLoopAgent` on the Investigate stage's model (Settings → Models) with seven telemetry tools and a `submit_report` tool. Reports are validated (schema, `reportProblems`, unknown evidence IDs, every service queried); rejections go back to the model to fix. Tools read from a `TelemetrySource`; today that is a recorded scenario in `scenarios/`, and the live telemetry store will implement the same interface.

## Fix and proof (Stages 3 and 4)

`src/lib/investigation/fix/` runs after a live run's root-cause verdict. The model reads the code and submits exact edits plus a new vitest regression test (`submit_fix`). `prove.ts` checks them in a throwaway copy of Shopfront under the OS temp dir (`fix/sandbox.ts`; node_modules linked, never the app itself). Three checks:

1. The test runs against the current code and must fail on an assertion.
2. The edits are applied and the test must pass.
3. The patched app must typecheck.

A failed proof goes back to the model with the reasons (up to 4 submissions), and each rejection is kept on `fixRun.rejections`. A proven fix is saved as `fix` (with a git-style diff) and `validation` (each run's command, exit code and output), and the incident moves to `awaiting_approval`. Recorded scenarios stop at the diagnosis: they have no code to run.

## Pull request (Stage 5)

Approving a proven fix opens a draft PR (`fix/pull-request.ts`, run after the approval response):

1. Make a temporary git worktree on a new `triage/<incident>` branch, cut from the remote's default branch (or `TRIAGE_PR_BASE`).
2. Apply the proven patch under the app's folder, commit, and push to `origin`.
3. Run `gh pr create --draft` with the diagnosis and sandbox proof as the description.

The checkout you work in is never touched, and nothing merges by itself. The incident shows the PR's progress, its link, or why it failed with a Retry (`POST /api/incidents/<id>/pull-request`). Only fixes Triage proved get a PR; approving a bundled example only records the decision.

**Deny with feedback.** Deny opens a dialog with one optional field, "What should Triage do differently?" (up to 500 characters). Empty, it denies as before. With text, the feedback is saved as the approval's reason and, when the fix was proven on the live Shopfront, the button reads "Deny and try again": the denied attempt (fix, proof, run and approval) is archived on `incident.fixAttempts`, the incident goes back to diagnosed, and the fix stage runs again (`fix/rerun.ts`) with every denied attempt's feedback and patch in its prompt (`fix/feedback.ts`). `submit_fix` turns back a patch that repeats a denied one (byte-equal, or the same code hunks ignoring the test file) before the sandbox, without spending a submission. A proven rerun arrives as "Attempt 2", awaiting approval as usual; the Fix section lists earlier attempts with their feedback, proof and diff. On a bundled example or a recorded scenario the feedback is recorded and the dialog says no new attempt follows.

PRs are drafts so they can't be merged by accident. Don't merge them into the main branch: that removes the planted bug, and the commit message would put the answer in the history Triage reads.

