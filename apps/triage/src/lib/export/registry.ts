import { z } from "zod";
import { type Dataset, type ExportFormat, exportFormats, type ExportSubject } from "./dataset";
import { exportFilename } from "./filename";
import { serialize } from "./serialize";

// Server only: how /api/export/<dataset> finds an export's rows. The entries
// themselves are in exports.ts.

export type ExportContext = { origin: string };

export type ExportEntry<Row, P> = {
  dataset: Dataset<Row>;
  // The query string, minus format; parsed before load sees it.
  params: z.ZodType<P>;
  // Undefined when the subject isn't there (a deleted check): a 404.
  load: (params: P, ctx: ExportContext) => Promise<{ subject: ExportSubject; rows: Row[] } | undefined>;
};

// An entry with its types erased, so entries of different rows share a list.
// defineExport is the one place that forgets them: the route only ever hands
// load what params parsed, and serialize what load returned.
export type RegisteredExport = ExportEntry<unknown, unknown>;

export function defineExport<Row, P>(entry: ExportEntry<Row, P>): RegisteredExport {
  return entry as unknown as RegisteredExport;
}

// By dataset id; two entries with one id fail on load, not on download.
export function exportRegistry(entries: RegisteredExport[]): ReadonlyMap<string, RegisteredExport> {
  const byId = new Map<string, RegisteredExport>();
  for (const e of entries) {
    if (byId.has(e.dataset.id)) throw new Error(`two exports named ${e.dataset.id}`);
    byId.set(e.dataset.id, e);
  }
  return byId;
}

const error = (status: number, message: string) => Response.json({ error: message }, { status });

// GET /api/export/<id>?format=csv&<params>, as a download.
export async function exportResponse(
  registry: ReadonlyMap<string, RegisteredExport>,
  id: string,
  req: Request,
  now = new Date(),
): Promise<Response> {
  const entry = registry.get(id);
  if (!entry) return error(404, `unknown export: ${id}`);
  const { dataset } = entry;
  const url = new URL(req.url);
  const query = Object.fromEntries(url.searchParams);
  const { format, ...rest } = query;
  if (!format) return error(400, `format is required: one of ${dataset.formats.join(", ")}`);
  if (!dataset.formats.includes(format as ExportFormat)) {
    const known = (exportFormats as readonly string[]).includes(format);
    return error(400, `${known ? `${id} has no ${format} export` : `unknown format ${JSON.stringify(format)}`}: use one of ${dataset.formats.join(", ")}`);
  }
  const params = entry.params.safeParse(rest);
  if (!params.success) return error(400, z.prettifyError(params.error));
  const loaded = await entry.load(params.data, { origin: url.origin });
  if (!loaded) return error(404, `not found: nothing to export as ${id} for ${new URLSearchParams(rest)}`);
  const file = serialize(dataset, loaded.rows, format as ExportFormat, { subject: loaded.subject, exportedAt: now });
  return new Response(file.body, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": contentDisposition(exportFilename(dataset.id, loaded.subject.name, file.extension, now)),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// An ASCII filename for old clients, the exact one (RFC 5987) for the rest.
// exportFilename is ASCII already; this keeps the header safe if that changes.
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
