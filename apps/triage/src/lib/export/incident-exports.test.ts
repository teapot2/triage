import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { exampleIncidents } from "../investigation/fixtures";
import { poolLeak, resolved } from "../investigation/postmortem/test-incidents";
import type { Incident } from "../investigation/schema";

// The incident list and postmortem action item exports through the route,
// on a temp working directory so .data is ours. The store resolves its
// folder when it loads, so the route is imported after the chdir.
const cwd = process.cwd();
let dir: string;
let GET: typeof import("../../app/api/export/[dataset]/route").GET;

const pad = (n: number) => String(n).padStart(2, "0");

// Twelve checkout incidents a minute apart, odd ones sev1: more than the
// list's first page holds.
function checkout(n: number): Incident {
  const control = structuredClone(exampleIncidents.find((i) => i.id === "inc_control")!);
  const at = `2026-10-24T10:${pad(n)}:00.000Z`;
  return { ...control, id: `inc_export_co_${pad(n)}`, title: `Checkout errors ${pad(n)}`, service: "checkout", severity: n % 2 ? "sev1" : "sev3", status: "diagnosed", detectedAt: at, run: undefined };
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-incident-export-"));
  process.chdir(dir);
  ({ GET } = await import("../../app/api/export/[dataset]/route"));
  const { saveIncident } = await import("../investigation/store");

  const done = resolved();
  done.id = "inc_export_resolved";
  done.approval = { ...done.approval!, state: "approved", prState: "opened", prUrl: "https://github.com/acme/shopfront/pull/42" };
  await saveIncident(done);
  await saveIncident({ ...poolLeak(), id: "inc_export_pm" });
  // A postmortem still being written has no action items yet.
  await saveIncident({ ...poolLeak(), id: "inc_export_writing", postmortem: { status: "writing", startedAt: "2026-10-23T02:20:00.000Z", model: "muse-spark-1.3" } });
  for (let n = 1; n <= 12; n++) await saveIncident(checkout(n));
});
after(async () => {
  process.chdir(cwd);
  // Windows may still hold a just-renamed file for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const get = (dataset: string, query: string, origin = "http://localhost:3021") =>
  GET(new Request(`${origin}/api/export/${dataset}?${query}`), { params: Promise.resolve({ dataset }) });

const text = async (res: Response) => (await res.text()).replace(/^﻿/, "");
const csvRows = (body: string) => body.split("\r\n").filter(Boolean);
const ids = async (res: Response) => ((await res.json()).rows as { id: string }[]).map((r) => r.id);

const STAMP = /\d{4}-\d{2}-\d{2}T\d{4}Z/.source;
const filename = (res: Response) => /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];

describe("GET /api/export/incidents", () => {
  it("writes the list's columns as CSV, one row per incident on every page", async () => {
    const res = await get("incidents", "format=csv");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(filename(res) ?? "", new RegExp(`^incidents_incidents_${STAMP}\\.csv$`));
    const [header, ...rows] = csvRows(await text(res));
    assert.equal(
      header,
      "id,title,service,severity,status,opened_by,detected_at,mitigated_at,resolved_at,minutes_to_mitigate,minutes_to_resolve,root_cause,confidence,confidence_grade,verdict_outcome,fix_state,pr_url,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_usd,url",
    );
    // 15 saved and the 4 bundled examples, as the list shows them.
    assert.equal(rows.length, 19);
    for (const id of ["inc_pool_leak", "inc_control", "inc_price_gap", "inc_live_ratings"]) {
      assert.ok(
        rows.some((r) => r.startsWith(`${id},`)),
        id,
      );
    }
  });

  it("fills an incident's times, diagnosis, fix and links", async () => {
    const res = await get("incidents", "format=csv&q=inc_export_resolved");
    const [, row] = csvRows(await text(res));
    assert.equal(
      row,
      "inc_export_resolved,p95 latency and 500s on GET /api/products/:id,shopfront,sev2,resolved,watch,2026-10-23T02:14:00Z," +
        "2026-10-23T02:15:20.000Z,2026-10-23T02:23:00.000Z,1.3,9,Connection leak in getStockLevel exhausts the pg pool,0.86,validated_exclusive,confirmed,proven," +
        "https://github.com/acme/shopfront/pull/42,18420,,1310,,0.0285925,http://localhost:3021/incidents/inc_export_resolved",
    );
  });

  it("leaves a column empty when the incident hasn't got there, and links from the request's origin", async () => {
    const res = await get("incidents", "format=json&q=inc_control", "https://triage.example.com");
    const json = await res.json();
    assert.deepEqual(json.subject, { kind: "incidents", id: "list", name: "incidents" });
    assert.equal(json.count, 1);
    assert.deepEqual(json.rows[0], {
      id: "inc_control",
      title: "Control run: product page latency check",
      service: "shopfront",
      severity: "sev4",
      status: "healthy",
      opened_by: null,
      detected_at: "2026-10-23T09:30:00Z",
      mitigated_at: null,
      resolved_at: null,
      minutes_to_mitigate: null,
      minutes_to_resolve: null,
      root_cause: null,
      confidence: null,
      confidence_grade: null,
      verdict_outcome: null,
      fix_state: null,
      pr_url: null,
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cost_usd: null,
      url: "https://triage.example.com/incidents/inc_control",
    });
  });

  it("honours the filters and sort across pages, ignoring the size and page", async () => {
    const all = Array.from({ length: 12 }, (_, i) => `inc_export_co_${pad(i + 1)}`);
    assert.deepEqual(await ids(await get("incidents", "format=json&service=checkout&sort=oldest&size=10&page=2")), all);
    assert.deepEqual(
      await ids(await get("incidents", "format=json&service=checkout&severity=sev1,sev2&size=10&page=1")),
      all.filter((_, i) => i % 2 === 0).reverse(),
    );
    assert.deepEqual(await ids(await get("incidents", "format=json&q=errors%201&sort=oldest")), all.slice(9));
    // Nothing matching: a 404, as the list then offers no Export.
    assert.equal((await get("incidents", "format=json&service=nope")).status, 404);
  });
});

describe("GET /api/export/postmortem-actions", () => {
  it("writes the action items as CSV, for a ticket importer", async () => {
    const res = await get("postmortem-actions", "format=csv&id=inc_export_pm");
    assert.equal(res.status, 200);
    assert.match(filename(res) ?? "", new RegExp(`^postmortem-actions_p95-latency-and-500s-on-get-api-products_${STAMP}\\.csv$`));
    const description = (kind: string) =>
      `"${kind}, from the postmortem of ""p95 latency and 500s on GET /api/products/:id"": http://localhost:3021/incidents/inc_export_pm"`;
    const link = "inc_export_pm,http://localhost:3021/incidents/inc_export_pm";
    assert.deepEqual(csvRows(await text(res)), [
      "title,description,priority,labels,owner,due_date,incident_id,incident_url,evidence_ids",
      `Lint for pooled clients acquired without a release in a finally block,${description("Prevent the class")},P2,postmortem;prevent_class,,,${link},ev_source_stock`,
      `Alert when DB pool connections in use stay at the maximum for 2 minutes,${description("Detect sooner")},P2,postmortem;detect_sooner,,,${link},ev_metric_pool`,
      `Document turning off FF_STOCK_DIRECT_QUERY in the shopfront runbook,${description("Mitigate faster")},P3,postmortem;mitigate_faster,,,${link},ev_commit_flag`,
    ]);
  });

  it("writes them as JSON, linked from the request's origin", async () => {
    const res = await get("postmortem-actions", "format=json&id=inc_export_pm", "https://triage.example.com");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    const json = await res.json();
    assert.deepEqual(json.subject, { kind: "incident", id: "inc_export_pm", name: "p95 latency and 500s on GET /api/products/:id" });
    assert.equal(json.count, 3);
    assert.deepEqual(json.rows[2], {
      title: "Document turning off FF_STOCK_DIRECT_QUERY in the shopfront runbook",
      description: 'Mitigate faster, from the postmortem of "p95 latency and 500s on GET /api/products/:id": https://triage.example.com/incidents/inc_export_pm',
      priority: "P3",
      labels: "postmortem;mitigate_faster",
      owner: null,
      due_date: null,
      incident_id: "inc_export_pm",
      incident_url: "https://triage.example.com/incidents/inc_export_pm",
      evidence_ids: "ev_commit_flag",
    });
  });

  it("answers 404 without an incident, a postmortem or its action items", async () => {
    for (const id of ["inc_nope", "inc_control", "inc_export_writing"]) {
      assert.equal((await get("postmortem-actions", `format=csv&id=${id}`)).status, 404, id);
    }
  });

  it("answers 400 for an id that isn't an incident's", async () => {
    for (const query of ["format=csv", "format=csv&id=../checks", "format=csv&id=chk_abc123"]) {
      const res = await get("postmortem-actions", query);
      assert.equal(res.status, 400, query);
      assert.match((await res.json()).error, /id/, query);
    }
  });
});
