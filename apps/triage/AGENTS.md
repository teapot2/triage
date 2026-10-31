<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Forms

These are the defaults Triage's forms have settled on. They're recommendations, not rules. Start from them, and depart when a form's job is better served by something else. A new pattern that reads better is welcome; leave a comment saying why, so the next form can borrow it. When in doubt, lean toward usability first and as little on screen as does the job.

### Building blocks

Full-page forms are built from `@/components/form-fields`. [endpoint-form.tsx](src/components/watch/endpoint-form.tsx) and [rule-form.tsx](src/components/watch/rule-form.tsx) show them in use.

- `FormSection`: a short title over a bordered two-column grid.
- `FormRows` and `FormRow`: one row per repeated thing, with the same columns in each.
- `FormAdvanced`: rarely changed fields, closed, with their values on one line.
- `FormField`: a label, the control, then a hint or the error in the hint's place.
- `NumberInput`: a number with its unit inside the field.

Settings edits in place instead, with `DisclosureRow` from [settings-list.tsx](src/components/settings-list.tsx).

### Layout

- **Order by what only the person can supply.** The thing being created (a URL, a route) tends to come first and full width. Fields with good defaults follow, and what rarely changes usually reads best folded under `FormAdvanced`, with its current values in the summary.
- **A few short sections.** Titles work well as nouns or short phrases ("Endpoint", "Condition", "Opens an incident"). Group by what the person is deciding, not by how the data is stored.
- **Pair fields that belong together.** Two columns suit a pair, like a threshold and how long it has to last. Unrelated fields side by side make the eye zigzag.
- **Repeated things as rows.** When several things share the same fields (one rule per row, say), `FormRows` lines up their columns and saves repeating labels. Detail like severity fits beside the row's title better than in a hint.

### Words

- **Let the label and the unit carry the meaning.** Units sit inside `NumberInput`, and labels can read on into them ("For [3] checks in a row").
- **Hints only when the label can't carry it.** Syntax (a trailing `*`) or a consequence that isn't obvious is worth a hint. Restating the label isn't.
- **Read the result back.** The page header can say in one sentence what the form will do, from the first render. When a value is still missing, a stand-in ("the URL") beats an empty line.

### Behaviour

- **Defaults that work, and derive what you can.** A new form ought to be savable after filling in only what's unique to it. A value worked out from another (a name from the URL's host) can show as the placeholder, so leaving the field blank is visibly fine.
- **Pick lists for a few sensible choices.** Intervals and windows tend to be clearer as a `Select`. Free entry suits true numbers.
- **Errors after the first Save.** Show each error in its field's place, saying what's wrong and the allowed range. If it's inside Advanced, open Advanced.
- **On/off state lives on the object's page.** Pause and resume work best as a deliberate button there, and an edit leaves that state as the server has it.
- **Footer.** Cancel (ghost) and one primary verb ("Create endpoint", "Save changes"), with Delete on the left when editing. Cancel with unsaved changes asks first, and so does leaving the page.

## Exports

Anything a page shows can usually be offered as a download through `src/lib/export/` (see the README's Exports section).

- **A new export is a dataset and an entry.** Define the columns once in `src/lib/export/datasets/` with `defineDataset` (browser-safe: no server imports). For stored data, append a `defineExport({ dataset, params, load })` to `src/lib/export/exports.ts`; for data only the page has, pass `rows` instead. Then put `<ExportMenu exports={[...]} />` where that data is shown.
- **Columns are the allowlist.** Name each one in snake_case with its unit (`response_ms`), and never add one for a secret. A full-record JSON (`json`) is a deliberate choice, made only where the record holds no secrets.
- **Don't offer an empty file.** Leave a dataset out of the menu when it has no rows; the route answers 404 for it anyway.
