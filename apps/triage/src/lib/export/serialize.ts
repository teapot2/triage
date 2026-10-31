import type { Cell, Dataset, ExportFormat, ExportSubject } from "./dataset";

// Rows to a file's text, the same in the browser and on the server.

export const formatInfo: Record<ExportFormat, { label: string; extension: string; contentType: string }> = {
  csv: { label: "CSV", extension: "csv", contentType: "text/csv; charset=utf-8" },
  json: { label: "JSON", extension: "json", contentType: "application/json; charset=utf-8" },
  ndjson: { label: "NDJSON", extension: "ndjson", contentType: "application/x-ndjson; charset=utf-8" },
  md: { label: "Markdown", extension: "md", contentType: "text/markdown; charset=utf-8" },
  patch: { label: "Patch", extension: "patch", contentType: "text/x-diff; charset=utf-8" },
};

export type SerializedExport = { body: string; contentType: string; extension: string };

export function serialize<Row>(
  dataset: Dataset<Row>,
  rows: Row[],
  format: ExportFormat,
  { subject, exportedAt }: { subject: ExportSubject; exportedAt: Date },
): SerializedExport {
  if (!dataset.formats.includes(format)) throw new Error(`${dataset.id} has no ${format} export`);
  const { contentType, extension } = formatInfo[format];
  return { body: body(dataset, rows, format, subject, exportedAt), contentType, extension };
}

function body<Row>(dataset: Dataset<Row>, rows: Row[], format: ExportFormat, subject: ExportSubject, exportedAt: Date): string {
  switch (format) {
    case "csv":
      return csv(dataset, rows);
    case "json":
      return (
        JSON.stringify(
          { dataset: dataset.id, name: dataset.name, exportedAt: exportedAt.toISOString(), subject, count: rows.length, rows: rows.map((r) => record(dataset, r)) },
          null,
          2,
        ) + "\n"
      );
    case "ndjson":
      return rows.map((r) => (JSON.stringify(record(dataset, r)) ?? "null") + "\n").join("");
    case "md":
    case "patch": {
      const text = dataset.text?.[format];
      if (!text) throw new Error(`${dataset.id} has no text.${format}`);
      return text(rows);
    }
  }
}

// The JSON row: the dataset's own, or its columns. Undefined becomes null so
// every row has every key.
function record<Row>(dataset: Dataset<Row>, row: Row): unknown {
  if (dataset.json) return dataset.json(row);
  return Object.fromEntries(dataset.columns.map((c) => [c.key, c.value(row) ?? null]));
}

// UTF-8 BOM so Excel reads the accents, CRLF line ends (RFC 4180).
function csv<Row>(dataset: Dataset<Row>, rows: Row[]): string {
  const lines = [dataset.columns.map((c) => csvCell(c.key)), ...rows.map((r) => dataset.columns.map((c) => csvCell(c.value(r))))];
  return "﻿" + lines.map((cells) => cells.join(",") + "\r\n").join("");
}

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  // Never guarded: -5 is a number, not a formula. NaN and Infinity aren't
  // numbers a spreadsheet reads, so they're left blank, as JSON makes them null.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  // A spreadsheet runs a text cell starting with one of these as a formula.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
