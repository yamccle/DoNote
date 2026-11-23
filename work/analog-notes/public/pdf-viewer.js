'use strict';

let pdfLibraryPromise = null;
const PDF_ZOOM_PERCENTAGES = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 350, 400];

function addPdfZoomOptions(select, percentages = PDF_ZOOM_PERCENTAGES) {
  select.add(new Option('适合宽度', 'fit'));
  for (const percentage of percentages) {
    select.add(new Option(percentage + '%', String(percentage / 100)));
  }
}

async function pdfLibrary() {
  if (!pdfLibraryPromise) {
    pdfLibraryPromise = (async () => {
      const sourceUrl = URL.createObjectURL(new Blob([PDFJS_SOURCE], { type: 'text/javascript' }));
      try {
        const library = await import(sourceUrl);
        library.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([PDFJS_WORKER_SOURCE], { type: 'text/javascript' }));
        return library;
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
    })().catch(error => {
      pdfLibraryPromise = null;
      throw error;
    });
  }
  return pdfLibraryPromise;
}

async function localPdfTask(library, blob, signal) {
  if (blob.size > MAX_PDF_PREVIEW) throw new Error('此 PDF 超过 2 GB，请下载原文件后使用本地阅读器。');
  signal?.throwIfAborted();
  const assets = new URL('pdfjs/', document.baseURI);
  const options = {
    isEvalSupported: false,
    useSystemFonts: true,
    cMapUrl: new URL('cmaps/', assets).href,
    iccUrl: new URL('iccs/', assets).href,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    wasmUrl: new URL('wasm/', assets).href,
  };
  if (blob.size <= MAX_DOCUMENT_PREVIEW) {
    const data = new Uint8Array(await blob.arrayBuffer());
    signal?.throwIfAborted();
    return library.getDocument({ ...options, data });
  }

  // Read only the requested ranges from the local Blob. PDF.js keeps its own worker buffer.
  const range = new library.PDFDataRangeTransport(blob.size, null, true);
  let task;
  let stopped = false;
  range.abort = () => { stopped = true; };
  range.requestDataRange = (start, end) => {
    blob.slice(start, end).arrayBuffer().then(buffer => {
      if (!stopped) range.onDataRange(start, new Uint8Array(buffer));
    }).catch(() => {
      if (!stopped) void task.destroy().catch(() => {});
    });
  };
  task = library.getDocument({ ...options, range, disableStream: true, disableAutoFetch: true });
  return task;
}

function createPdfToolbar(bar, page) {
  const controls = document.createElement('template');
  controls.innerHTML = `
    <div class="pdf-toolbar-group pdf-history-controls" role="group" aria-label="阅读位置历史">
      <button type="button" class="secondary pdf-icon-control" id="pdfHistoryBack" aria-label="返回上一个阅读位置" title="返回上一个阅读位置">←</button>
      <button type="button" class="secondary pdf-icon-control" id="pdfHistoryForward" aria-label="前往下一个阅读位置" title="前往下一个阅读位置">→</button>
    </div>
    <div class="pdf-toolbar-group pdf-page-controls" role="group" aria-label="页码导航">
      <button type="button" class="secondary pdf-icon-control pdf-chevron" id="pdfPrevious" aria-label="上一页" title="上一页">‹</button>
      <input id="pdfPageNumber" type="number" min="1" aria-label="PDF 页码">
      <span id="pdfPageCount">/ … 页</span>
      <button type="button" class="secondary pdf-icon-control pdf-chevron" id="pdfNext" aria-label="下一页" title="下一页">›</button>
    </div>
    <div class="pdf-toolbar-group pdf-zoom-controls" role="group" aria-label="缩放">
      <button type="button" class="secondary pdf-icon-control" id="pdfZoomOut" aria-label="缩小 PDF" title="缩小 PDF">−</button>
      <select id="pdfZoom" aria-label="PDF 缩放比例"></select>
      <button type="button" class="secondary pdf-icon-control" id="pdfZoomIn" aria-label="放大 PDF" title="放大 PDF">＋</button>
    </div>`;
  bar.prepend(controls.content);
  const back = bar.querySelector('#pdfHistoryBack');
  const forward = bar.querySelector('#pdfHistoryForward');
  back.disabled = forward.disabled = true;
  const previous = bar.querySelector('#pdfPrevious');
  const pageNumber = bar.querySelector('#pdfPageNumber');
  const pageCount = bar.querySelector('#pdfPageCount');
  const next = bar.querySelector('#pdfNext');
  const zoomOut = bar.querySelector('#pdfZoomOut');
  const zoom = bar.querySelector('#pdfZoom');
  const zoomIn = bar.querySelector('#pdfZoomIn');
  pageNumber.value = String(page);
  addPdfZoomOptions(zoom);
  const interactive = [previous, pageNumber, next, zoomOut, zoom, zoomIn, bar.querySelector('#markReadingDone')];
  const setEnabled = enabled => {
    for (const control of interactive) control.disabled = !enabled;
  };
  setEnabled(false);
  return { back, forward, previous, pageNumber, pageCount, next, zoomOut, zoom, zoomIn, setEnabled };
}

function showPdfError(scroller, message) {
  const error = document.createElement('p');
  error.className = 'reader-error';
  error.setAttribute('role', 'alert');
  error.textContent = message;
  scroller.replaceChildren(error);
}

function sizePdfPageSlot(slot, viewport) {
  slot.pdfScale = viewport.scale;
  slot.style.width = viewport.width + 'px';
  slot.style.height = viewport.height + 'px';
}

function createPdfPageCanvas(viewport) {
  const { width, height } = viewport;
  // Limit the backing bitmap while retaining the displayed size and text scale.
  const ratio = Math.min(2, devicePixelRatio || 1, 8192 / width, 8192 / height, Math.sqrt(12_000_000 / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  return canvas;
}

function pdfLinkRects(annotation) {
  const points = annotation.quadPoints;
  if (!points?.length || points.length % 8 || !points.every(Number.isFinite)) return [annotation.rect];
  const rectangles = [];
  for (let index = 0; index < points.length; index += 8) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = points.slice(index, index + 8);
    rectangles.push([
      Math.min(x1, x2, x3, x4), Math.min(y1, y2, y3, y4),
      Math.max(x1, x2, x3, x4), Math.max(y1, y2, y3, y4),
    ]);
  }
  return rectangles;
}

function appendPdfLinks(session, page, viewport, slot, isCurrent) {
  void page.getAnnotations({ intent: 'display' }).then(annotations => {
    if (!isCurrent()) return;
    const layer = document.createElement('div');
    layer.className = 'pdf-link-layer';
    for (const annotation of annotations) {
      if (annotation.subtype !== 'Link' || annotation.rect?.length !== 4 || !annotation.rect.every(Number.isFinite)) continue;
      let link;
      if (annotation.dest) {
        link = document.createElement('button');
        link.type = 'button';
        link.title = annotation.titleObj?.str || '跳到 PDF 内的引用';
        link.onclick = () => session.followPdfDestination(annotation.dest);
      } else {
        if (!/^https?:\/\//i.test(annotation.url || '')) continue;
        link = document.createElement('a');
        link.href = annotation.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = annotation.url;
      }
      link.setAttribute('aria-label', link.title);
      let first = true;
      for (const rect of pdfLinkRects(annotation)) {
        const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(rect);
        const left = Math.max(0, Math.min(x0, x1));
        const top = Math.max(0, Math.min(y0, y1));
        const width = Math.min(viewport.width, Math.max(x0, x1)) - left;
        const height = Math.min(viewport.height, Math.max(y0, y1)) - top;
        if (width <= 0 || height <= 0) continue;
        const hit = first ? link : link.cloneNode();
        if (!first) {
          hit.onclick = link.onclick;
          hit.tabIndex = -1;
          hit.setAttribute('aria-hidden', 'true');
        }
        Object.assign(hit.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
        layer.append(hit);
        first = false;
      }
    }
    if (layer.childElementCount) slot.append(layer);
  }).catch(() => {});
}

function pdfDestinationBounds(viewport, target) {
  const [, mode, a, b, c, d] = target;
  const [minX, minY, maxX, maxY] = viewport.viewBox;
  const [startX, startY] = viewport.convertToPdfPoint(0, 0);
  let rect;
  switch (mode?.name) {
    case 'XYZ': {
      const x = Number.isFinite(a) ? a : startX;
      const y = Number.isFinite(b) ? b : startY;
      rect = [x, y, x, y];
      break;
    }
    case 'FitH':
    case 'FitBH':
      if (Number.isFinite(a)) rect = [minX, a, maxX, a];
      break;
    case 'FitV':
    case 'FitBV':
      if (Number.isFinite(a)) rect = [a, minY, a, maxY];
      break;
    case 'FitR':
      if ([a, b, c, d].every(Number.isFinite)) rect = [a, b, c, d];
      break;
    default:
      break;
  }
  if (!rect) return null;
  const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(rect);
  return {
    left: Math.max(0, Math.min(1, Math.min(x0, x1) / viewport.width)),
    right: Math.max(0, Math.min(1, Math.max(x0, x1) / viewport.width)),
    top: Math.max(0, Math.min(1, Math.min(y0, y1) / viewport.height)),
  };
}

function installPdfPageStack(session, toolbar, scroller) {
  const { back, forward, previous, pageNumber, next, zoomOut, zoom, zoomIn } = toolbar;
  const tab = readerTabs.find(item => item.id === session.file.id);
  const history = tab?.pdfHistory || { entries: [], index: -1 };
  if (tab) tab.pdfHistory = history;

  function refreshHistoryButtons() {
    const ready = readingSession === session && !!session.pageBox;
    back.disabled = !ready || history.index <= 0;
    forward.disabled = !ready || history.index >= history.entries.length - 1;
  }

  function currentLocation() {
    if (!session.pageBox) return { page: session.page, scroll: session.scroll };
    // Read the live position, including a scroll event awaiting animation frame.
    const top = scroller.scrollTop - stackTop;
    const index = visiblePageIndex(top + 22);
    const slot = slots[index];
    return {
      page: index + 1,
      scroll: Math.max(0, Math.min(1, (top - slot.offsetTop) / Math.max(1, slot.offsetHeight))),
      left: (scroller.scrollLeft - pageLeft(slot)) / Math.max(1, slot.offsetWidth),
    };
  }
  function pageLeft(slot) {
    return stack.offsetLeft + slot.offsetLeft;
  }
  const stack = document.createElement('div');
  stack.className = 'pdf-stack';
  const renderJobs = new Map();
  let slots = [];
  let viewportWidth = 0;
  let layoutZoom = '';
  let stackTop = 0;
  let lastPageOffset = 0;
  let scrollFrame = 0;
  let navigationVersion = 0;

  function scaleFor(baseWidth) {
    return layoutZoom === 'fit'
      ? Math.max(1, viewportWidth - 48) / baseWidth
      : Number(layoutZoom);
  }

  function updateSlotDimensions(slot, base) {
    const scale = scaleFor(base.width);
    sizePdfPageSlot(slot, { width: base.width * scale, height: base.height * scale, scale });
  }

  function padAfterLastPage() {
    const height = slots[slots.length - 1].offsetHeight;
    stack.style.paddingBottom = Math.max(20, scroller.clientHeight - height * (1 - lastPageOffset)) + 'px';
  }

  function activatePage(number) {
    if (session.pageBox === slots[number - 1] && number === session.page) return;
    session.page = number;
    pageNumber.value = String(number);
    previous.disabled = number === 1;
    next.disabled = number === session.pdf.numPages;
    session.pageBox = slots[number - 1];
    document.dispatchEvent(new CustomEvent('pdf-page-change', { detail: { session, page: number } }));
  }

  async function mountPage(index) {
    const slot = slots[index];
    const job = {};
    renderJobs.set(index, job);
    const isCurrent = () => readingSession === session && renderJobs.get(index) === job;
    try {
      const page = await session.pdf.getPage(index + 1);
      if (!isCurrent()) return;
      slot.pdfBase = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: scaleFor(slot.pdfBase.width) });
      const anchor = currentLocation();
      const active = slots[anchor.page - 1];
      const oldOffset = active.offsetTop + anchor.scroll * active.offsetHeight;
      sizePdfPageSlot(slot, viewport);
      if (index === slots.length - 1) padAfterLastPage();
      if (index <= anchor.page - 1) {
        const delta = active.offsetTop + anchor.scroll * active.offsetHeight - oldOffset;
        if (Math.abs(delta) > .5) scroller.scrollTop += delta;
      }

      const canvas = createPdfPageCanvas(viewport);
      slot.replaceChildren(canvas);
      job.render = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
      });
      await job.render.promise;
      if (!isCurrent()) return;
      job.painted = true;
      appendPdfLinks(session, page, viewport, slot, isCurrent);

      const layer = document.createElement('div');
      layer.className = 'pdf-text-layer textLayer';
      layer.style.setProperty('--scale-factor', viewport.scale);
      layer.style.setProperty('--total-scale-factor', viewport.scale);
      slot.append(layer);
      job.text = new session.library.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
      await job.text.render();
      if (!isCurrent()) return;
      renderPdfMarks(session, slot, index + 1);
    } catch (error) {
      if (!isCurrent()) return;
      if (job.painted) renderPdfMarks(session, slot, index + 1);
      else slot.textContent = '此页显示失败：' + error.message;
    }
  }

  function unmountPage(index, job) {
    renderJobs.delete(index);
    job.render?.cancel();
    job.text?.cancel();
    slots[index].replaceChildren();
  }

  function visiblePageIndex(position) {
    let first = 0;
    let last = slots.length - 1;
    while (first < last) {
      const middle = Math.ceil((first + last) / 2);
      if (slots[middle].offsetTop <= position) first = middle;
      else last = middle - 1;
    }
    return first;
  }

  function refreshVisiblePages() {
    if (scroller.closest('[hidden]')) return;
    if (!slots.length || readingSession !== session) return;
    const top = scroller.scrollTop - stackTop;
    const active = visiblePageIndex(top + 22);
    const bottom = visiblePageIndex(top + scroller.clientHeight);
    if (session.page !== active + 1) {
      activatePage(active + 1);
      session.picked = null;
    }
    const slot = slots[active];
    session.scroll = Math.max(0, Math.min(1, (top - slot.offsetTop) / Math.max(1, slot.offsetHeight)));
    const first = Math.max(0, active - 1);
    const last = Math.min(slots.length - 1, Math.max(active + 2, bottom + 1));
    for (const [index, job] of renderJobs) {
      if (index < first || index > last) unmountPage(index, job);
    }
    if (!renderJobs.has(active)) void mountPage(active);
    for (let index = first; index <= last; index++) {
      if (!renderJobs.has(index)) void mountPage(index);
    }
    scheduleReadingSave(session);
  }

  function updatePageLayout(page) {
    for (const [index, job] of renderJobs) unmountPage(index, job);
    viewportWidth = scroller.clientWidth;
    layoutZoom = zoom.value;
    const base = page.getViewport({ scale: 1 });
    if (!slots.length) {
      const fragment = document.createDocumentFragment();
      slots = Array.from({ length: session.pdf.numPages }, (_, index) => {
        const slot = document.createElement('div');
        slot.className = 'pdf-page';
        slot.dataset.pdfPage = index + 1;
        fragment.append(slot);
        return slot;
      });
      stack.append(fragment);
      scroller.replaceChildren(stack);
    }
    for (const slot of slots) updateSlotDimensions(slot, slot.pdfBase || base);
    stackTop = stack.offsetTop;
  }

  async function showPage(number, restore = 0, historyIndex = null, destination = null) {
    if (!session.pdf || readingSession !== session) return false;
    const version = ++navigationVersion;
    const isCurrent = () => version === navigationVersion && readingSession === session;
    session.restoring = true;
    try {
      let target;
      if (destination !== null) {
        target = typeof destination === 'string' ? await session.pdf.getDestination(destination) : destination;
        if (!isCurrent()) return false;
        if (!Array.isArray(target)) throw new Error('Invalid PDF destination');
        const ref = target[0];
        const index = typeof ref === 'number' ? ref : await session.pdf.getPageIndex(ref);
        if (!isCurrent()) return false;
        if (!Number.isInteger(index) || index < 0 || index >= session.pdf.numPages) throw new Error('Invalid PDF page');
        number = index + 1;
      } else {
        number = Math.min(session.pdf.numPages, Math.max(1, Math.round(number) || 1));
      }
      const page = await session.pdf.getPage(number);
      if (!isCurrent()) return false;
      const origin = slots.length ? currentLocation() : null;
      const base = page.getViewport({ scale: 1 });
      const bounds = target && pdfDestinationBounds(base, target);
      if (bounds) restore = bounds.top;
      else if (target?.[2] === null && ['FitH', 'FitBH'].includes(target[1]?.name)) restore = origin?.scroll || 0;
      if (!slots.length || layoutZoom !== zoom.value ||
          (layoutZoom === 'fit' && viewportWidth !== scroller.clientWidth)) updatePageLayout(page);
      const slot = slots[number - 1];
      slot.pdfBase ||= base;
      updateSlotDimensions(slot, slot.pdfBase);
      lastPageOffset = number === slots.length ? restore : 0;
      padAfterLastPage();
      activatePage(number);
      session.picked = null;
      const context = bounds ? Math.min(8, slot.offsetHeight * .015) : 0;
      const offset = Math.max(0, Math.min(slot.offsetHeight - 5, restore * slot.offsetHeight - context));
      scroller.scrollTop = stackTop + slot.offsetTop + offset;
      const oldLeft = historyIndex === null ? null : history.entries[historyIndex]?.left;
      if (Number.isFinite(oldLeft)) {
        scroller.scrollLeft = pageLeft(slot) + oldLeft * slot.offsetWidth;
      } else if (bounds) {
        const left = pageLeft(slot) + bounds.left * slot.offsetWidth;
        const right = pageLeft(slot) + bounds.right * slot.offsetWidth;
        if (left < scroller.scrollLeft + 12 || right > scroller.scrollLeft + scroller.clientWidth - 12) {
          scroller.scrollLeft = Math.max(0, left - 16);
        }
      }
      const position = currentLocation();
      if (origin && historyIndex !== null) {
        history.entries[history.index] = origin;
        history.index = historyIndex;
      } else if (origin && (number !== origin.page || target &&
          (Math.abs(position.scroll - origin.scroll) > .002 || Math.abs(position.left - origin.left) > .002))) {
        if (history.index < 0) {
          history.entries = [origin];
          history.index = 0;
        } else {
          history.entries[history.index] = origin;
          history.entries.splice(history.index + 1);
        }
        history.entries.push(position);
        if (history.entries.length > 50) history.entries.shift();
        history.index = history.entries.length - 1;
      }
      refreshHistoryButtons();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if (destination !== null) toast('该 PDF 引用无法定位。');
      else if (slots.length) toast('无法显示第 ' + number + ' 页：' + error.message);
      else showPdfError(scroller, '无法显示 PDF 页面：' + error.message);
      return false;
    } finally {
      if (version === navigationVersion) {
        session.restoring = false;
        refreshVisiblePages();
      }
    }
  }

  session.showPage = showPage;
  session.activatePage = activatePage;
  session.pdfPosition = currentLocation;
  session.followPdfDestination = destination => showPage(null, 0, null, destination);
  scroller.onscroll = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!session.restoring && $('reader').open) refreshVisiblePages();
    });
  };
  session.controller.signal.addEventListener('abort', () => {
    cancelAnimationFrame(scrollFrame);
    scroller.onscroll = null;
    for (const [index, job] of renderJobs) unmountPage(index, job);
  }, { once: true });

  function goToHistory(direction) {
    const index = history.index + direction;
    const destination = history.entries[index];
    if (destination) void showPage(destination.page, destination.scroll, index);
  }
  back.onclick = () => goToHistory(-1);
  forward.onclick = () => goToHistory(1);

  previous.onclick = () => showPage(session.page - 1);
  next.onclick = () => showPage(session.page + 1);
  pageNumber.onchange = () => {
    if (!pageNumber.value) pageNumber.value = String(session.page);
    else if (Number(pageNumber.value) !== session.page) showPage(Number(pageNumber.value));
  };
  pageNumber.onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    pageNumber.blur();
  };

  function updateZoomButtons() {
    zoomOut.disabled = zoom.value === '0.25';
    zoomIn.disabled = zoom.value === '4';
  }

  function applyZoom() {
    updateZoomButtons();
    const location = currentLocation();
    return showPage(location.page, location.scroll);
  }

  function stepZoom(direction) {
    const scale = zoom.value === 'fit' ? session.pageBox?.pdfScale || 1 : Number(zoom.value);
    const levels = direction > 0 ? PDF_ZOOM_PERCENTAGES : [...PDF_ZOOM_PERCENTAGES].reverse();
    const percentage = levels.find(value => (value - scale * 100) * direction > .01) ?? (direction > 0 ? 400 : 25);
    zoom.value = String(percentage / 100);
    return applyZoom();
  }

  zoom.onchange = applyZoom;
  zoomOut.onclick = () => stepZoom(-1);
  zoomIn.onclick = () => stepZoom(1);
  return updateZoomButtons;
}

function disposeReadingPdf(session) {
  const task = session.loadingTask;
  session.loadingTask = null;
  void task?.destroy().catch(() => {});
}

async function openPdfAttachment(session, blob, bar, content) {
  session.sourceBlob = blob;
  const toolbar = createPdfToolbar(bar, session.page);
  const scroller = document.createElement('div');
  scroller.className = 'pdf-scroll';
  scroller.id = 'pdfScroll';
  scroller.textContent = '正在打开 PDF…';
  content.append(scroller);
  const updateZoomButtons = installPdfPageStack(session, toolbar, scroller);
  const { signal } = session.controller;
  signal.addEventListener('abort', () => disposeReadingPdf(session), { once: true });

  try {
    session.library = await pdfLibrary();
    const task = await localPdfTask(session.library, blob, signal);
    if (readingSession !== session) {
      await task.destroy();
      return;
    }
    session.loadingTask = task;
    session.pdf = await task.promise;
    if (readingSession !== session) return;

    const pageCount = session.pdf.numPages;
    session.progress.pages = pageCount;
    toolbar.pageCount.textContent = '/ ' + pageCount + ' 页';
    toolbar.pageNumber.max = String(pageCount);
    await enhancePdfReader(session, bar, scroller);
    if (readingSession !== session) return;
    await session.showPage(session.page, session.progress.scroll);
    if (readingSession !== session || !session.pageBox) return;
    toolbar.setEnabled(true);
    toolbar.previous.disabled = session.page === 1;
    toolbar.next.disabled = session.page === pageCount;
    updateZoomButtons();
  } catch (error) {
    if (readingSession !== session) return;
    const message = error.name === 'PasswordException'
      ? '此 PDF 有密码保护，请下载原文件后在本地阅读器中打开。'
      : 'PDF 打开失败，可下载原文件阅读。' + error.message;
    showPdfError(scroller, message);
    disposeReadingPdf(session);
  }
}
