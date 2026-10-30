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
- **Reopening:** a breach on a rule whose incident was resolved (or whose verification breached) in the last 30 minutes reopens that incident instead of opening a new one; see Verify.

## Endpoint checks

Beside the traffic rules, Watch can check public URLs from the outside, so a site with no SDK, logs or telemetry connected still gets an incident when it goes down or slow. `src/lib/investigation/uptime.ts` runs with the watch (the sidebar's pause and `TRIAGE_WATCH=0` cover both); the pieces are under `src/lib/investigation/uptime/`.

- **A check:** a name, a URL (`http:` or `https:` only, no userinfo), optionally a header to send for an endpoint behind a token (its name, `Authorization` by default, and a secret value), how often (10 to 300 s, default 30), the slow limit (default 10 s), the timeout (default 15 s), the status range that counts as a good answer (default 200 to 299), how many slow checks in a row open an incident (default 3), how long with no good answer opens one (1 to 30 min, default 5), and how many healthy checks in a row confirm recovery (2 to 10, default 3). Up to 5 checks, saved in `.data/uptime-checks.json`; each check's last 500 results are in `.data/uptime/<id>.json`.
- **A result:** a GET timed to the response headers (the body is never read), with redirects followed by hand up to 5 hops. The outcome is `ok` (a status in range within the slow limit), `slow` (in range, past it) or `down` (a timeout, a DNS, TLS or connection failure, a status out of range, too many redirects, or a hop the guard refused). A timeout counts as down, never as slow.
- **Two rules per check:** Slow trips when the last N results are all slow and opens a sev3 incident ("Slow responses from www.example.com"); Down trips when the newest result is down and the unbroken run of down results has lasted the whole window, and opens a sev2 incident ("www.example.com is not responding", or "www.example.com is rejecting the check's credentials" when every result of the run was a 401 or 403). Down wins when both trip. The rule is on the incident as `trigger.rule` (`uptime:<checkId>:slow` or `:down`, described as "3 checks in a row slower than 10 s on …" or "no acceptable response for 5 min from …"), the URL as `trigger.route`. Slow charts the check's response time against the slow limit; Down charts availability per minute (the share of checks that were ok) against 100 %, so the chart shows the drop.
- **One incident per episode:** later failing checks only count on the open incident (`incident.uptime`: the check, the rule, `failedChecks`, `lastFailedAt`, written at most once a minute), shown on the page's Endpoint check card. A Slow episode whose endpoint then stops answering for the whole Down window becomes the Down incident: the same incident is retitled, raised to sev2 and charted as availability, with the Down rule on it. A trip within 30 min of the incident being resolved reopens it, as the traffic rules do. At startup the loop finds the open uptime incidents again, so a restart in mid-outage opens nothing new. Pointing a check at another URL starts it over: its results are dropped and an incident open on the old target stays for a person to close.
- **What it investigates:** a `TelemetrySource` over the check's own results (`uptime/source.ts`): `uptime.response_time{check=…}` and `uptime.availability{check=…}` as metrics, the failures grouped by error as error logs, one span per check, and nothing else, with each empty tool saying the endpoint is external. The prompt tells the model so and that an `inconclusive` verdict naming what is missing (application logs, traces, a deploy history) is the right answer when the results alone cannot say why; no fix stage runs. When the check's origin is `SHOPFRONT_URL` (default `http://localhost:3001`), the live source joins in: Shopfront's telemetry, database, code and deploys plus the check results, and the whole pipeline runs (mitigation, fix, PR) from an incident the check opened. `run.source` is `uptime:<checkId>`, so Ask Triage can read the saved results again.
- **Recovery:** confirmed by the checks, never assumed. Once the check has answered in time the configured number of times in a row, the incident is resolved with a `verification` of `after: "uptime"` (its series the healthy checks, in the incident's own metric) and the resolution is notified. It waits while the investigation is still running (recording `uptime.recoveredAt`, then resolving on a later tick) and while a mitigation's own verification is watching; a run that failed does not hold it up. The verification card reads "N healthy checks" rather than a quiet window.
- **Notifications:** the same `notify` as the traffic rules, so the Slack preferences and the once-per-event log apply: opened, reopened and resolved. The resolved line reads "Triage confirmed it: 3 checks in a row answered in time."
- **Credentials:** the header's value never leaves the server. The routes return a check with the header's name alone; a save that comes back without the value keeps the saved one, as long as the check still targets the same origin (pointing it at another host asks for that host's token); the probe sends the header to the check's own origin only, never along a redirect elsewhere. A 401 or 403 is recorded as `HTTP 401: credentials rejected` / `HTTP 403: forbidden`.
- **Safety:** the guard (`uptime/guard.ts`) runs before every request and every redirect hop. It refuses anything but http and https, userinfo in the URL, and any hostname that is, or resolves to (every address of the lookup), a loopback, private, carrier-grade NAT, link-local, unique-local, multicast, unspecified or reserved address, IPv4-mapped IPv6 included; a save with such a URL answers 400 with the reason. `TRIAGE_UPTIME_ALLOW_PRIVATE=1` lets loopback and private targets through outside production, for a local demo on Shopfront; link-local stays refused (it is where cloud metadata services answer). Best-effort: `fetch` resolves the name again when it connects, so a DNS answer that changes in between is not caught. At most 5 checks and one request in flight per check keep the load bounded.
- **Routes:** `GET`/`PUT /api/watch/endpoints` read and replace the list (`PUT` runs the guard on every URL, answers 400 naming the check and the reason, and drops a removed check's results); `GET /api/watch/endpoints/<id>` returns the check, its live state and its last 50 results; `POST /api/watch/endpoints/<id>/check` runs it now and returns the result (404 unknown, 409 while one is in flight). `GET /api/watch` carries every check's state as `endpoints` (status `healthy`, `slow`, `unavailable`, `unchecked`, `alerting` while its incident is open, or `paused`; the summary, streaks and the open incident's id).
- **UI:** the Watch page's **Endpoints** section lists the checks with their status, last result and a strip of the last 20 results; **New endpoint**, and each check's page with its configuration in words, a response-time chart, the last 50 results, **Check now**, **Edit** and **Delete**. The sidebar row uses its second line for a check in trouble ("Google · slow, check 2 of 3", "Google · down 3 of 5 min") and lists the checks in its tooltip. An uptime incident's Overview shows the Endpoint check card: the URL, the rule in words, failing checks so far or the recovery time, and a link to the check.
- **By hand:** `pnpm --filter @triage/web check:uptime google|shopfront` opens an uptime incident and investigates it without the loop: fabricated outages on a Google check (expect `inconclusive`), or real probes of Shopfront's health during the planted fault (expect a root cause). It needs `MODEL_API_KEY`.

## Verify

After the mitigation's recovery, `src/lib/investigation/verify.ts` checks that the fix worked: it keeps reading the alert's metric for a quiet window and resolves the incident, or reopens it when the metric climbs back. Nothing else sets `resolved` but this loop and a person.

- **The window:** `RESOLVE_AFTER_MINUTES` completed minutes under the alert's threshold after the recovery, 5 by default (`TRIAGE_RESOLVE_AFTER_MINUTES` in `.env.local` to change it). On a live run it reads the metric every 15 s over the last 10 min, as the recovery watch does, and counts the minutes that start after the recovery; a minute with no requests neither counts nor breaks the window. It gives up after the window plus 10 min and records the verification as `stopped` with a note. A scenario replay or bundled example has no live metric: it replays the recorded recovery's later points, padded with a quiet value to fill the window, one minute every 15 s, so the loop is visible but short.
- **What resolves:** every minute in the window under the threshold. The incident gets `status: "resolved"` and `resolvedAt` (the last quiet minute), `verification.status` is `resolved`, the header badge reads Resolved, and the Overview chart shows the recovery, the window and a resolved marker. While it runs, the header reads Verifying (its tooltip counts the quiet minutes) and the mitigation card says "Verifying: 1 of 5 min under the limit".
- **What reopens:** the first completed minute at or over the threshold. `verification` ends `breached` with the minute (`breachedAt`) and its value (`breachValue`), a reopening by `verification` is added to `incident.reopenings`, and the status goes back to `awaiting_approval` if a fix approval is pending, else `diagnosed`. The mitigation card says "Back over the limit at 02:17 (… 3022 ms): reopened" and offers Verify again. A reopened incident keeps its report, mitigation and fix, isn't investigated again and doesn't re-apply the mitigation; the header shows Reopened, the chart a reopened marker, and the Overview a notice with who reopened it, when, why and whether the fix still waits for approval.
- **The watch reopens:** once an incident is resolved the watch has re-armed, so a new breach on the same rule and route within 30 min of `resolvedAt` (or of the verification's `breachedAt`) reopens that incident instead of opening a second one (`reopen.ts`, `REOPEN_WINDOW_MINUTES`): a reopening by `watch`, `lastOpened.reopened` on `GET /api/watch`, and a "Reopened <title>" toast. The route is `trigger.route` (older incidents: the end of the title). An incident whose recovery or verification is still being watched counts too: the breach joins it, and the verification records it. Past 30 min a new incident opens as before.
- **After a merged PR:** while the fix's draft PR is open and the incident isn't resolved, loading the incident page checks it with `gh pr view <url> --json state,mergedAt` at most once a minute per incident (`fix/pr-merge.ts`, no background polling; each outcome is logged once as `[triage] PR check on <id>: …`). A merged PR saves `approval.prMergedAt` and starts a verification from the merge time. The demo never merges Triage's PRs, so this path rarely runs.
- **A pending fix approval survives resolution:** Resolved means the alert is verified gone, not that the fix shipped. Approve and Deny stay offered, the incident stays under Needs attention (and in the bell filter) while the approval is pending, and deciding it keeps the status resolved.
- **By hand:** the header's "More actions" menu offers Mark resolved (any finished incident not yet resolved), Reopen (a resolved one; a dialog with an optional note) and Verify again (when there is no verification yet, or the last one breached or stopped); the command palette has the same as "Mark resolved", "Reopen incident" and "Verify again". They call `POST /api/incidents/<id>/resolution` with `{ "action": "resolve" | "reopen" | "verify", "note"?: "…" }` (note up to 300 characters). `resolve` returns `{ status, resolvedAt }`, `reopen` `{ status }`, `verify` 202 and runs a fresh window from now after the response (not from the last recovery, so a breach since then doesn't end it at once). It answers 400 on a bad body, 404 on an unknown incident and 409 when the action makes no sense: resolving a resolved incident or one with no report yet, reopening one that isn't resolved, verifying while a verification runs or before the report.
- **Restarts:** at startup a verification a restart cut off is marked `stopped` ("Triage restarted before the verification finished") and the mitigation card offers Verify again; a recovery watch cut off is marked `not_recovered` with the same kind of note ("Recovery watch stopped" on the card) instead of spinning forever.
- **Postmortem:** the header says resolved with the time, the timeline adds the verification, each reopening and the resolution, and the durations add Time to resolve (first breach to `resolvedAt`). A postmortem written before the incident resolved shows "Written before the incident resolved" beside Write again.

## Ask Triage

Once an incident has a report, its **Ask** section (also "Ask Triage" in the command palette) takes follow-up questions such as "Why was the cache ruled out?" or "Show me the slowest request", with suggestions built from the report.

- **What it answers from:** the incident (alert, verdict, leading and ruled-out hypotheses, mitigation and fix state), its recorded evidence and the last 6 questions and answers. When the run's telemetry can be read again (`source-for.ts`: a recorded scenario, or the live Shopfront anchored at the alert), the agent also has the investigation's read-only tools, and their results become the question's own evidence (`ev_q<n>_…`). Every claim cites an evidence ID; cited IDs that don't exist are listed on `unknownIds` and struck in the answer instead of shown as chips.
- **Evidence-only mode:** a bundled example (or any incident whose run can't be rebuilt) answers from the recorded evidence alone, with no tools (`mode: "evidence_only"`). The first question on a bundled example saves a copy of it to `.data/`.
- **Model:** the **Ask** stage in Settings → Models (`src/lib/investigation/ask/agent.ts`). Until it is changed it uses the Investigate stage's model.
- **Streaming:** `POST /api/incidents/<id>/questions` with `{ "text": "…" }` returns a UI message stream over SSE (header `x-question-id`), so the asking tab shows tool calls and the answer token by token. The same deltas are saved to `incident.questions` at most every 300 ms, and the stream is consumed to the end even if the tab closes: a reload or another tab shows the answer growing, and closing the tab mid-answer still leaves a complete answer.
- **Read aloud:** the speaker button under each answer reads it with the browser's own voices (the Web Speech API: no server, no key, nothing leaves the browser). Citations and markdown marks are dropped before reading, so the voice says the prose, not `[ev_…]`. One answer plays at a time across the app: pressing another speaker, or the same one again, stops it. The voice and speed are chosen in Settings → Speech (per browser, saved in `localStorage`, with a preview); the button is hidden in a browser without speech synthesis.
- **Limits:** one question answering per incident at a time (a second gets 409), 500 characters per question, 10 model steps per answer with one nudge if it stops without text, and the request's 120 s limit. Every tool is read-only; an answer can point at the mitigation or fix cards but never acts.

## Postmortem

Once an incident has a finished report that isn't healthy, its **Postmortem** section (also "Write the postmortem", "Go to Postmortem" and "Copy postmortem" in the command palette) writes a blameless postmortem from the incident's record on request. It shows on the page as the document it exports, with **Copy Markdown** and **Download** (`postmortem-<incident>.md`); the Overview links to it once it's written.

- **What the model writes:** with the default template, a summary, one impact sentence, 2 to 5 contributing factors, what went well and what didn't, where we got lucky, and action items (each a kind: fix this, prevent the class, detect sooner, mitigate faster; and a priority). Every claim cites evidence IDs from the incident; cited IDs that don't exist reject the submission.
- **What the renderer adds from the record:** `postmortemMarkdown(incident)` (`postmortem/render.ts`, no model) builds the header (service, severity, status, when it was detected and written), the impact numbers from the alert's series (peak, time over the threshold, baseline), the timeline from the incident's own timestamps (threshold crossed, alert, investigation, verdict, mitigation proposed, approved, applied and recovered, fix attempts, approval and PR) with time to detect, diagnose, mitigate and recover, the fix as action item 1 with the PR link, and an Evidence appendix of the cited items. Citations are numbered as the page's evidence chips, so `[3]` in the export is chip 3 on the page.
- **Template:** which sections a postmortem has, and in what order, is a template: the seven built-in sections (summary, impact, timeline, contributing factors, what went well, where we got lucky, action items) reordered or removed, plus custom ones, each a name and instructions, up to 20 sections in all. One template for the whole app, edited in **Settings → Postmortems** (add built-ins back, add and edit custom sections, **Restore defaults**) and saved as `postmortemTemplate` in `.data/settings.json`; `GET`/`PUT`/`DELETE /api/settings/postmortem` read, replace and reset it (a bad template answers 400 with the problems). The header and the Evidence appendix are fixed. The model writes only the sections the template keeps (the tool's schema is built from it) and fills a custom section from the record, saying so when the record is silent; custom sections are cited and checked for blame like the rest. Each postmortem keeps a snapshot of the template it was written with (`postmortem.template`, its custom sections in `postmortem.custom`), so changing the template reshapes only the next write, never an older document; one written before templates existed renders as the default.
- **Checks:** `postmortem/rules.ts` (custom sections included) turns back a submission that names a commit author or an approver, uses blaming phrases ("blame", "fault of", "should have", "failed to", "careless", "negligent"), cites evidence in the summary, or repeats the fix as an action item. A rejected submission goes back to the model with the reasons, within 3 model steps (one nudge if it stops without submitting); if none is accepted the postmortem is marked failed with the reasons and the section offers Write again.
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

