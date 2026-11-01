import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Incident } from "@/lib/investigation/schema";
import { incidentKeywords, MAX_KEYWORDS } from "./keywords";

type Input = Parameters<typeof incidentKeywords>[0];

const incident = (over: Partial<Input> = {}, trigger: Partial<Input["trigger"]> = {}): Input => ({
  service: "shopfront",
  trigger: { metric: "http.server.request.duration.p95{route=/api/products/[id]}", unit: "ms", threshold: 500, observed: 900, series: [], ...trigger },
  evidence: [],
  ...over,
});

const span = (name: string, attributes: Record<string, string | number> = {}): Incident["evidence"][number] => ({
  id: "ev_span_1",
  tool: "query_traces",
  summary: "",
  kind: "span",
  service: "shopfront",
  traceId: "t",
  name,
  durationMs: 1,
  status: "ok",
  attributes,
});

describe("incidentKeywords", () => {
  it("names the service and the alert's route in spoken words", () => {
    assert.deepEqual(incidentKeywords(incident()), ["shopfront", "products"]);
  });

  it("splits route segments into words and skips parameters, IDs and versions", () => {
    const words = incidentKeywords(incident({}, { route: "/api/v2/checkout-session/[id]/line_items/42", metric: "x" }));
    assert.deepEqual(words, ["shopfront", "checkout session", "line items"]);
  });

  it("reads routes from the focus, HTTP spans and metric evidence, once each", () => {
    const words = incidentKeywords(
      incident(
        {
          evidence: [
            span("GET /api/products"),
            span("GET /_not-found"),
            span("pg.query"),
            { id: "ev_metric_1", tool: "query_metrics", summary: "", kind: "metric", metric: "error_ratio{route=/cart}", unit: "ratio", baseline: 0, observed: 1, series: [] },
          ],
        },
        { focus: { from: "2026-10-30T17:00:00.000Z", to: "2026-10-30T17:10:00.000Z", route: "/products/[id]" } },
      ),
    );
    assert.deepEqual(words, ["shopfront", "products", "cart"]);
  });

  it("says an uptime incident's host as its name, without www, the TLD or the port", () => {
    assert.deepEqual(incidentKeywords(incident({ service: "www.portionary.app:443" }, { metric: "uptime.response_time" })), ["portionary"]);
    assert.deepEqual(incidentKeywords(incident({ service: "status.acme-cloud.io" }, { metric: "uptime.response_time" })), ["acme cloud"]);
  });

  it("adds hosts from span attributes but not IP addresses or localhost", () => {
    const evidence = [
      span("GET /", { "url.full": "https://api.stripe.com/v1/charges" }),
      span("GET /", { "server.address": "10.0.0.4" }),
      span("GET /", { "server.address": "localhost" }),
    ];
    assert.deepEqual(incidentKeywords(incident({ evidence }, { metric: "x" })), ["shopfront", "stripe"]);
  });

  it("stops at the limit", () => {
    const evidence = Array.from({ length: 30 }, (_, i) => span(`GET /route${i}`));
    assert.equal(incidentKeywords(incident({ evidence })).length, MAX_KEYWORDS);
  });
});
