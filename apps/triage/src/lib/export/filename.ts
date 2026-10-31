// endpoint-results_portionary_2026-10-30T0215Z.csv: plain ASCII, no
// characters Windows refuses (no colons in the time), sortable by time.

export function exportFilename(datasetId: string, subjectName: string, extension: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace(":", "") + "Z";
  return `${slug(datasetId)}_${slug(subjectName)}_${stamp}.${slug(extension)}`;
}

const MAX_SLUG = 40;

// "Café Ünïcode / API" → "cafe-unicode-api". Accents are dropped (NFKD splits
// them off), anything else outside a–z0–9 becomes a dash.
export function slug(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return s || "export";
}
