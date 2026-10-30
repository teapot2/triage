import type { Postmortem } from "../schema";

// A finished postmortem record for the pool-leak example (inc_pool_leak in
// fixtures.ts), written by hand: for tests, and to paste into an incident
// in .data/ to see the export without a model call.
export const samplePostmortem: Postmortem = {
  status: "ready",
  startedAt: "2026-10-23T02:20:00.000Z",
  finishedAt: "2026-10-23T02:20:41.000Z",
  provider: "meta",
  model: "muse-spark-1.3",
  inputTokens: 18_420,
  outputTokens: 1_310,
  summary:
    "From 02:10 UTC, product pages on shopfront slowed to about 3 seconds and many returned errors, because a code path added in the 01:58 deploy kept a database connection every time a product had no stock row. Once all ten connections were held, every request that needed the database waited and timed out. Turning off the flag that put the path in use stops it; the fix releases the connection on every path.",
  impact: {
    text: "Shoppers opening product pages waited about 3 seconds and hundreds got a 500 instead of the page; traffic stayed normal, so this was most of the product-page traffic in the window.",
    evidenceIds: ["ev_metric_p95", "ev_log_timeout", "ev_metric_rps"],
  },
  contributingFactors: [
    {
      text: "getStockLevel returns early on a missing stock row without releasing its pooled connection.",
      evidenceIds: ["ev_source_stock"],
    },
    {
      text: "Turning on FF_STOCK_DIRECT_QUERY put that function on the hot path of every product page.",
      evidenceIds: ["ev_commit_flag", "ev_commit_stock"],
    },
    {
      text: "Many products have no stock row, so the early return ran hundreds of times.",
      evidenceIds: ["ev_log_stock_miss"],
    },
    {
      text: "The pool holds only 10 connections, so it ran out within minutes.",
      evidenceIds: ["ev_metric_pool", "ev_db_activity"],
    },
  ],
  wentWell: [
    {
      text: "The latency alert caught the climb within minutes of the pool filling.",
      evidenceIds: ["ev_metric_p95"],
    },
    {
      text: "Database statistics ruled out slow queries and lock contention quickly.",
      evidenceIds: ["ev_db_statements", "ev_db_locks"],
    },
  ],
  wentBadly: [
    {
      text: "No test covered the missing-row path, so the change shipped without anyone seeing the connection stay checked out.",
      evidenceIds: ["ev_source_stock"],
    },
    {
      text: "Nothing alerts on pool saturation itself; it showed up only as latency.",
      evidenceIds: ["ev_metric_pool"],
    },
  ],
  lucky: [
    "It happened at night, when traffic was about 14 requests a second.",
    "The new path sat behind a flag, so turning it off was a quick and reversible way to stop it.",
  ],
  actionItems: [
    {
      title: "Lint for pooled clients acquired without a release in a finally block",
      kind: "prevent_class",
      priority: "P2",
      evidenceIds: ["ev_source_stock"],
    },
    {
      title: "Alert when DB pool connections in use stay at the maximum for 2 minutes",
      kind: "detect_sooner",
      priority: "P2",
      evidenceIds: ["ev_metric_pool"],
    },
    {
      title: "Document turning off FF_STOCK_DIRECT_QUERY in the shopfront runbook",
      kind: "mitigate_faster",
      priority: "P3",
      evidenceIds: ["ev_commit_flag"],
    },
  ],
  citedIds: [
    "ev_metric_p95",
    "ev_log_timeout",
    "ev_metric_rps",
    "ev_source_stock",
    "ev_commit_flag",
    "ev_commit_stock",
    "ev_log_stock_miss",
    "ev_metric_pool",
    "ev_db_activity",
    "ev_db_statements",
    "ev_db_locks",
  ],
  unknownIds: [],
};
