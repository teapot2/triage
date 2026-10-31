import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Cell, defineDataset } from "./dataset";
import { csvCell, serialize } from "./serialize";

type Row = { a: Cell; b?: Cell; secret?: string };

const dataset = defineDataset<Row>({
  id: "test-rows",
  name: "Test rows",
  columns: [
    { key: "a", value: (r) => r.a },
    { key: "b", value: (r) => r.b },
  ],
  formats: ["csv", "json", "ndjson"],
});

const meta = { subject: { kind: "endpoint", id: "chk_aaaaaa", name: "Portionary" }, exportedAt: new Date("2026-10-30T02:15:30.000Z") };

describe("csv", () => {
  it("quotes quotes, commas, line breaks and edge spaces, doubling inner quotes", () => {
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell("a,b"), '"a,b"');
    assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
    assert.equal(csvCell("cr\rhere"), '"cr\rhere"');
    assert.equal(csvCell(" lead"), '" lead"');
    assert.equal(csvCell("trail "), '"trail "');
    assert.equal(csvCell("plain text"), "plain text");
  });

  it("guards strings that a spreadsheet would run, never numbers", () => {
    assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
    assert.equal(csvCell("+1"), "'+1");
    assert.equal(csvCell("-1"), "'-1");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell("\tx"), "'\tx");
    assert.equal(csvCell("\rx"), "\"'\rx\"");
    assert.equal(csvCell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
    assert.equal(csvCell(-5), "-5");
    assert.equal(csvCell(0.25), "0.25");
  });

  it("writes null and undefined empty, booleans as words, non-finite numbers empty", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell(true), "true");
    assert.equal(csvCell(false), "false");
    assert.equal(csvCell(Number.NaN), "");
    assert.equal(csvCell(Number.POSITIVE_INFINITY), "");
  });

  it("starts with a BOM and a header of keys, and ends every line with CRLF", () => {
    const file = serialize(dataset, [{ a: "x,y", b: -5 }, { a: null }, { a: "=1", b: true }], "csv", meta);
    assert.equal(file.body, '﻿a,b\r\n"x,y",-5\r\n,\r\n\'=1,true\r\n');
    assert.equal(file.contentType, "text/csv; charset=utf-8");
    assert.equal(file.extension, "csv");
  });

  it("writes only the header for no rows", () => {
    assert.equal(serialize(dataset, [], "csv", meta).body, "﻿a,b\r\n");
  });

  it("leaves out fields that aren't columns", () => {
    assert.ok(!serialize(dataset, [{ a: 1, secret: "hunter2" }], "csv", meta).body.includes("hunter2"));
  });
});

describe("json", () => {
  it("wraps the column objects in an envelope, undefined as null", () => {
    const file = serialize(dataset, [{ a: "x", secret: "hunter2" }, { a: 2, b: false }], "json", meta);
    assert.equal(file.contentType, "application/json; charset=utf-8");
    assert.equal(file.extension, "json");
    assert.ok(file.body.endsWith("\n"));
    assert.ok(file.body.includes('\n  "dataset"'), "pretty-printed");
    assert.deepEqual(JSON.parse(file.body), {
      dataset: "test-rows",
      name: "Test rows",
      exportedAt: "2026-10-30T02:15:30.000Z",
      subject: meta.subject,
      count: 2,
      rows: [
        { a: "x", b: null },
        { a: 2, b: false },
      ],
    });
  });

  it("uses the dataset's own record when it has one", () => {
    const full = defineDataset<Row>({ ...dataset, id: "test-full", json: (r) => ({ whole: r }) });
    assert.deepEqual(JSON.parse(serialize(full, [{ a: 1 }], "json", meta).body).rows, [{ whole: { a: 1 } }]);
  });
});

describe("ndjson", () => {
  it("writes one row per line, no envelope, with a trailing newline", () => {
    const file = serialize(dataset, [{ a: "line\nbreak" }, { a: 2, b: true }], "ndjson", meta);
    assert.equal(file.body, '{"a":"line\\nbreak","b":null}\n{"a":2,"b":true}\n');
    assert.equal(file.contentType, "application/x-ndjson; charset=utf-8");
    assert.equal(file.extension, "ndjson");
  });

  it("writes nothing for no rows", () => {
    assert.equal(serialize(dataset, [], "ndjson", meta).body, "");
  });
});

describe("text formats", () => {
  const notes = defineDataset<Row>({
    id: "test-notes",
    name: "Notes",
    columns: [],
    formats: ["md", "patch"],
    text: { md: (rows) => `# ${rows.length} rows\n`, patch: () => "--- a\n+++ b\n" },
  });

  it("hands the whole file to the dataset", () => {
    assert.deepEqual(serialize(notes, [{ a: 1 }], "md", meta), { body: "# 1 rows\n", contentType: "text/markdown; charset=utf-8", extension: "md" });
    assert.deepEqual(serialize(notes, [], "patch", meta), { body: "--- a\n+++ b\n", contentType: "text/x-diff; charset=utf-8", extension: "patch" });
  });

  it("refuses a format the dataset doesn't list", () => {
    assert.throws(() => serialize(dataset, [], "md", meta), /test-rows has no md export/);
    assert.throws(() => serialize(notes, [], "csv", meta), /test-notes has no csv export/);
  });
});

describe("defineDataset", () => {
  const base = { id: "ok-id", name: "Ok", columns: [{ key: "a", value: () => 1 }], formats: ["csv" as const] };

  it("refuses definitions that would write a broken file", () => {
    assert.throws(() => defineDataset({ ...base, id: "Not Kebab" }), /kebab-case/);
    assert.throws(() => defineDataset({ ...base, columns: [] }), /no columns/);
    assert.throws(() => defineDataset({ ...base, columns: [base.columns[0], base.columns[0]] }), /listed twice/);
    assert.throws(() => defineDataset({ ...base, formats: ["csv", "md"] }), /no text\.md/);
    assert.throws(() => defineDataset({ ...base, formats: [] }), /no formats/);
  });
});
