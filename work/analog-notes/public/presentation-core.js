/**
 * [INPUT]: 读取 PPT/PPTX 原始字节流、内嵌或分文件的 ppt-preview-engine.mjs 与幻灯片矢量节点。
 * [OUTPUT]: 提供 fileIsPresentation、presentationEngine、extractSlideMetadata、renderFirstPresentationSlideBlob、SVG 媒体内联栅格化及 PPT_STUDIO_MARKUP 模板。
 * [POS]: 演示文稿底层解析、配图命中测试与缩略封面渲染核心层，供 presentation-preview.js 与资料库画廊调用。
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
