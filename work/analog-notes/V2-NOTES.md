# Analog Notes v2

The current UI is an offline-first notebook. The native Sites creation request in the original flow failed before returning an ID; no project ID or deployed URL exists. Do not infer or invent one. The latest Sites listing was empty.

## Source

- `public/notebook.html`: interface, shared rendering, record templates, core controls.
- `public/notebook-v2.js`: IndexedDB transactions, per-user workspaces, topic management, attachments, backup/import and file-system export.
- `public/rich-text.js`: per-character size, weight, italics and six palette colors; formatting-only HTML sanitization, editor selection preservation and plain-text indexing.
- `public/jszip.min.js`: bundled JSZip, with `public/JSZip-LICENSE.md`.
- `scripts/build-offline.mjs`: embeds both browser scripts into a standalone HTML file. Pass the destination HTML path as its sole argument.

The page uses local storage on both file and HTTP origins. The previous authenticated D1 API remains in source for future server integration, but the current UI does not call it. Do not claim cloud sync, password authentication, or access isolation for local profiles. Native Sites access would still gate visits if the project is eventually published.

Rich text uses the optional `bodyHtml` property, retaining `body` as plain text for search and previews. Older notes without `bodyHtml` render as escaped text with preserved newlines. Rich HTML is rebuilt from allowed formatting elements and styles before display, paste insertion, save and import. JSON backups and offline HTML indexes preserve formatting; Markdown exports include sanitized inline HTML. This is an additive extension to the version 2 backup format.

## Persistence

IndexedDB `analog-notes-offline-v2` stores one versioned workspace state and separate Blob files. A single read-write transaction atomically updates record metadata and attachments. Revision checks reject stale writes from another window. Old `analog-notes-v1` localStorage notes are migrated only when the v2 state is absent; the old key is left intact. File-origin storage behavior varies by browser, so legacy JSON imports are also supported.

Attachments are staged until Save. Canceling a record edit leaves committed attachments unchanged. PDF and raster image previews use local Blob URLs; other files are downloadable. File-system exports create a new directory on each run and do not remove or overwrite preexisting directories.

JSON and ZIP backups cover the current user. JSON includes base64 attachment data; ZIP uses referenced original files. See DOCUMENT-LIBRARY-NOTES.md for the latest document, library, and reader behavior. ZIP also includes categorized original files, Markdown notes, and a script-free offline index. Imports validate records and file data before committing them together. Same-ID notes are skipped; imported file IDs are regenerated.

## Verification

The production build and TypeScript check passed. Automated browser checks covered v1 migration, persistent topic removal, separate profiles, rename/switch, offline attachment bytes and PDF preview, canceled and saved removal, self-contained JSON/ZIP backups, categorized exports, restored files, malformed-import rollback, deletion and mobile layout. Directory-write content was checked using a simulated browser File System Access interface; the native chooser and OS permission UI require interaction in the user's browser.
