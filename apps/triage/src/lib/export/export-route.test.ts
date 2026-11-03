import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { GET } from "../../app/api/export/[dataset]/route";
import { closeDb, getDb, transaction } from "../db";
import type { Finding } from "../investigation/dependencies/model";
import { recordAudit, setFindingIncident } from "../investigation/dependencies/store";
import { defaultCheck, saveChecks } from "../investigation/uptime/checks";
import { exportEntries } from "./exports";

// The export route end to end, on a temp working directory so .data (the
// checks file and triage.db) is ours.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-export-"));
  process.chdir(dir);
  await saveChecks([defaultCheck({ id: "chk_export", name: "Portionary — API (prod)", url: "https://example.com/health" })]);
  const db = getDb();
  const sample = db.prepare("INSERT INTO uptime_samples (check_id, at, ms, status, outcome, error) VALUES (?, ?, ?, ?, ?, ?)");
  const hour = db.prepare("INSERT INTO uptime_hourly (check_id, hour, checks, ok, slow, down, avg_ms, max_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  transaction(db, () => {
    sample.run("chk_export", Date.parse("2026-10-30T12:00:00.000Z"), 120, 200, "ok", null);
    sample.run("chk_export", Date.parse("2026-10-30T12:00:30.000Z"), 15_000, null, "down", "timeout, after 15000 ms");
    sample.run("chk_export", Date.parse("2026-10-30T12:01:00.000Z"), 240, 503, "down", "=cmd|' /C calc'!A0");
    hour.run("chk_export", Date.parse("2026-10-29T10:00:00.000Z"), 3, 1, 1, 1, 123.6, 400);
    hour.run("chk_export", Date.parse("2026-10-29T11:00:00.000Z"), 120, 120, 0, 0, 99.4, 180);
  });
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const get = (dataset: string, query: string) =>
  GET(new Request(`http://localhost:3021/api/export/${dataset}?${query}`), { params: Promise.resolve({ dataset }) });

const STAMP = /\d{4}-\d{2}-\d{2}T\d{4}Z/.source;

function assertDownload(res: Response, contentType: string, filename: RegExp) {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), contentType);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const disposition = res.headers.get("content-disposition") ?? "";
  const m = /^attachment; filename="([^"]+)"; filename\*=UTF-8''(\S+)$/.exec(disposition);
  assert.ok(m, disposition);
  assert.match(m[1], filename);
  assert.equal(decodeURIComponent(m[2]), m[1]);
}

describe("GET /api/export/[dataset]", () => {
  it("registers each dataset once, by its id", () => {
    assert.deepEqual([...exportEntries.keys()], [
      "endpoint-results",
      "endpoint-hourly",
      "incidents",
      "postmortem-actions",
      "dependency-findings",
      "incident",
      "evidence-logs",
      "evidence-spans",
      "evidence-metrics",
      "evidence-db",
      "evidence-source",
      "investigation-trace",
      "fix-patch",
      "ask-answers",
    ]);
  });

  it("writes an endpoint's results as CSV", async () => {
    const res = await get("endpoint-results", "format=csv&id=chk_export");
    assertDownload(res, "text/csv; charset=utf-8", new RegExp(`^endpoint-results_portionary-api-prod_${STAMP}\\.csv$`));
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    assert.equal(
      body,
      "﻿checked_at,outcome,status,response_ms,error\r\n" +
        "2026-10-30T12:00:00.000Z,ok,200,120,\r\n" +
        '2026-10-30T12:00:30.000Z,down,,15000,"timeout, after 15000 ms"\r\n' +
        "2026-10-30T12:01:00.000Z,down,503,240,'=cmd|' /C calc'!A0\r\n",
    );
  });

  it("writes an endpoint's results as JSON", async () => {
    const res = await get("endpoint-results", "format=json&id=chk_export");
    assertDownload(res, "application/json; charset=utf-8", new RegExp(`^endpoint-results_portionary-api-prod_${STAMP}\\.json$`));
    const json = await res.json();
    assert.equal(json.dataset, "endpoint-results");
    assert.equal(json.name, "Results (last 48 h)");
    assert.ok(!Number.isNaN(Date.parse(json.exportedAt)));
    assert.deepEqual(json.subject, { kind: "endpoint", id: "chk_export", name: "Portionary — API (prod)" });
    assert.equal(json.count, 3);
    assert.deepEqual(json.rows[1], {
      checked_at: "2026-10-30T12:00:30.000Z",
      outcome: "down",
      status: null,
      response_ms: 15000,
      error: "timeout, after 15000 ms",
    });
  });

  it("writes the hourly summary as CSV, uptime floored from the counts", async () => {
    const res = await get("endpoint-hourly", "format=csv&id=chk_export");
    assertDownload(res, "text/csv; charset=utf-8", new RegExp(`^endpoint-hourly_portionary-api-prod_${STAMP}\\.csv$`));
    const body = (await res.text()).replace(/^﻿/, "");
    assert.equal(
      body,
      "hour_start,checks,ok,slow,down,uptime_percent,avg_response_ms,max_response_ms\r\n" +
        "2026-10-29T10:00:00.000Z,3,1,1,1,66.66,124,400\r\n" +
        "2026-10-29T11:00:00.000Z,120,120,0,0,100,99,180\r\n",
    );
  });

  it("writes the hourly summary as JSON", async () => {
    const res = await get("endpoint-hourly", "format=json&id=chk_export");
    assertDownload(res, "application/json; charset=utf-8", /\.json$/);
    const json = await res.json();
    assert.equal(json.count, 2);
    assert.deepEqual(json.rows[0], {
      hour_start: "2026-10-29T10:00:00.000Z",
      checks: 3,
      ok: 1,
      slow: 1,
      down: 1,
      uptime_percent: 66.66,
      avg_response_ms: 124,
      max_response_ms: 400,
    });
  });

  it("answers 400 for a missing, unknown or unlisted format, or bad params", async () => {
    for (const query of ["id=chk_export", "format=xml&id=chk_export", "format=md&id=chk_export", "format=csv", "format=csv&id=../checks"]) {
      const res = await get("endpoint-results", query);
      assert.equal(res.status, 400, query);
      const { error } = await res.json();
      assert.equal(typeof error, "string", query);
      assert.ok(error.length > 0, query);
    }
    assert.match((await (await get("endpoint-results", "format=md&id=chk_export")).json()).error, /has no md export: use one of csv, json/);
    assert.match((await (await get("endpoint-results", "format=csv&id=nope")).json()).error, /id/);
  });

  it("answers 404 for an unknown dataset or a check that isn't there", async () => {
    const unknown = await get("nope", "format=csv&id=chk_export");
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /unknown export: nope/);
    assert.equal((await get("endpoint-results", "format=csv&id=chk_zzzzzz")).status, 404);
    assert.equal((await get("endpoint-hourly", "format=json&id=chk_zzzzzz")).status, 404);
  });
});

// A finding as the audit parses it, for the dependency store.
function finding(advisoryId: string, pkg: string, over: Partial<Finding> = {}): Finding {
  return {
    advisoryId,
    service: "deptest",
    package: pkg,
    title: `${pkg} is vulnerable`,
    versions: ["1.0.0"],
    vulnerable: "<1.0.1",
    patched: ">=1.0.1",
    severity: "moderate",
    cwe: ["CWE-1333"],
    url: `https://github.com/advisories/${advisoryId}`,
    dev: false,
    direct: ["app-dep"],
    paths: [`app-dep>${pkg}`],
    ...over,
  };
}

describe("GET /api/export/dependency-findings", () => {
  // Four audits: an old finding gone 11 days ago (left out, as the page
  // shows a week), one gone an hour ago (in, with gone_at), one current.
  before(() => {
    const hour = 3_600_000;
    const audit = (ago: number, findings: Finding[]) =>
      recordAudit(
        { service: "deptest", at: new Date(Date.now() - ago).toISOString(), durationMs: 900, packageManager: "pnpm", counts: { info: 0, low: 0, moderate: findings.length, high: 0, critical: 0 }, runtime: 0 },
        findings,
      );
    const old = finding("GHSA-old0-0000-0000", "oldpkg");
    const current = finding("GHSA-mini-0000-0000", "minimatch", { versions: ["3.0.4", "3.1.1"], direct: ["glob", "rimraf"], paths: ["glob>minimatch", "rimraf>glob>minimatch"] });
    const dev = finding("GHSA-esbu-0000-0000", "esbuild", { dev: true, patched: undefined, direct: ["tsx"], paths: ["tsx>esbuild"] });
    audit(12 * 24 * hour, [old]);
    audit(11 * 24 * hour, []);
    audit(2 * hour, [current, dev]);
    audit(1 * hour, [current]);
    setFindingIncident("deptest", "GHSA-mini-0000-0000", "inc_deps_test");
  });

  it("writes what the Watch page lists, gone ones of the last week with gone_at", async () => {
    const res = await get("dependency-findings", "format=csv&service=deptest");
    assertDownload(res, "text/csv; charset=utf-8", new RegExp(`^dependency-findings_deptest_${STAMP}\\.csv$`));
    const lines = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer()).slice(1).split("\r\n").filter(Boolean);
    assert.equal(lines[0], "advisory_id,package,versions,patched,severity,runtime_or_dev,direct,first_seen,last_seen,gone_at,incident_id");
    assert.equal(lines.length, 3);
    const byId = new Map(lines.slice(1).map((l) => [l.split(",")[0], l.split(",")]));
    const mini = byId.get("GHSA-mini-0000-0000")!;
    assert.deepEqual([mini[1], mini[2], mini[3], mini[4], mini[5], mini[6], mini[9], mini[10]], ["minimatch", "3.0.4 3.1.1", ">=1.0.1", "moderate", "runtime", "glob rimraf", "", "inc_deps_test"]);
    const esbuild = byId.get("GHSA-esbu-0000-0000")!;
    assert.equal(esbuild[3], "");
    assert.equal(esbuild[5], "dev");
    assert.match(esbuild[9], /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(byId.has("GHSA-old0-0000-0000"), false);
  });

  it("answers 404 for a service with nothing to show, 400 for a bad name", async () => {
    assert.equal((await get("dependency-findings", "format=csv&service=nothing-here")).status, 404);
    assert.equal((await get("dependency-findings", "format=csv&service=..%2Fetc")).status, 400);
  });
});
