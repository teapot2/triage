import type { Dataset, ExportFormat, ExportSubject } from "./dataset";
import { exportFilename } from "./filename";
import { serialize } from "./serialize";

// Browser only: saving a file without a round trip to the server.

// Text the page already has, saved under filename.
export function downloadText(text: string, filename: string, contentType: string) {
  const url = URL.createObjectURL(new Blob([text], { type: contentType }));
  clickDownload(url, filename);
  URL.revokeObjectURL(url);
}

// A server export (/api/export/...), whose Content-Disposition names the file.
export function downloadUrl(href: string) {
  clickDownload(href, "");
}

// Rows the page already has, as the server would have written them.
export function downloadRows<Row>(dataset: Dataset<Row>, rows: Row[], subject: ExportSubject, format: ExportFormat) {
  const exportedAt = new Date();
  const file = serialize(dataset, rows, format, { subject, exportedAt });
  downloadText(file.body, exportFilename(dataset.id, subject.name, file.extension, exportedAt), file.contentType);
}

function clickDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}
