/**
 * [INPUT]: 读取 PPT/PPTX 字节流、内置 ppt-preview-engine、阅读会话进度与附件批注存储。
 * [OUTPUT]: 提供 fileIsPresentation、presentationEngine、renderFirstPresentationSlideBlob 与 openPresentationAttachment。
 * [POS]: 演示文稿资料库级阅读与批注工作台，支持胶片缩略图、网格总览、沉浸全屏放映、原片讲义提取、逐页批注与沉淀记录。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

let presentationEnginePromise;

function fileIsPresentation(file) {
  return /\.pptx?$/i.test(file?.name || '') || [
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ].includes(file?.mime);
}

function presentationEngine() {
  if (!presentationEnginePromise) {
    const embedded = $('embeddedPresentationEngine');
    const url = embedded
      ? URL.createObjectURL(new Blob([Uint8Array.from(atob(embedded.textContent), char => char.charCodeAt(0))], { type: 'text/javascript' }))
      : new URL('./ppt-preview-engine.mjs', document.baseURI).href;
    presentationEnginePromise = import(url).catch(error => {
      presentationEnginePromise = null;
      throw error;
    }).finally(() => { if (embedded) URL.revokeObjectURL(url); });
  }
  return presentationEnginePromise;
}

function presentationPictureAt(svg, image, event) {
  if (!svg) return null;
  const source = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = source.documentElement, ns = 'http://www.w3.org/2000/svg';
  const rect = image.getBoundingClientRect();
  const ratio = Math.min(rect.width / (image.naturalWidth || 960), rect.height / (image.naturalHeight || 540));
  const width = (image.naturalWidth || 960) * ratio, height = (image.naturalHeight || 540) * ratio;
  const probe = document.createElementNS(ns, 'svg');
  probe.setAttribute('viewBox', root.getAttribute('viewBox') || '0 0 ' + (image.naturalWidth || 960) + ' ' + (image.naturalHeight || 540));
  Object.assign(probe.style, {
    position: 'fixed', left: rect.left + (rect.width - width) / 2 + 'px',
    top: rect.top + (rect.height - height) / 2 + 'px', width: width + 'px', height: height + 'px',
    opacity: '0', pointerEvents: 'none'
  });
  const images = [];
  for (const original of source.querySelectorAll('image')) {
    let parent = probe;
    const ancestors = [];
    for (let n = original.parentElement; n && n !== root; n = n.parentElement) ancestors.unshift(n);
    for (const ancestor of ancestors) {
      const g = document.createElementNS(ns, 'g');
      if (ancestor.hasAttribute('transform')) g.setAttribute('transform', ancestor.getAttribute('transform'));
      parent.append(g); parent = g;
    }
    const copy = document.importNode(original, true);
    parent.append(copy); images.push(copy);
  }
  $('reader').append(probe);
  try {
    for (const item of images.reverse()) {
      const matrix = item.getScreenCTM();
      if (!matrix) continue;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const x = item.x.baseVal.value, y = item.y.baseVal.value, w = item.width.baseVal.value, h = item.height.baseVal.value;
      const href = item.getAttribute('href') || item.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h && /^data:image\//i.test(href || '')) return href;
    }
  } finally {
    probe.remove();
  }
  return null;
}

function openPresentationPicture(src, title) {
  const viewer = document.createElement('dialog');
  viewer.className = 'ppt-picture-viewer'; viewer.setAttribute('aria-label', title);
  viewer.innerHTML = '<div class="modalhead"><h2></h2><button type="button" class="icon-button" aria-label="关闭">✕</button></div><div class="ppt-picture-body"><img alt="幻灯片图片"></div>';
  viewer.querySelector('h2').textContent = title; viewer.querySelector('img').src = src;
  viewer.querySelector('button').onclick = () => viewer.close();
  viewer.addEventListener('close', () => viewer.remove(), { once: true });
  document.body.append(viewer); viewer.showModal();
}

async function embedPresentationMediaCached(svg, mediaCache, signal) {
  const reference = /(?:\b(?:href|src)\s*=\s*["']|\burl\(\s*["']?)(blob:[^\s"'()<>]+)/g;
  const urls = [...new Set([...svg.matchAll(reference)].map(match => match[1]))];
  if (!urls.length) return svg;
  await Promise.all(urls.map(url => {
    if (!mediaCache.has(url)) {
      mediaCache.set(url, fetch(url, { signal }).then(async response => {
        if (!response.ok) throw new Error('幻灯片内的图片或字体无法读取。');
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      }));
    }
    return mediaCache.get(url);
  }));
  const resolved = new Map();
  for (const url of urls) resolved.set(url, await mediaCache.get(url));
  return svg.replace(reference, (match, url) => match.slice(0, -url.length) + resolved.get(url));
}

function collectSlideTextBoxLines(textObj, bucket) {
  for (const para of textObj?.paragraphs || []) {
    const line = (para.runs || []).map(run => run.text || '').join('').replace(/\s+/g, ' ').trim();
    if (line) bucket.push(line);
  }
}

function walkSlideElementsText(elements, bucket) {
  for (const el of elements || []) {
    if (!el) continue;
    if (el.text) collectSlideTextBoxLines(el.text, bucket);
    if (el.kind === 'table') {
      for (const row of el.rows || []) {
        const cells = (row.cells || []).map(cell => { const c = []; collectSlideTextBoxLines(cell.text, c); return c.join(' '); }).filter(Boolean);
        if (cells.length) bucket.push(cells.join(' | '));
      }
    }
    if (el.children) walkSlideElementsText(el.children, bucket);
    if (el.elements) walkSlideElementsText(el.elements, bucket);
  }
}

function extractSlideMetadata(slide, index) {
  const lines = [];
  walkSlideElementsText(slide?.elements, lines);
  const title = (lines[0] || '').slice(0, 96) || ('第 ' + (index + 1) + ' 页');
  const comments = (slide?.comments || []).map(c => (c.author ? '[' + c.author + '] ' : '') + (c.text || '').trim()).filter(Boolean);
  const speakerNotes = [String(slide?.notes || '').trim(), ...comments].filter(Boolean).join('\n\n');
  return { title, text: lines.join('\n'), speakerNotes };
}

function ensureSvgDimensions(svg, width, height) {
  if (/\bwidth\s*=/.test(svg.slice(0, 220))) return svg;
  return svg.replace(/^<svg\b/, '<svg width="' + Math.round(width || 960) + '" height="' + Math.round(height || 540) + '"');
}

async function svgUrlToPngBlob(url, slideWidth, slideHeight, targetWidth) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = Math.round(targetWidth), h = Math.max(1, Math.round(w * (slideHeight || 540) / (slideWidth || 960)));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function renderFirstPresentationSlideBlob(blob) {
  let parsed, url;
  try {
    const engine = await presentationEngine();
    parsed = await engine.parse(blob);
    if (!parsed?.slides?.length) return null;
    const rawSvg = await embedPresentationMediaCached(engine.renderSlideToSvg(parsed, parsed.slides[0], { textMode: 'svg' }), new Map());
    const svg = ensureSvgDimensions(rawSvg, parsed.width, parsed.height);
    url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    return await svgUrlToPngBlob(url, parsed.width, parsed.height, 384);
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
    parsed?.dispose?.();
  }
}

const PPT_STUDIO_MARKUP = `<div class="ppt-toolbar" role="toolbar" aria-label="演示文稿工具栏">
 <div class="ppt-toolbar-group">
  <button type="button" class="secondary" id="pptToggleFilmstrip" aria-pressed="true" title="显示或收起左侧幻灯片导航栏">目录栏</button>
  <button type="button" class="secondary" id="pptGridToggle" aria-pressed="false" title="鸟瞰全部幻灯片（快捷键 G）">网格总览</button>
  <div class="ppt-search-wrap"><input type="search" id="pptSearchInput" placeholder="搜索幻灯片文字或批注…" aria-label="搜索幻灯片"></div>
 </div>
 <div class="ppt-toolbar-group">
  <div class="ppt-pager-pill">
   <button type="button" id="pptPrevious" aria-label="上一页" disabled>‹</button>
   <input type="number" min="1" value="1" id="pptPageNumber" aria-label="幻灯片页码" disabled>
   <span class="ppt-pager-total" id="pptPageCount" role="status">读取中…</span>
   <button type="button" id="pptNext" aria-label="下一页" disabled>›</button>
  </div>
  <select id="pptZoomSelect" aria-label="缩放比例"><option value="fit">适应窗口</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select>
 </div>
 <div class="ppt-toolbar-group">
  <button type="button" class="secondary" id="pptToggleNotes" aria-pressed="true">批注</button>
  <button type="button" class="secondary" id="pptExportHandout" title="导出整份 PPT 双栏图文复习讲义 (.html)，按住 Shift 点击可导出 Markdown">导出讲义</button>
  <button type="button" class="secondary" id="pptExpand" aria-pressed="true" title="在铺满窗口与浮窗尺寸之间切换">浮窗化</button>
  <button type="button" class="ppt-primary-btn" id="pptFullscreenBtn" title="沉浸全屏放映（快捷键 F）">全屏放映</button>
  <button type="button" class="secondary" id="pptMarkDone">标记已读</button>
 </div>
</div>
<div class="ppt-workspace" id="pptWorkspace">
 <aside class="ppt-filmstrip" id="pptFilmstrip" aria-label="幻灯片缩略图">
  <div class="ppt-filmstrip-head"><span id="pptFilmstripSummary">幻灯片</span><button type="button" class="ppt-filmstrip-filter" id="pptFilterNoted" aria-pressed="false" title="只看写过批注的幻灯片">仅已批注</button></div>
  <div class="ppt-filmstrip-list" id="pptFilmstripList"></div>
 </aside>
 <section class="ppt-center" id="pptCenter">
  <button type="button" class="ppt-edge-nav ppt-edge-prev" id="pptEdgePrev" aria-label="上一页" disabled>‹</button>
  <div class="ppt-stage-viewport" id="pptStageViewport" tabindex="0" aria-label="幻灯片舞台，支持方向键或滚轮翻页，双击图片查看原图">
   <div class="ppt-slide-sheet" id="pptSlideSheet"><p class="section-note" id="pptStageStatus" role="status" style="padding:36px 24px">正在解析演示文稿…</p></div>
  </div>
  <button type="button" class="ppt-edge-nav ppt-edge-next" id="pptEdgeNext" aria-label="下一页" disabled>›</button>
  <div class="ppt-grid-view" id="pptGridView" hidden></div>
  <div class="ppt-fullscreen-note-drawer" id="pptFullscreenNoteDrawer" hidden>
   <div style="display:flex;align-items:center;justify-content:space-between"><strong id="pptFsNoteTitle" style="font-size:12.5px">本页批注</strong><button type="button" class="icon-button" id="pptFsNoteClose" style="color:#eef2ee" aria-label="收起批注">✕</button></div>
   <textarea id="pptFsNoteInput" placeholder="全屏翻阅时随手记录本页要点（自动同步保存）…"></textarea>
  </div>
  <div class="ppt-fullscreen-hud" id="pptFullscreenHud" hidden>
   <button type="button" id="pptFsPrev">‹ 上一页</button><span id="pptFsIndicator">1 / 1</span><button type="button" id="pptFsNext">下一页 ›</button>
   <button type="button" id="pptFsToggleNote">随手批注</button><button type="button" id="pptFsExit">退出全屏</button>
  </div>
 </section>
 <aside class="ppt-notes-panel" id="pptNotesPanel" aria-label="本页批注与讲义">
  <header class="ppt-notes-head"><div class="ppt-notes-meta"><button type="button" class="ppt-note-color-dot" id="pptNoteColorDot" title="切换本页批注标记色" aria-label="切换本页批注标记色"></button><strong id="pptNoteSlideLabel">第 1 页批注</strong></div><span class="tiny" id="pptNoteSaveState">自动保存</span></header>
  <div class="ppt-notes-scroll">
   <div class="ppt-slide-heading-card"><small>当前页主题</small><p id="pptCurrentSlideTitle">正在读取…</p></div>
   <div class="ppt-note-editor-card">
    <div class="ppt-note-tags">
     <button type="button" class="ppt-quick-tag" data-ppt-tag="【核心观点】">核心观点</button>
     <button type="button" class="ppt-quick-tag" data-ppt-tag="【方法公式】">方法公式</button>
     <button type="button" class="ppt-quick-tag" data-ppt-tag="【关键结论】">关键结论</button>
     <button type="button" class="ppt-quick-tag" data-ppt-tag="【待深究】">待深究</button>
    </div>
    <textarea class="ppt-note-textarea" id="pptSlideNoteInput" placeholder="记录这一页的核心论点、公式方法或启发疑问（按页自动保存，支持全库检索与导出讲义）…"></textarea>
   </div>
   <div class="ppt-save-bar" role="group" aria-label="沉淀到记录库"><span>沉淀</span><button type="button" id="pptSaveAsNote" title="连同当前幻灯片截图保存为独立研究笔记">存为研究笔记</button><button type="button" id="pptAppendRecord" title="连同当前幻灯片截图追加到问题课题或实验调研日志">追加到记录</button></div>
   <details class="ppt-ref-box" id="pptSpeakerBox" open hidden><summary><span>原片讲义备注</span><span class="tiny">演讲者备注</span></summary><div class="ppt-ref-body"><pre class="ppt-ref-text" id="pptSpeakerText"></pre></div></details>
   <details class="ppt-ref-box" id="pptSlideTextBox"><summary><span>本页提取文字</span><button type="button" class="link-button" id="pptCopySlideText">复制文字</button></summary><div class="ppt-ref-body"><pre class="ppt-ref-text" id="pptSlideExtractedText"></pre></div></details>
  </div>
 </aside>
</div>`;

async function openPresentationAttachment(file, blob) {
  closeReadingSession();
  if (readerUrl) { URL.revokeObjectURL(readerUrl); readerUrl = null; }
  const dialog = $('reader'), content = $('readerContent');
  dialog.classList.remove('reader-pdf', 'reader-video-expanded');
  dialog.classList.add('reader-presentation', 'reader-enhanced');
  $('readerExpandVideo').hidden = true;
  if (typeof registerReaderTab === 'function') registerReaderTab(file, blob);

  const session = createReadingSession(file, 'presentation');
  readingSession = session;
  $('readerTitle').textContent = file.name;
  readerFile = { id: file.id, name: file.name, blob };
  const { signal } = session.controller;
  content.innerHTML = PPT_STUDIO_MARKUP;

  if (!dialog.open) dialog.showModal();
  if (innerWidth < 980) $('pptWorkspace').classList.add('hide-filmstrip');

  let presentation = null, activePage = 0, revision = 0, slideSvg = '', saveTimer = 0, wheelLock = 0;
  let gridMode = false, onlyNoted = false, pseudoFullscreen = false;
  const mediaCache = new Map(), slideCache = new Map(), blobUrls = new Set();
  let slideMetas = [], thumbObserver = null;

  const cleanup = () => {
    if (saveTimer) flushSlideNote(activePage + 1);
    clearTimeout(saveTimer);
    thumbObserver?.disconnect();
    if (document.fullscreenElement === $('pptCenter')) document.exitFullscreen?.().catch(() => {});
    dialog.classList.remove('reader-presentation', 'reader-presentation-expanded');
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls.clear();
    presentation?.dispose?.();
  };
  signal.addEventListener('abort', cleanup, { once: true });

  const workspace = $('pptWorkspace'), centerPane = $('pptCenter'), viewport = $('pptStageViewport'), sheet = $('pptSlideSheet');
  const previous = $('pptPrevious'), next = $('pptNext'), edgePrev = $('pptEdgePrev'), edgeNext = $('pptEdgeNext');
  const pageInput = $('pptPageNumber'), pageCount = $('pptPageCount'), zoomSelect = $('pptZoomSelect');
  const noteInput = $('pptSlideNoteInput'), fsNoteInput = $('pptFsNoteInput'), colorDot = $('pptNoteColorDot');
  const markDoneBtn = $('pptMarkDone');
  const syncDoneBtn = () => { markDoneBtn.textContent = session.progress.finished ? '标记未读完' : '标记已读'; };
  syncDoneBtn();
  markDoneBtn.onclick = () => {
    session.progress.finished = !session.progress.finished;
    syncDoneBtn();
    persistReading(session);
  };

  $('pptExpand').onclick = event => {
    const enhanced = dialog.classList.toggle('reader-enhanced');
    event.currentTarget.textContent = enhanced ? '浮窗化' : '铺满窗口';
    event.currentTarget.setAttribute('aria-pressed', String(enhanced));
  };
  $('pptToggleFilmstrip').onclick = event => {
    const hidden = workspace.classList.toggle('hide-filmstrip');
    event.currentTarget.setAttribute('aria-pressed', String(!hidden));
  };
  $('pptToggleNotes').onclick = event => {
    const hidden = workspace.classList.toggle('hide-notes');
    event.currentTarget.setAttribute('aria-pressed', String(!hidden));
  };

  function slideNoteRecord(slideNumber) {
    return (session.annotations || []).find(item => item.kind === 'comment' && item.page === slideNumber) || null;
  }

  function notedSlideCount() {
    return new Set((session.annotations || []).filter(item => item.kind === 'comment' && item.note.trim()).map(item => item.page)).size;
  }

  function syncNoteCounts() {
    const count = notedSlideCount();
    $('pptToggleNotes').textContent = count ? '批注 ' + count : '批注';
    if (presentation) {
      $('pptFilmstripSummary').textContent = '共 ' + presentation.slides.length + ' 页' + (count ? ' · 已批注 ' + count : '');
    }
  }

  function flushSlideNote(slideNumber = activePage + 1) {
    if (!presentation || !session.annotations) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    const text = noteInput.value;
    const trimmed = text.trim();
    const existing = slideNoteRecord(slideNumber);
    const meta = slideMetas[slideNumber - 1];
    if (!trimmed) {
      if (!existing) return;
      session.annotations = session.annotations.filter(item => item !== existing);
    } else if (existing) {
      if (existing.note === text && existing.quote === (meta?.title || '')) return;
      existing.note = text.slice(0, 29000);
      existing.quote = (meta?.title || '').slice(0, 500);
    } else {
      session.annotations.push({
        id: crypto.randomUUID(),
        kind: 'comment',
        page: slideNumber,
        quote: (meta?.title || '').slice(0, 500),
        note: text.slice(0, 29000),
        color: colorDot.dataset.color || MARK_COLORS[0],
        rects: [],
        points: [],
        createdAt: new Date().toISOString()
      });
    }
    savePdfMarks(session);
    document.dispatchEvent(new CustomEvent('workspace-search-file-updated', { detail: { profileId: session.profileId, fileId: file.id } }));
    $('pptNoteSaveState').textContent = trimmed ? '已自动保存' : '自动保存';
    syncNoteCounts();
    refreshThumbBadges(slideNumber - 1);
    if (onlyNoted) renderFilmstripAndGrid();
  }

  function renderSlideCached(index) {
    if (slideCache.has(index)) return slideCache.get(index);
    const task = (async () => {
      const engine = await presentationEngine();
      const rawSvg = engine.renderSlideToSvg(presentation, presentation.slides[index], { textMode: 'svg' });
      const svg = ensureSvgDimensions(
        await embedPresentationMediaCached(rawSvg, mediaCache, signal),
        presentation.width,
        presentation.height
      );
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      blobUrls.add(url);
      return { url, svg };
    })().catch(error => {
      slideCache.delete(index);
      throw error;
    });
    slideCache.set(index, task);
    return task;
  }

  function applySlideSizing() {
    if (!presentation) return;
    const mode = zoomSelect.value;
    const sw = presentation.width || 960, sh = presentation.height || 540;
    if (mode === 'fit') {
      viewport.classList.remove('is-zoomed');
      const rect = viewport.getBoundingClientRect();
      const availW = Math.max(240, rect.width - 44), availH = Math.max(160, rect.height - 44);
      const scale = Math.min(availW / sw, availH / sh);
      sheet.style.width = Math.round(sw * scale) + 'px';
      sheet.style.height = Math.round(sh * scale) + 'px';
    } else {
      const factor = Number(mode) || 1;
      viewport.classList.add('is-zoomed');
      sheet.style.width = Math.round(sw * factor) + 'px';
      sheet.style.height = Math.round(sh * factor) + 'px';
    }
  }
  zoomSelect.onchange = applySlideSizing;
  window.addEventListener('resize', () => { if (!signal.aborted) applySlideSizing(); }, { signal });

  // 放大查看细节时支持鼠标按住拖拽平移画布
  let panState = null;
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !viewport.classList.contains('is-zoomed')) return;
    panState = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.classList.add('is-dragging');
    viewport.setPointerCapture(event.pointerId);
  }, { signal });
  viewport.addEventListener('pointermove', event => {
    if (!panState || panState.id !== event.pointerId) return;
    viewport.scrollLeft = panState.left - (event.clientX - panState.x);
    viewport.scrollTop = panState.top - (event.clientY - panState.y);
  }, { signal });
  const endPan = event => {
    if (!panState || panState.id !== event.pointerId) return;
    panState = null;
    viewport.classList.remove('is-dragging');
  };
  viewport.addEventListener('pointerup', endPan, { signal });
  viewport.addEventListener('pointercancel', endPan, { signal });

  function hydrateThumbElement(card) {
    const idx = Number(card.dataset.slideIndex);
    if (!Number.isInteger(idx) || card.dataset.loaded) return;
    card.dataset.loaded = '1';
    renderSlideCached(idx).then(({ url }) => {
      if (signal.aborted || !card.isConnected) return;
      const frame = card.querySelector('.ppt-thumb-frame');
      frame.querySelector('.ppt-thumb-placeholder')?.remove();
      const img = document.createElement('img');
      img.src = url;
      img.alt = '第 ' + (idx + 1) + ' 页缩略图';
      frame.prepend(img);
    }).catch(() => {});
  }

  function refreshThumbBadges(index) {
    const hasNote = !!slideNoteRecord(index + 1)?.note.trim();
    const hasSpeaker = !!slideMetas[index]?.speakerNotes;
    for (const host of [$('pptFilmstripList'), $('pptGridView')]) {
      const card = host.querySelector('[data-slide-index="' + index + '"]');
      if (!card) continue;
      const badges = card.querySelector('.ppt-thumb-badges');
      badges.innerHTML = (hasNote ? '<span class="ppt-thumb-badge is-note">已批注</span>' : '')
        + (hasSpeaker ? '<span class="ppt-thumb-badge is-speaker">讲义</span>' : '');
    }
  }

  function buildSlideThumbCard(index) {
    const meta = slideMetas[index];
    const hasNote = !!slideNoteRecord(index + 1)?.note.trim();
    const hasSpeaker = !!meta?.speakerNotes;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ppt-thumb-card' + (index === activePage ? ' is-active' : '');
    card.dataset.slideIndex = String(index);
    card.innerHTML = '<div class="ppt-thumb-frame"><span class="ppt-thumb-placeholder">' + String(index + 1).padStart(2, '0') + '</span>'
      + '<span class="ppt-thumb-badges">'
      + (hasNote ? '<span class="ppt-thumb-badge is-note">已批注</span>' : '')
      + (hasSpeaker ? '<span class="ppt-thumb-badge is-speaker">讲义</span>' : '')
      + '</span></div>'
      + '<div class="ppt-thumb-meta"><span class="ppt-thumb-index">' + String(index + 1).padStart(2, '0') + '</span>'
      + '<span class="ppt-thumb-title">' + esc(meta?.title || ('第 ' + (index + 1) + ' 页')) + '</span></div>';
    card.onclick = () => {
      if (gridMode) setGridMode(false);
      void showSlide(index);
    };
    return card;
  }

  function matchingSlideIndices() {
    const q = $('pptSearchInput').value.trim().toLowerCase();
    return slideMetas.map((meta, idx) => idx).filter(idx => {
      const note = slideNoteRecord(idx + 1)?.note || '';
      if (onlyNoted && !note.trim()) return false;
      if (!q) return true;
      const meta = slideMetas[idx];
      return [String(idx + 1), meta.title, meta.text, meta.speakerNotes, note].join('\n').toLowerCase().includes(q);
    });
  }

  function renderFilmstripAndGrid() {
    if (!presentation) return;
    thumbObserver?.disconnect();
    const indices = matchingSlideIndices();
    const filmstrip = $('pptFilmstripList'), grid = $('pptGridView');
    filmstrip.replaceChildren();
    grid.replaceChildren();
    thumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        hydrateThumbElement(entry.target);
      }
    }, { rootMargin: '220px' });

    if (!indices.length) {
      const empty = document.createElement('p');
      empty.className = 'ppt-grid-empty';
      empty.textContent = onlyNoted ? '还没有符合条件的已批注幻灯片。' : '没有匹配的幻灯片。';
      filmstrip.append(empty.cloneNode(true));
      grid.append(empty);
      return;
    }
    for (const idx of indices) {
      const stripCard = buildSlideThumbCard(idx);
      filmstrip.append(stripCard);
      thumbObserver.observe(stripCard);
      if (gridMode) {
        const gridCard = buildSlideThumbCard(idx);
        grid.append(gridCard);
        thumbObserver.observe(gridCard);
      }
    }
  }

  function setGridMode(enabled) {
    gridMode = enabled;
    $('pptGridToggle').setAttribute('aria-pressed', String(enabled));
    $('pptGridView').hidden = !enabled;
    viewport.hidden = enabled;
    edgePrev.hidden = edgeNext.hidden = enabled;
    if (enabled) renderFilmstripAndGrid();
    else requestAnimationFrame(applySlideSizing);
  }
  $('pptGridToggle').onclick = () => setGridMode(!gridMode);
  $('pptSearchInput').oninput = () => renderFilmstripAndGrid();
  $('pptFilterNoted').onclick = () => {
    onlyNoted = !onlyNoted;
    $('pptFilterNoted').setAttribute('aria-pressed', String(onlyNoted));
    renderFilmstripAndGrid();
  };

  function syncSidePanelForSlide(index) {
    const slideNumber = index + 1;
    const meta = slideMetas[index] || { title: '第 ' + slideNumber + ' 页', text: '', speakerNotes: '' };
    const existing = slideNoteRecord(slideNumber);
    const color = existing?.color || MARK_COLORS[0];
    colorDot.dataset.color = color;
    colorDot.style.setProperty('--ppt-note-color', color);
    $('pptNoteSlideLabel').textContent = '第 ' + slideNumber + ' 页批注';
    $('pptFsNoteTitle').textContent = '第 ' + slideNumber + ' 页批注';
    $('pptCurrentSlideTitle').textContent = meta.title;
    noteInput.value = existing?.note || '';
    fsNoteInput.value = noteInput.value;
    $('pptNoteSaveState').textContent = existing?.note.trim() ? '已保存' : '自动保存';

    const speakerBox = $('pptSpeakerBox');
    speakerBox.hidden = !meta.speakerNotes;
    $('pptSpeakerText').textContent = meta.speakerNotes;

    const extracted = meta.text || '（此页无独立文本层，主要为图形或位图）';
    $('pptSlideExtractedText').textContent = extracted;
    $('pptCopySlideText').hidden = !meta.text;
  }

  noteInput.addEventListener('input', () => {
    fsNoteInput.value = noteInput.value;
    $('pptNoteSaveState').textContent = '正在保存…';
    clearTimeout(saveTimer);
    const targetSlide = activePage + 1;
    saveTimer = setTimeout(() => flushSlideNote(targetSlide), 350);
  });
  fsNoteInput.addEventListener('input', () => {
    noteInput.value = fsNoteInput.value;
    noteInput.dispatchEvent(new Event('input'));
  });
  colorDot.onclick = () => {
    const currentColor = colorDot.dataset.color || MARK_COLORS[0];
    const nextColor = MARK_COLORS[(MARK_COLORS.indexOf(currentColor) + 1) % MARK_COLORS.length];
    colorDot.dataset.color = nextColor;
    colorDot.style.setProperty('--ppt-note-color', nextColor);
    const rec = slideNoteRecord(activePage + 1);
    if (rec) {
      rec.color = nextColor;
      savePdfMarks(session);
    }
  };
  for (const tagBtn of content.querySelectorAll('[data-ppt-tag]')) {
    tagBtn.onclick = () => {
      const prefix = tagBtn.dataset.pptTag + ' ';
      const prefixWithNewline = noteInput.value && !noteInput.value.endsWith('\n') ? '\n' + prefix : prefix;
      noteInput.setRangeText(prefixWithNewline, noteInput.selectionStart, noteInput.selectionEnd, 'end');
      noteInput.dispatchEvent(new Event('input'));
      noteInput.focus();
    };
  }
  $('pptCopySlideText').onclick = async event => {
    event.preventDefault();
    event.stopPropagation();
    const text = slideMetas[activePage]?.text || '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('已复制第 ' + (activePage + 1) + ' 页文字'); }
    catch { toast('复制失败，请手动选择复制'); }
  };

  async function currentSlideExcerptPayload() {
    flushSlideNote(activePage + 1);
    const slideNumber = activePage + 1;
    const meta = slideMetas[activePage] || { title: '', text: '' };
    const userNote = slideNoteRecord(slideNumber)?.note?.trim() || '';
    let image = null;
    try {
      const { url } = await renderSlideCached(activePage);
      image = await svgUrlToPngBlob(url, presentation.width, presentation.height, Math.min(1440, (presentation.width || 960) * 1.5));
    } catch {}
    const parts = [];
    if (meta.title) parts.push('幻灯片主题：' + meta.title);
    if (userNote) parts.push('本页批注：\n' + userNote);
    else if (meta.text) parts.push('幻灯片内容：\n' + meta.text.slice(0, 1200));
    return { page: slideNumber, rects: [], quote: parts.join('\n\n'), image };
  }

  $('pptSaveAsNote').onclick = async () => {
    try { await savePdfExcerpt(session, await currentSlideExcerptPayload()); }
    catch (error) { toast(error.message); }
  };
  $('pptAppendRecord').onclick = async () => {
    try {
      const payload = await currentSlideExcerptPayload();
      const targetId = await askPdfExcerptTarget();
      if (targetId) await appendPdfExcerpt(session, payload, targetId);
    } catch (error) { toast(error.message); }
  };
  $('pptExportHandout').onclick = async event => {
    try {
      await exportPresentationHandout({
        file, presentation, slideMetas, renderSlideCached, slideNoteRecord,
        flushCurrent: () => flushSlideNote(activePage + 1)
      }, event.shiftKey ? 'md' : 'html');
    } catch (error) { toast(error.message); }
  };

  // 全屏放映控制（兼容原生 Fullscreen API 与受限环境回退）
  const syncFullscreenUi = () => {
    const active = document.fullscreenElement === centerPane || pseudoFullscreen;
    $('pptFullscreenHud').hidden = !active;
    if (!active) $('pptFullscreenNoteDrawer').hidden = true;
    applySlideSizing();
  };
  document.addEventListener('fullscreenchange', syncFullscreenUi, { signal });
  async function toggleFullscreen(force) {
    if (gridMode) setGridMode(false);
    const active = document.fullscreenElement === centerPane || pseudoFullscreen;
    const nextState = typeof force === 'boolean' ? force : !active;
    if (nextState) {
      try {
        if (centerPane.requestFullscreen) await centerPane.requestFullscreen();
        else pseudoFullscreen = true;
      } catch {
        pseudoFullscreen = true;
      }
      workspace.classList.toggle('hide-filmstrip', pseudoFullscreen || workspace.classList.contains('hide-filmstrip'));
    } else {
      pseudoFullscreen = false;
      if (document.fullscreenElement === centerPane) await document.exitFullscreen().catch(() => {});
    }
    syncFullscreenUi();
  }
  $('pptFullscreenBtn').onclick = () => void toggleFullscreen();
  $('pptFsExit').onclick = () => void toggleFullscreen(false);
  $('pptFsToggleNote').onclick = () => {
    const drawer = $('pptFullscreenNoteDrawer');
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) fsNoteInput.focus();
  };
  $('pptFsNoteClose').onclick = () => { $('pptFullscreenNoteDrawer').hidden = true; };

  async function showSlide(index) {
    if (signal.aborted || !presentation) return;
    if (saveTimer) flushSlideNote(activePage + 1);
    activePage = Math.max(0, Math.min(presentation.slides.length - 1, index));
    const slideNumber = activePage + 1, total = presentation.slides.length, version = ++revision;
    session.page = slideNumber;
    session.progress.pages = total;
    if (slideNumber === total) { session.progress.finished = true; syncDoneBtn(); }
    scheduleReadingSave(session);

    pageInput.value = String(slideNumber);
    pageCount.textContent = '/ ' + total + ' 页';
    $('pptFsIndicator').textContent = slideNumber + ' / ' + total;
    const atStart = activePage === 0, atEnd = slideNumber === total;
    previous.disabled = edgePrev.disabled = $('pptFsPrev').disabled = atStart;
    next.disabled = edgeNext.disabled = $('pptFsNext').disabled = atEnd;

    for (const host of [$('pptFilmstripList'), $('pptGridView')]) {
      for (const card of host.querySelectorAll('.ppt-thumb-card')) {
        const current = Number(card.dataset.slideIndex) === activePage;
        card.classList.toggle('is-active', current);
        if (current && host === $('pptFilmstripList')) card.scrollIntoView({ block: 'nearest' });
      }
    }
    syncSidePanelForSlide(activePage);
    sheet.setAttribute('aria-busy', 'true');
    applySlideSizing();

    try {
      const { url, svg } = await renderSlideCached(activePage);
      if (signal.aborted || revision !== version) return;
      const image = new Image();
      image.alt = file.name + ' · 第 ' + slideNumber + ' 页';
      image.src = url;
      await image.decode();
      if (signal.aborted || revision !== version) return;
      sheet.replaceChildren(image);
      slideSvg = svg;
      // 空闲预热前后相邻页，保证连续翻页零白屏等待
      for (const neighbor of [activePage + 1, activePage - 1]) {
        if (neighbor >= 0 && neighbor < total && !slideCache.has(neighbor)) {
          setTimeout(() => { if (!signal.aborted) renderSlideCached(neighbor).catch(() => {}); }, 24);
        }
      }
    } catch {
      if (!signal.aborted && revision === version) {
        const fallback = document.createElement('p');
        fallback.className = 'section-note';
        fallback.style.padding = '32px 24px';
        fallback.textContent = '这一页暂时无法渲染矢量画面，仍可在右侧查看提取文字或记录批注。';
        sheet.replaceChildren(fallback);
      }
    } finally {
      if (revision === version) sheet.removeAttribute('aria-busy');
    }
  }
  session.showPage = page => showSlide((Math.round(Number(page)) || 1) - 1);

  previous.onclick = edgePrev.onclick = $('pptFsPrev').onclick = () => void showSlide(activePage - 1);
  next.onclick = edgeNext.onclick = $('pptFsNext').onclick = () => void showSlide(activePage + 1);
  pageInput.onchange = () => void showSlide((Math.round(Number(pageInput.value)) || 1) - 1);

  viewport.addEventListener('wheel', event => {
    if (zoomSelect.value !== 'fit' || event.ctrlKey || Math.abs(event.deltaY) < 18) return;
    const now = performance.now();
    if (now - wheelLock < 160) return;
    wheelLock = now;
    event.preventDefault();
    void showSlide(activePage + (event.deltaY > 0 ? 1 : -1));
  }, { passive: false, signal });

  viewport.addEventListener('dblclick', event => {
    event.preventDefault();
    const image = sheet.querySelector('img');
    if (!image || sheet.getAttribute('aria-busy') === 'true') return;
    const original = presentationPictureAt(slideSvg, image, event);
    openPresentationPicture(original || image.src, original ? '幻灯片原始配图 · 第 ' + (activePage + 1) + ' 页' : '幻灯片大图 · 第 ' + (activePage + 1) + ' 页');
  }, { signal });

  dialog.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select,[contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && pseudoFullscreen) { event.preventDefault(); event.stopPropagation(); void toggleFullscreen(false); return; }
    if (event.key === 'f' || event.key === 'F') { event.preventDefault(); void toggleFullscreen(); return; }
    if (event.key === 'g' || event.key === 'G') { event.preventDefault(); setGridMode(!gridMode); return; }
    if (event.key === ' ' && event.target.closest('button')) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? (presentation?.slides.length || 1) - 1
      : activePage + (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key) ? 1 : -1);
    void showSlide(target);
  }, { signal });

  try {
    const [engine, storedMarks] = await Promise.all([
      presentationEngine(),
      fileAnnotations(session.profileId, file).catch(() => [])
    ]);
    if (signal.aborted) return;
    session.annotations = storedMarks;
    const parsed = await engine.parse(blob);
    if (signal.aborted) { parsed.dispose?.(); return; }
    presentation = parsed;
    if (!presentation.slides.length) throw new Error('文件中没有可预览的幻灯片。');

    slideMetas = presentation.slides.map((slide, idx) => extractSlideMetadata(slide, idx));
    if (typeof savePresentationSearchIndex === 'function') {
      void savePresentationSearchIndex(session.profileId, file.id, slideMetas).catch(() => {});
    }
    pageInput.disabled = false;
    pageInput.max = String(presentation.slides.length);
    session.progress.pages = presentation.slides.length;
    syncNoteCounts();
    renderFilmstripAndGrid();

    const resumeIndex = Math.max(0, Math.min(presentation.slides.length - 1, (session.progress.page || 1) - 1));
    await showSlide(resumeIndex);
    persistReading(session);
  } catch (error) {
    if (signal.aborted) return;
    pageCount.textContent = '无法读取';
    const status = $('pptStageStatus');
    if (status) {
      status.textContent = error.name === 'PasswordRequiredError'
        ? '此演示文稿受密码保护。请解密后重新导入，或导入导出的 PDF。'
        : '无法解析这份演示文稿。请确认文件完整，或导入导出的 PDF。';
    }
  }
}
