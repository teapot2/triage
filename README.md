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

## Models and providers

Each stage that calls a model (**Investigate** and **Fix**) has its own provider and model, chosen in Triage's **Settings → Models**. Every provider is an OpenAI-compatible endpoint:

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
