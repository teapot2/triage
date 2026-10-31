// What an export is, browser-safe: a dataset says which fields leave the app
// and in which formats; serialize.ts turns its rows into a file. The server
// (registry.ts) and the browser (export-menu.tsx) share these definitions.

export const exportFormats = ["csv", "json", "ndjson", "md", "patch"] as const;
export type ExportFormat = (typeof exportFormats)[number];

export type Cell = string | number | boolean | null | undefined;

export type Column<Row> = { key: string; value: (row: Row) => Cell };

export type Dataset<Row> = {
  // kebab-case, also the URL segment and the filename prefix
  id: string;
  // For menus: "Results (last 48 h)"
  name: string;
  // An allowlist: CSV and default JSON are built only from these, so a field
  // added to Row later doesn't leak into files people already share.
  columns: Column<Row>[];
  formats: ExportFormat[];
  // Explicit full-record JSON; the default is the column object.
  json?: (row: Row) => unknown;
  // Whole-file text formats.
  text?: Partial<Record<"md" | "patch", (rows: Row[]) => string>>;
};

// Who or what the rows are about, for the JSON envelope and the filename.
export type ExportSubject = { kind: string; id: string; name: string };

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Checks the definition when its module loads, so a broken dataset fails the
// tests and the build rather than a download someone already trusts.
export function defineDataset<Row>(d: Dataset<Row>): Dataset<Row> {
  const problem = datasetProblem(d);
  if (problem) throw new Error(`dataset ${JSON.stringify(d.id)}: ${problem}`);
  return d;
}

function datasetProblem(d: Dataset<never>): string | undefined {
  if (!idPattern.test(d.id)) return "id must be kebab-case (a-z, 0-9 and single dashes)";
  if (!d.name.trim()) return "name is empty";
  if (d.formats.length === 0) return "no formats";
  if (new Set(d.formats).size !== d.formats.length) return "a format is listed twice";
  for (const f of d.formats) if (!exportFormats.includes(f)) return `unknown format ${JSON.stringify(f)}`;
  if (d.columns.length === 0 && (d.formats.includes("csv") || (!d.json && (d.formats.includes("json") || d.formats.includes("ndjson"))))) {
    return "no columns";
  }
  const keys = d.columns.map((c) => c.key);
  if (keys.some((k) => !k.trim())) return "a column key is empty";
  if (new Set(keys).size !== keys.length) return "a column key is listed twice";
  for (const f of ["md", "patch"] as const) {
    if (d.formats.includes(f) && !d.text?.[f]) return `lists ${f} but has no text.${f}`;
  }
  return undefined;
}
