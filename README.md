# Triage

AI SRE for teams with no SRE. Built for the Meta Global AI Developer Hackathon on the Meta Model API (Muse Spark, and Muse Voice Transcribe for voice input).

## What it does

- **Watches** a service three ways: traffic rules and SLO burn-rate alerts on its telemetry, checks on public URLs from the outside, and a regular audit of its dependencies. Each outage opens one incident, with a toast and a Slack message.
- **Investigates** with a tool-calling agent over the service's logs, traces, metrics, database statistics, deploy history, git history and source. Every claim in the report cites the evidence behind it, and a report citing evidence that doesn't exist goes back to the model.
- **Mitigates first:** proposes one reversible step from what the diagnosis cites (turn a flag off, roll a release back), applies it once a person approves, and watches the metric recover.
- **Verifies** that the recovery holds for a quiet window before resolving the incident, and reopens it when it doesn't.
- **Proves a fix** in a sandbox: a regression test that fails on the current code and passes with the patch, plus a typecheck. Once a person approves it, Triage opens a draft pull request.
- **Answers follow-up questions** about the incident (typed, spoken or with a screenshot), **writes the blameless postmortem**, and serves all of it to coding agents over MCP.

## How well it diagnoses

Each recorded scenario replays a real run's telemetry with one planted cause; the grader checks the report against ground truth the agent never sees. Latest runs on Muse Spark, single agent:

| Scenario | What's planted | Root cause found |
| --- | --- | --- |
| `pool-leak` | A connection leak behind a feature flag | 9 / 10 |
| `price-gap` | Missing price rows behind a feature flag | 8 / 10 |
| `live-ratings` | An N+1 query loop behind a feature flag | 10 / 10 |
| `bad-deploy` | A release that breaks an API route; the right step is a rollback | 20 / 20 |
| `traffic-rush` | A harmless release, then a traffic rush; the right answer is the load, with no rollback | 20 / 20 |
| `vulnerable-dependency` | A vulnerable package; is it reachable from the code? | 20 / 20 |
| `healthy` | Nothing (control) | no false positives |

`pnpm --filter @triage/web benchmark` reruns them; see "Benchmark" in `apps/triage/README.md`.

## Layout

- `apps/triage` — the Triage web app and agent (Next.js, Vercel AI SDK, Meta Model API).
- `apps/shopfront` — the instrumented demo target app (Next.js, Postgres, OpenTelemetry).
- `infra` — Postgres and OpenTelemetry Collector via Docker Compose.

## Setup

You need Node 24 or later, pnpm 12 (`npm install -g pnpm@12`), Docker (Postgres and the OpenTelemetry Collector run in it) and a [Meta Model API](https://dev.meta.ai/products/meta-model-api) key. Git and the GitHub CLI (`gh`) are used when an approved fix opens a pull request.

```bash
git clone https://github.com/teapot2/triage.git
cd triage
cp apps/triage/.env.example apps/triage/.env.local   # fill MODEL_API_KEY here
cp apps/shopfront/.env.example apps/shopfront/.env
pnpm install
pnpm infra:up                                    # Postgres on 5433, collector on 4317/4318
pnpm --filter @triage/shopfront db:migrate
pnpm --filter @triage/shopfront db:seed          # about 15 s; safe to run again
pnpm dev
```

Triage runs on http://localhost:3000, Shopfront on http://localhost:3001. `pnpm infra:down` stops the containers.

Each app owns its env file; commit only `.env.example` templates. Infrastructure uses `infra/docker-compose.yml`, not a root `.env`.

## Try it

1. Open Triage at http://localhost:3000. The bundled example incidents can be opened before anything else runs. For a live agent run without Docker or traffic, press **Run investigation** and pick a recorded scenario: the agent investigates the replayed telemetry as it happens, and only `MODEL_API_KEY` is needed. Recorded runs stop at the diagnosis and the mitigation, since there's no code to patch.
2. Open Shopfront's demo controls at http://localhost:3001/ops and press **Start traffic**.
3. Turn on **Connection pool leak**. The pool fills in about two minutes, the watch opens an incident, and Triage investigates it live: open the incident from the toast or the list.
4. On the incident: the report cites its evidence; approve the proposed mitigation (the flag off) and watch the metric recover and the verification resolve it; the fix stage proves a patch in a sandbox before it asks for approval. Ask Triage follow-up questions and write a postmortem from the same page.
5. Turn the fault off on /ops before trying the next one: only one runs at a time. **Price list gap** and **Live ratings loop** are flags like the first. The releases deploy a commit, so cut its branch once first: `pnpm --filter @triage/shopfront release formatted-price` (or `journal-copy`, `vulnerable-dep`).
   - **Formatted price** breaks the product API on deploy; expect a rollback.
   - **Journal copy** changes nothing that matters: deploy it, then pick a faster traffic preset on the Traffic card. Triage should blame the load, not the release.
   - **Vulnerable dependency** changes nothing on the dashboards: deploy it, then press **Audit now** in the Dependencies section of Triage's Watch page.

Approving a fix pushes a branch to `origin` and opens a draft pull request with `gh`, so that step needs a clone you can push to (a fork) and `gh auth login`. Without them the incident shows why the PR failed, with a Retry, and the proven patch stays on the page.

## Endpoint checks

Watch also checks public URLs from the outside, so a site with no SDK or telemetry connected still gets an incident: three slow responses in a row, or no acceptable response for five minutes, open one incident, confirmed recovery resolves it, and Slack hears at both ends. A check on Shopfront itself investigates with Shopfront's telemetry too, so the whole pipeline runs from an outside probe; a check on anything else reports what the results show and names what is missing. Private and loopback targets are refused (`TRIAGE_UPTIME_ALLOW_PRIVATE=1` allows them in development); see `apps/triage/README.md`.

## Mitigate first

After a root-cause verdict, Triage proposes one mitigation from the evidence the diagnosis cites: turn off the cited feature flag, or roll back the cited deploy. Once a person approves it, Triage applies it through Shopfront's ops API (on in development; `OPS_ENABLED=1` in a production build; `SHOPFRONT_URL` if the store runs elsewhere) and re-reads the alert's metric until it recovers. A rollback has Shopfront's release harness reverse-apply the deployed release's diff. When the diagnosis cites a connection pool well above its usual level, as Shopfront's pool leak does, turning the flag off stops new leaks but frees none of the connections already held, so the flag-off also recycles them; other flag-offs (the price list gap, the live ratings loop) are the flag alone. The tested patch still follows as the permanent fix.

## Verify

A recovery says the metric came back; the verification checks that it stayed back. After the mitigation's recovery, Triage keeps reading the alert's metric for a quiet window (5 completed minutes under the threshold, `TRIAGE_RESOLVE_AFTER_MINUTES` to change it) and then resolves the incident on its own, with the chart showing the recovery, the window and a resolved marker. If the metric climbs back over the threshold during the window, the incident reopens and says so. Once an incident is resolved, a new breach on the same rule within 30 minutes reopens that incident instead of opening a second one for the same outage. A reopened incident keeps its report, mitigation and fix and isn't investigated again. A pending fix approval doesn't hold up the resolution: it stays pending, and the incident stays under Needs attention until someone decides it. People can also mark an incident resolved, reopen it or verify again from the header's menu or the command palette; see `apps/triage/README.md`.

## Ask Triage

After the report, a person can ask Triage follow-up questions on the incident page, with a pasted screenshot if they have one (a dashboard panel, an error page), and get an answer streamed token by token, citing evidence with clickable chips, and can deny a fix with feedback to get a new attempt; see `apps/triage/README.md`.

A **Full context** switch answers in one call to Muse Wonder with everything Triage holds on the service in the prompt (its source, git history, deploys, earlier incidents and telemetry, up to 800k tokens), and **Web search** lets the answer look up a library's public docs and cite them. The composer's model picker changes the model for one question.

Questions can also be spoken. With **Voice input** on in **Settings → General → Speech**, the composer's mic streams speech to Meta's **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`, realtime, about $0.18 per hour of audio) through Triage's server, so `MODEL_API_KEY` never reaches the browser. Each session is biased toward the incident's service, route and host names, so "shopfront" stops coming out "shop front". Answers can be read aloud with the browser's own voices.

## Postmortem

Once an incident has a finished report, Triage writes a blameless postmortem from the incident's record on request, by default with a summary, impact, timeline, how the diagnosis held up, contributing factors, what went well, where we got lucky and action items, each claim citing the evidence behind it. It shows in the incident page's **Postmortem** section and can be copied as Markdown or downloaded as Markdown or PDF, with the action items as CSV for a tracker. The sections are a template the team edits in **Settings → Postmortems**: reorder or remove the built-in ones and add its own, and the model writes only the sections the template keeps. Each postmortem keeps the template it was written with. The model is the **Postmortem** stage in Settings → Models, which uses Ask's model until it is changed; see `apps/triage/README.md`.

## Use Triage from Muse Code

Triage is an MCP server too, so Meta's Muse Code (or any MCP client) can ask it about incidents from the terminal: "summarize incident inc_pool_leak with its evidence" returns Triage's cited report, with a line per evidence item, and the agent can pull the proven patch, the evidence in full or the postmortem, or ask a follow-up question that is saved on the incident. Add it to `~/.config/muse/settings.json`:

```json
{
  "schema_version": 1,
  "mcpServers": {
    "triage": { "transport": "streamable_http", "url": "http://localhost:3000/api/mcp", "mode": "optional" }
  }
}
```

The tools only read, apart from saving a question; approvals stay on the incident page. See `apps/triage/README.md` for the tools and access.

## Models and providers

Each stage that calls a model (**Investigate**, **Fix**, **Ask** and **Postmortem**, plus **Lead** when hypotheses are checked in parallel) has its own provider and model, chosen in Triage's **Settings → Models**. Every provider is an OpenAI-compatible endpoint:

| Provider | Endpoint | Key |
| --- | --- | --- |
| Meta Model API | `https://api.meta.ai/v1` (or `MODEL_API_BASE_URL`) | `MODEL_API_KEY` |
| OpenRouter (Muse Glimmer, Muse Spark Open, Spark, Wonder) | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Fireworks | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| Baseten (Muse Spark Open) | `https://inference.baseten.co/v1` (or `BASETEN_API_BASE_URL`) | `BASETEN_API_KEY` |
| Modal (your own Muse Glimmer deployment, `infra/modal/glimmer.py`) | `MODAL_BASE_URL` | `MODAL_API_KEY` |
| LM Studio | `http://localhost:1234/v1` (editable in Settings) | optional |
| Ollama | `http://localhost:11434/v1` (editable) | optional |
| llama.cpp server | `http://localhost:8080/v1` (editable) | optional |
| Custom endpoint (vLLM, any OpenAI-compatible server) | any base URL, set in Settings | optional, saved in Settings |

Put hosted keys in `apps/triage/.env.local` and restart. Keys entered in Settings are saved server-side in `apps/triage/.data/triage.db` (gitignored) and never sent to the browser.

**Open-weights mode.** The "Glimmer" presets run every stage on Muse Glimmer (Meta's open-weights 30B model) on OpenRouter, Fireworks or a local server; Settings shows an "Open weights" badge when every stage runs on open weights. Until it is changed, every stage runs `MODEL_ID` (Muse Spark) on Meta's API, except Lead, which starts on Muse Wonder.

**Built with Muse Spark Open.** Any stage can run on Muse Spark Open, the open weights of Meta's Muse Spark, through OpenRouter, Baseten or your own server; the "Spark Open" presets set every stage at once. Muse Spark Open is licensed under the [Muse Model License](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B), and Settings → Models shows "Built with Muse Spark Open" whenever a stage runs it.

Check a stage from Settings, or call `GET /api/ping-model?stage=investigate` (may incur charges). `GET /api/health` shows each stage's model without calling it.

## License

Triage is released under the [MIT License](LICENSE). Muse Spark Open, when a stage runs it, is under its own Muse Model License (see above).
