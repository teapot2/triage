# Triage

AI SRE for teams with no SRE. Built for the Meta Global AI Developer Hackathon on the Meta Model API (Muse Spark).

## Layout

- `apps/triage` — the Triage web app and agent (Next.js, Vercel AI SDK, Meta Model API).
- `apps/shopfront` — the instrumented demo target app (Next.js, Postgres, OpenTelemetry).
- `infra` — Postgres and OpenTelemetry Collector via Docker Compose.

## Setup

```bash
cp apps/triage/.env.example apps/triage/.env.local   # fill MODEL_API_KEY here
cp apps/shopfront/.env.example apps/shopfront/.env
pnpm install
pnpm infra:up
pnpm dev
```

Triage runs on http://localhost:3000, Shopfront on http://localhost:3001.

Each app owns its env file; commit only `.env.example` templates. Infrastructure uses `infra/docker-compose.yml`, not a root `.env`.

## Mitigate first

After a root-cause verdict, Triage proposes one mitigation from the evidence the diagnosis cites: turn off the cited feature flag, or roll back the cited deploy (proposed only: Shopfront has no deploy pipeline to run it against). Once a person approves it, Triage applies it through Shopfront's ops API (on in development; `OPS_ENABLED=1` in a production build; `SHOPFRONT_URL` if the store runs elsewhere) and re-reads the alert's metric until it recovers. Turning the flag off stops new leaks but frees none of the pooled connections the leak already holds, so the flag-off also recycles them. The tested patch still follows as the permanent fix.

## Verify

A recovery says the metric came back; the verification checks that it stayed back. After the mitigation's recovery, Triage keeps reading the alert's metric for a quiet window (5 completed minutes under the threshold, `TRIAGE_RESOLVE_AFTER_MINUTES` to change it) and then resolves the incident on its own, with the chart showing the recovery, the window and a resolved marker. If the metric climbs back over the threshold during the window, the incident reopens and says so. Once an incident is resolved, a new breach on the same rule within 30 minutes reopens that incident instead of opening a second one for the same outage. A reopened incident keeps its report, mitigation and fix and isn't investigated again. A pending fix approval doesn't hold up the resolution: it stays pending, and the incident stays under Needs attention until someone decides it. People can also mark an incident resolved, reopen it or verify again from the header's menu or the command palette; see `apps/triage/README.md`.

## Ask Triage

After the report, a person can ask Triage follow-up questions on the incident page and get an answer streamed token by token, citing evidence with clickable chips, and can deny a fix with feedback to get a new attempt; see `apps/triage/README.md`.

## Postmortem

Once an incident has a finished report, Triage writes a blameless postmortem from the incident's record on request: summary, impact, timeline, contributing factors, what went well, where we got lucky and action items, each claim citing the evidence behind it. It shows in the incident page's **Postmortem** section and can be copied or downloaded as Markdown. The model is the **Postmortem** stage in Settings → Models, which uses Ask's model until it is changed; see `apps/triage/README.md`.

## Models and providers

Each stage that calls a model (**Investigate**, **Fix**, **Ask** and **Postmortem**) has its own provider and model, chosen in Triage's **Settings → Models**. Every provider is an OpenAI-compatible endpoint:

| Provider | Endpoint | Key |
| --- | --- | --- |
| Meta Model API | `https://api.meta.ai/v1` (or `MODEL_API_BASE_URL`) | `MODEL_API_KEY` |
| OpenRouter (Muse Glimmer, Muse Spark Open, Spark, Wonder) | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Fireworks | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| LM Studio | `http://localhost:1234/v1` (editable in Settings) | optional |
| Ollama | `http://localhost:11434/v1` (editable) | optional |
| llama.cpp server | `http://localhost:8080/v1` (editable) | optional |
| Custom endpoint (Baseten, Modal, vLLM, …) | any base URL, set in Settings | optional, saved in Settings |

Put hosted keys in `apps/triage/.env.local` and restart. Keys entered in Settings are saved server-side in `apps/triage/.data/settings.json` (gitignored) and never sent to the browser.

**Open-weights mode.** The "Glimmer" presets run every stage on Muse Glimmer (Meta's open-weights 30B model) on OpenRouter, Fireworks or a local server; Settings shows an "Open weights" badge when every stage runs on open weights. Until a stage is changed, both use `MODEL_ID` on Meta's API.

Check a stage from Settings, or call `GET /api/ping-model?stage=investigate` (may incur charges). `GET /api/health` shows each stage's model without calling it.
