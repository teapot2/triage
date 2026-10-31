<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
## Exports

Anything a page shows can usually be offered as a download through `src/lib/export/` (see the README's Exports section).

- **A new export is a dataset and an entry.** Define the columns once in `src/lib/export/datasets/` with `defineDataset` (browser-safe: no server imports). For stored data, append a `defineExport({ dataset, params, load })` to `src/lib/export/exports.ts`; for data only the page has, pass `rows` instead. Then put `<ExportMenu exports={[...]} />` where that data is shown.
- **Columns are the allowlist.** Name each one in snake_case with its unit (`response_ms`), and never add one for a secret. A full-record JSON (`json`) is a deliberate choice, made only where the record holds no secrets.
- **Don't offer an empty file.** Leave a dataset out of the menu when it has no rows; the route answers 404 for it anyway.
