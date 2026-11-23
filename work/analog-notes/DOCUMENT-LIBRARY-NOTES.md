# Document and library update

Current UI remains offline, using the same version-2 IndexedDB database. No Site ID was returned by the original failed creation attempt; no hosted deployment exists. Keep actual publishing status explicit.

New source surfaces:

- `document-layout.js`: modal/full-page mode, original inline image Blobs, resizable percentage layouts, wrapping, double-click original viewer, static export image paths.
- `categories.js`: per-profile navigation categories, add/rename/reorder/delete-with-transfer, week keys and weekly meeting entry.
- `library.js`: original resource imports, authors and tags, reading-note references and reverse links, PDF/video reading state, local synchronous checkpoints plus durable IndexedDB records.
- `import-documents.js`: Markdown conversion with same-selection companion images; PPTX text/image extraction with original file retained; legacy PPT original archive only.
- `pdf-assets.js`: embedded PDF.js module and worker, loaded through local Blob module URLs. See included `PDFJS-LICENSE.txt`.
- `marked.umd.js`: local Markdown parser. See `Marked-LICENSE.md`.

Inline image references are sanitized spans holding `data-image-id`, bounded display percentage and alignment. Blob URLs and editor handles are transient, not saved. Imported backups regenerate attachment IDs and remap inline image references atomically. Detail and editor views use original Blob bytes; static folder exports generate relative image paths without loading those paths in the active notebook document.

Resource records use the reserved `resource` type. Default categories keep stable IDs when renamed. Deleting a category requires a different destination when records exist and moves record metadata while preserving files and body contents. Record validation also accepts `custom-*` types. Backup metadata includes category definitions and per-resource reading state. Existing version-1 and version-2 backups remain importable.

PDF rendering uses an embedded PDF.js canvas/text layer and tracks the current page and relative scroll position. PDF annotations, original application features and exact compatibility are bounded by the renderer; downloading the original remains available. Password-protected and unreadable PDFs show a download fallback. Video uses browser-native decoding; unsupported codecs show a fallback. Media is not transcoded. Reader positions are synchronously checkpointed on updates and mirrored to IndexedDB, including visibility/close handling. Backups include durable progress.

PPTX extraction is an editable document representation of text and supported raster images. It is not a slide renderer and does not reproduce shapes, charts, animation or arbitrary positioned text boxes. Legacy PPT remains an exact attachment. Word-style document editing was selected for long-lived reading notes; a free-position slide canvas was not added.

ZIP backups reference their original media files rather than repeating base64 bytes. Complete JSON backups and direct directory snapshots remain self-contained. The current per-file limit is 100 MB, per-note attachment limit 50, import limit 500 MB. Large JSON base64 validation uses linear scans instead of a nested repeating regular expression.

Browser validation covered original inline image byte equality after resizing and after backup recovery, layout persistence, modal/page switching, category management with record transfer, metadata/author search, PDF page and scroll resume, completion state, resource-note references, MD/PPTX import, weekly meetings with PPT attachments, WebM playback position resume, full backup recovery, static image export and mobile overflow. Previous user/profile/attachment/import checks and rich-text checks also passed. Native directory permission UI was previously covered with a simulated write interface; actual browser permission interaction remains user-controlled.
