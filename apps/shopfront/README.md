# Shopfront

Instrumented demo e-commerce API (Next.js 16, Postgres via Drizzle, OpenTelemetry). It is the target app that Triage observes.

## Run

From the repo root:

```bash
pnpm install
pnpm infra:up                              # Postgres (host port 5433) + OTel Collector (4318)
cp apps/shopfront/.env.example apps/shopfront/.env
pnpm --filter @triage/shopfront db:migrate
pnpm --filter @triage/shopfront db:seed    # idempotent
pnpm --filter @triage/shopfront dev        # http://localhost:3001
```

`db:migrate` and `db:seed` read `DATABASE_URL` from the environment (default `postgres://triage:triage@localhost:5433/shopfront`). Export it or prefix the command if you change it.

Keep database and telemetry settings in `apps/shopfront/.env`; no model API key is needed. Never commit `.env`.

## Endpoints

- `GET /api/products`: list products
- `GET /api/products/:id`: one product with its `stock` (400 bad id, 404 missing)
- `GET /api/health`: `{ ok, db, pool, flags }`, runs `SELECT 1`, never throws (503 when the DB is down)
- `GET /api/ops`, `POST /api/ops`: the demo controls' state and actions (see below)

## Demo controls (`/ops`)

http://localhost:3001/ops plants a fault in the running store, sends it synthetic traffic and recovers from it, for Triage to investigate. It is on in development and off in production builds unless `OPS_ENABLED=1`.

- **Synthetic traffic**: 1 to 10 requests a second against the product API, sent from the server, so it keeps running with the page closed.
- **Faults**: "Connection pool leak" turns on `FF_STOCK_DIRECT_QUERY`, which switches `getStockLevel` (`src/lib/stock.ts`) to `getStockLevelDirect`. That path is the planted bug: it returns early when a product has no stock row (the Cast Iron Teapot, by design) without calling `client.release()`, so each such view keeps one pooled connection. At 2 req/s the pool (max 10) fills in about two minutes, then every database-backed request waits 3 s and fails with `timeout exceeded when trying to connect`. The fix is `try { ... } finally { client.release() }`. A flag also starts from its env var (`FF_STOCK_DIRECT_QUERY=1`).
- **Faults**: "Price list gap" turns on `FF_LIST_PRICES`, which moves the product page, `GET /api/products/:id` and the cart to `getListPrice` (`src/lib/prices.ts`), reading `product_prices` instead of `products.price_cents`. That table is the planted bug: `syncListPrices`, which the seed runs, fills it with an inner join on `stock_levels`, so a product with no stock row gets no price row. The Cast Iron Teapot and the three new arrivals (Stoneware Pasta Bowls, Linen Apron, Ribbed Ceramic Vase, featured on the home page) have none, so every view of them destructures an empty result and fails with a 500 (`TypeError: Cannot destructure property 'amountCents' ...`). Other products, listings and the home page stay up, at normal latency. The fix is either code (fall back to `products.price_cents` when the row is missing, or left-join the price) or data (backfill the missing `product_prices` rows from `products.price_cents`). Turning the flag off stops the errors at once, with no release step. Re-running `db:seed` rebuilds the price list, gap included.
- **One fault at a time**: /ops refuses to turn a fault on while another is on (409, "… is already on"), so each run has one root cause.
- **Recovery**: turning the pool leak off stops new leaks but doesn't free the pool. "Release stuck connections" hands back connections held over 5 s, as a restart would.

Each change is logged at warn (`ops: FF_STOCK_DIRECT_QUERY turned on`), so it shows in the same logs Triage reads, the way a config push would.

### Keeping the answer out of Triage's reach

Triage reads this app's source, git history and telemetry, so none of them may describe the planted bug: the flag is named like an ordinary rollout, `src/lib/stock.ts` carries no hint, and the explanation lives here and in `src/lib/ops.ts`. Triage's `read_source` and `git_log` skip the demo harness (`src/app/ops/`, `src/app/api/ops/`, `src/lib/ops.ts`, `src/lib/traffic.ts`, `src/db/pool-watch.ts`) and can't open this README. Two rules keep it that way:

- Nothing Triage can read mentions the bug, the fault or Triage itself. `pnpm --filter @triage/web check:blind` fails if it does.
- Commit messages for this app read like a real team's ("stock: read stock with a direct query"), since `git_log` shows them.

## Telemetry

`src/instrumentation.ts` loads the OTel Node SDK (nodejs runtime only) with auto-instrumentations (http, pg, undici, runtime metrics, ...) and OTLP/HTTP exporters for traces, metrics and logs to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`). Service name: `shopfront`. `src/lib/logger.ts` emits OTel log records that carry the active trace context.

## Schema changes

Edit `src/db/schema.ts`, then `pnpm --filter @triage/shopfront db:generate` and commit the new file under `drizzle/`.
