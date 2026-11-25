/**
 * [INPUT]: 读取 PPT/PPTX 解析结构、逐页元数据、渲染缓存与用户逐页批注。
 * [OUTPUT]: 提供 savePresentationSearchIndex、buildPresentationSearchIndex 与 exportPresentationHandout。
 * [POS]: 连接演示文稿工作台与全库全文检索索引层，并支持一键导出双栏图文复习讲义 (.html) 与结构化大纲 (.md)。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

async function savePresentationSearchIndex(profileId, fileId, slideMetas) {
  if (!profileId || !fileId || !Array.isArray(slideMetas) || !slideMetas.length) return false;
  const totalPages = slideMetas.length;
  const pages = [], emptyPages = [];
  for (let i = 0; i < totalPages; i++) {
    const meta = slideMetas[i] || {};
    const combined = [meta.title, meta.text, meta.speakerNotes]
      .filter(Boolean)
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
    if (combined) pages.push({ n: i + 1, text: combined.slice(0, 50000) });
    else emptyPages.push(i + 1);
  }
  const segment = { start: 1, end: totalPages, totalPages, failedPages: [], emptyPages, pages };
  return putWorkspaceForFile(profileId, fileId, pdfIndexPrefix(profileId, fileId) + '00000001', segment);
}

async function buildPresentationSearchIndex(file, { profileId = appState.activeId, signal, onProgress } = {}) {
  signal?.throwIfAborted();
  const cached = await readSearchIndex(file.id, profileId);
  if (cached && cached.scannedPages === cached.totalPages) return cached;
  if (file.size > MAX_DOCUMENT_PREVIEW) return null;
  const raw = await readBlob(file.id, profileId);
  signal?.throwIfAborted();
  const engine = await presentationEngine();
  const parsed = await engine.parse(raw);
  try {
    signal?.throwIfAborted();
    const total = parsed?.slides?.length || 0;
    if (!total) return { totalPages: 0, scannedPages: 0, failedPages: [], emptyPages: [], pages: [] };
    const metas = parsed.slides.map((slide, idx) => {
      onProgress?.({ page: idx + 1, total });
      return extractSlideMetadata(slide, idx);
    });
    await savePresentationSearchIndex(profileId, file.id, metas);
    return readSearchIndex(file.id, profileId);
  } finally {
    parsed?.dispose?.();
  }
}

async function exportPresentationHandout(ctx, format = 'html') {
  const { file, presentation, slideMetas, renderSlideCached, slideNoteRecord, flushCurrent } = ctx;
  if (!presentation?.slides?.length) throw new Error('演示文稿尚未加载完成。');
  flushCurrent?.();
  const baseName = safeFileName(file.name.replace(/\.pptx?$/i, '') || '演示讲义');
  const total = presentation.slides.length;
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  let notedCount = 0;
  for (let i = 1; i <= total; i++) {
    if (slideNoteRecord(i)?.note?.trim()) notedCount++;
  }

  if (format === 'md') {
    const blocks = [
      '# ' + file.name + ' · 结构化复习讲义',
      '',
      '> 导出时间：' + exportedAt + ' · 共 ' + total + ' 页 · 已批注 ' + notedCount + ' 页',
      ''
    ];
    for (let i = 0; i < total; i++) {
      const n = i + 1;
      const meta = slideMetas[i] || { title: '第 ' + n + ' 页', text: '', speakerNotes: '' };
      const note = slideNoteRecord(n)?.note?.trim() || '';
      blocks.push('## 第 ' + String(n).padStart(2, '0') + ' 页 · ' + meta.title, '');
      if (note) blocks.push('> **个人精读批注**  \n> ' + note.replace(/\n/g, '\n> '), '');
      if (meta.speakerNotes) blocks.push('### 原片讲义备注', '', meta.speakerNotes, '');
      if (meta.text) blocks.push('### 幻灯片正文要点', '', meta.text, '');
      blocks.push('---', '');
    }
    const mdText = blocks.join('\n');
    const outName = baseName + '-复习讲义.md';
    const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
    window.__lastExportedPptHandout = { name: outName, format: 'md', size: blob.size, text: mdText };
    downloadBlob(outName, blob);
    toast('已导出 Markdown 讲义 · 共 ' + total + ' 页');
    return window.__lastExportedPptHandout;
  }

  toast('正在合成双栏图文讲义…');
  const rows = [];
  for (let i = 0; i < total; i++) {
    const n = i + 1;
    const meta = slideMetas[i] || { title: '第 ' + n + ' 页', text: '', speakerNotes: '' };
    const note = slideNoteRecord(n)?.note?.trim() || '';
    let svgMarkup = '';
    try {
      const rendered = await renderSlideCached(i);
      svgMarkup = rendered.svg || '';
    } catch {}
    const svgDataUri = svgMarkup
      ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup)
      : '';
    rows.push('<section class="slide-row' + (note ? ' has-note' : '') + '">'
      + '<div class="slide-visual">'
      + '<div class="slide-badge">SLIDE ' + String(n).padStart(2, '0') + ' / ' + String(total).padStart(2, '0') + '</div>'
      + (svgDataUri ? '<img src="' + svgDataUri + '" alt="第 ' + n + ' 页幻灯片">' : '<div class="slide-fallback">幻灯片预览不可用</div>')
      + '</div>'
      + '<div class="slide-notes">'
      + '<h2>' + esc(meta.title) + '</h2>'
      + (note ? '<div class="user-note-card"><span class="card-tag">个人批注</span><p>' + esc(note).replace(/\n/g, '<br>') + '</p></div>' : '<div class="user-note-blank">（留白批注区：打印后可手写补充推导或课堂笔记）</div>')
      + (meta.speakerNotes ? '<div class="speaker-card"><span class="card-tag">原片讲义备注</span><pre>' + esc(meta.speakerNotes) + '</pre></div>' : '')
      + (meta.text ? '<details class="extracted-card"><summary>本页提取文字</summary><pre>' + esc(meta.text) + '</pre></details>' : '')
      + '</div></section>');
  }

  const htmlDoc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(file.name) + ' · 双栏复习讲义</title>'
    + '<style>'
    + '*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#0f172a;font:14px/1.65 system-ui,"Microsoft YaHei UI",sans-serif}'
    + '.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 28px;background:rgba(255,255,255,.88);backdrop-filter:blur(12px);border-bottom:1px solid #e2e8f0}'
    + '.top h1{margin:0;font-size:17px}.top small{color:#64748b;display:block;font-size:12px}'
    + '.print-btn{padding:8px 16px;border:0;border-radius:999px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}'
    + 'main{max-width:1180px;margin:24px auto 48px;padding:0 20px;display:grid;gap:20px}'
    + '.slide-row{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:22px;padding:20px;border-radius:16px;background:#fff;border:1px solid #e2e8f0;box-shadow:0 4px 18px -4px rgba(15,23,42,.05);break-inside:avoid}'
    + '.slide-row.has-note{border-color:#93c5fd}'
    + '.slide-badge{display:inline-block;margin-bottom:8px;padding:2px 9px;border-radius:999px;background:#eff6ff;color:#2563eb;font:700 11px/1.4 ui-monospace,monospace}'
    + '.slide-visual img{display:block;width:100%;height:auto;border-radius:10px;border:1px solid #e2e8f0;background:#fff}'
    + '.slide-notes{display:flex;flex-direction:column;gap:10px;min-width:0}.slide-notes h2{margin:0;font-size:16px;line-height:1.4}'
    + '.card-tag{display:inline-block;margin-bottom:4px;font-size:11px;font-weight:700;color:#2563eb}'
    + '.user-note-card{padding:12px 14px;border-radius:11px;background:#eff6ff;border-left:3.5px solid #2563eb}.user-note-card p{margin:0}'
    + '.user-note-blank{min-height:68px;padding:10px 12px;border-radius:10px;border:1px dashed #cbd5e1;color:#94a3b8;font-size:12px}'
    + '.speaker-card{padding:10px 12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0}.speaker-card .card-tag{color:#059669}'
    + 'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.6 inherit;color:#334155}'
    + '.extracted-card summary{cursor:pointer;color:#64748b;font-size:12px;font-weight:600}.extracted-card pre{margin-top:6px}'
    + '@media(max-width:780px){.slide-row{grid-template-columns:1fr}}'
    + '@media print{body{background:#fff}.top{position:static;border-bottom:2px solid #0f172a}.print-btn{display:none}main{margin:0;padding:0;max-width:none}.slide-row{box-shadow:none;border-radius:0;border:0;border-bottom:1px solid #cbd5e1;padding:14px 0}}'
    + '</style></head><body>'
    + '<header class="top"><div><h1>' + esc(file.name) + '</h1><small>DoNote 双栏复习讲义 · 共 ' + total + ' 页 · 已批注 ' + notedCount + ' 页 · ' + esc(exportedAt) + '</small></div>'
    + '<button class="print-btn" onclick="window.print()">打印 / 存为 PDF</button></header>'
    + '<main>' + rows.join('') + '</main></body></html>';

  const outName = baseName + '-双栏复习讲义.html';
  const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
  window.__lastExportedPptHandout = { name: outName, format: 'html', size: blob.size, notedCount, slideCount: total };
  downloadBlob(outName, blob);
  toast('已导出双栏图文讲义 · 共 ' + total + ' 页');
  return window.__lastExportedPptHandout;
}
