import { exportEntries } from "@/lib/export/exports";
import { exportResponse } from "@/lib/export/registry";

// A dataset as a file: GET /api/export/<dataset>?format=csv&<params>. The
// entries and their params are in lib/export/exports.ts.
export async function GET(req: Request, { params }: { params: Promise<{ dataset: string }> }) {
  const { dataset } = await params;
  return exportResponse(exportEntries, dataset, req);
}
