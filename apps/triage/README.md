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

PRs are drafts so they can't be merged by accident. Don't merge them into the main branch: that removes the planted bug, and the commit message would put the answer in the history Triage reads.

