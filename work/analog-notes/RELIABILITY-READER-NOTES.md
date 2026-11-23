# Reliability, gallery and enhanced reader

The project remains an offline application; the original failed Sites registration returned no ID, and no hosted URL exists. The standalone output is built from the same public source with all libraries embedded.

## Reliability corrections

- `commitState` now compares the database revision to the revision of the submitted snapshot, not to mutable global state. This rejects stale same-window and cross-window writes rather than silently overwriting a winning update.
- Draft data lives in the existing workspace object store, separate from committed profile state. One latest draft per profile includes staged original Blobs. Successful formal saves remove the draft. Conflict recovery creates an independent note and regenerates file IDs and inline references.
- Removing a file while editing does not delete a Blob still referenced by another committed note.
- Original files in new backups include SHA-256 checksums. Import validates before any note/file transaction is committed; older backups without checksums remain accepted.
- Category names are sanitized in file paths, long file names preserve their extensions, and export reads a captured profile configuration. Backup collection waits for pending reader and annotation saves.
- PDF rendering rechecks its render token after asynchronous text-layer completion, preventing stale page work from changing the currently displayed page.

## Gallery

`library-gallery.js` turns the resource view into a responsive card grid. PDF first pages, images and readable video frames are rendered lazily with two background jobs and stored as expendable thumbnail Blobs in the workspace store. Derived previews never replace originals. Clicking a card opens the resource, with a separate details action for editing metadata. Other record views retain their original list interaction.

## Enhanced PDF reader

`pdf-tools.js` provides a full-width three-panel PDF reader, native PDF outline destinations with a page-list fallback, bookmarks, zoom, normalized annotation coordinates, text highlights/underline/strike/comment, rectangles, freehand paths and text boxes. Text-layer CSS uses PDF.js font-height and scale variables so selection geometry matches the canvas. Marks are stored independently under the profile/file ID in the workspace store. Attachment metadata in full backups carries marks, making restoration compatible with regenerated attachment IDs. Original PDF bytes are unchanged.

Local translation uses feature-detected `Translator.availability/create/translate`; actual language packs and live translation were not available during verification. The supported/unavailable paths were tested with a simulated implementation. The online translation button opens a Google Translate URL only on user activation. Text and a pasted result can be saved as a translation annotation.

`reader-ai.js` adds a configurable Chat Completions client with current-page, selected-text or no-document context and opt-in page image input. Endpoint validation requires HTTPS except localhost. API credentials stay in a per-profile in-memory Map and are excluded from localStorage, drafts and backups. Only endpoint/model preferences persist. Requests occur only on Send, can be aborted, and time out after 120 seconds. The panel previews context and can save an answer as a PDF annotation. Response text is inserted with textContent. Document text is treated as quoted untrusted context. API schema was checked against official documentation. No real model service or secret key was supplied, so request/response behavior was verified using a mock service, not a live paid API.

## Verification

Browser tests covered staged-file draft reload recovery, cleanup after save, stale-write rejection, same-length damaged backup rejection with atomic rollback, safe paths and extensions, independent conflict recovery, real PDF thumbnail render/cache, direct reading and metadata edit, responsive cards, text selection geometry, highlights and drawing marks, outline/bookmark navigation, zoom, reopened annotations, backup restoration, byte-identical original PDF and API-key exclusion after reload/export. Previous original-image, reading/video-resume, Markdown/PPTX, weekly meeting, legacy migration and backup tests passed. Native browser file-system chooser behavior remains user-controlled; write content was previously checked with a simulated interface.
