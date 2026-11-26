/**
 * [INPUT]: 读取当前 PDF 阅读会话和 PdfMathTranslate 整页翻译。
 * [OUTPUT]: 安装原文与译文对照，并把正在翻译的文件编号交给任务中心。
 * [POS]: PDF 阅读器里的整页对照。完成后从任务中心点回这份文档。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';


function installPdfPageComparison(session, {button, layout, originalBar, tools, bar, leaveReflow}) {
  if (!window.PdfMathTranslate?.available) {
    button.hidden = true;
    return;
  }

  const view = document.createElement('section');
  view.className = 'pdf-page-comparison';
  view.setAttribute('aria-label', '整页对照翻译');
  view.hidden = true;
  view.innerHTML = '<header class="pdf-compare-toolbar">'
    + '<button type="button" class="secondary" data-return>返回 PDF</button>'
    + '<div class="pdf-toolbar-group" role="group" aria-label="对照翻页">'
    + '<button type="button" class="secondary" data-prev aria-label="对照上一页">‹</button>'
    + '<input type="number" min="1" step="1" aria-label="对照页码"><span data-total></span>'
    + '<button type="button" class="secondary" data-next aria-label="对照下一页">›</button></div>'
    + '<select aria-label="对照缩放"></select>'
    + '<select aria-label="对照翻译模型"><option value="offline">快速离线</option>'
    + '<option value="gguf">本地大模型</option></select>'
    + '<span role="status"></span><button type="button" class="secondary" data-retry hidden>重试</button></header>'
    + '<div class="pdf-compare-scroll" tabindex="0" aria-label="原文与译文页面">'
    + '<div class="pdf-compare-pages"><div class="pdf-compare-captions"><span>原始 PDF</span>'
    + '<span>中文译文</span></div><div class="pdf-compare-stack"></div></div></div>';
  layout.after(view);
  const get = selector => view.querySelector(selector);
  const scroll = get('.pdf-compare-scroll');
  const pages = get('.pdf-compare-pages');
  const stack = get('.pdf-compare-stack');
  const input = get('input');
  const [zoom, engine] = view.querySelectorAll('select');
  addPdfZoomOptions(zoom);
  const status = get('[role="status"]');
  const retry = get('[data-retry]');
  const prev = get('[data-prev]');
  const next = get('[data-next]');
  const total = session.pdf.numPages;
  input.max = String(total);
  get('[data-total]').textContent = '/ ' + total + ' 页';

  let state = null;
  let starting = false;
  let scrollFrame = 0;
  const memo = new Map();
  let memoBytes = 0;
  const memoLimit = 80 * 1024 * 1024;

  function remember(key, result) {
    if (result.blob.size > memoLimit) return;
    forget(key);
    memo.set(key, result);
    memoBytes += result.blob.size;
    while (memo.size > 8 || memoBytes > memoLimit) forget(memo.keys().next().value);
  }

  function forget(key) {
    memoBytes -= memo.get(key)?.blob.size || 0;
    memo.delete(key);
  }

  const enginePreferenceKey = 'donote.pdf.comparison.engine';

  function createTranslation(run, choice) {
    const settings = window.desktopTranslation;
    const preference = choice === 'offline' ? 'offline' : settings?.localModelPreference?.() || 'large';
    const modelKey = choice === 'offline' ? 'offline-ct2-v2' : settings?.modelCacheKey?.(preference) || preference;
    return {
      preference, records: new Map(),
      key(number) { return JSON.stringify([run.fingerprint, modelKey, 'pdf2zh-full-v2-en-zh', number]); }
    };
  }

  function translationRecord(run, number) {
    const records = run.translation.records;
    if (!records.has(number)) records.set(number, {number, phase: 'checking', paragraphs: []});
    return records.get(number);
  }

  function position(run) {
    const row = run.rows[run.page - 1];
    return {
      page: run.page,
      scroll: Math.max(0, Math.min(1, (scroll.scrollTop - row.offsetTop) / Math.max(1, row.offsetHeight)))
    };
  }

  function adjustWidth(run) {
    if (!scroll.clientWidth) return;
    const heightChanged = run.height !== scroll.clientHeight;
    if (heightChanged) {
      run.height = scroll.clientHeight;
      pages.style.setProperty('--compare-window-height', run.height + 'px');
    }
    const fit = Math.max(152, (scroll.clientWidth - 36) / 2);
    const width = Math.round(fit * (Number(zoom.value) || 1));
    if (width === run.width) {
      if (heightChanged) refresh(run);
      return;
    }
    const anchor = position(run);
    run.width = width;
    pages.style.setProperty('--compare-page-width', width + 'px');
    scroll.scrollTop = run.rows[anchor.page - 1].offsetTop + run.rows[anchor.page - 1].offsetHeight * anchor.scroll;
    for (const slot of run.mounted.values()) drawSlot(run, slot);
    refresh(run);
  }

  function indexAt(run, offset) {
    let first = 0;
    let last = run.rows.length - 1;
    while (first < last) {
      const middle = Math.ceil((first + last) / 2);
      if (run.rows[middle].offsetTop <= offset) first = middle;
      else last = middle - 1;
    }
    return first;
  }

  function placeholder(node, text) {
    const message = document.createElement('p');
    message.className = 'pdf-compare-message';
    message.textContent = text;
    node.replaceChildren(message);
  }

  function updateStatus(run) {
    const slot = run.mounted.get(run.page);
    const record = slot?.record;
    const working = run.job?.record;
    const message = slot?.renderError?.message || (record?.phase === 'pending' && working && working !== record
      ? '第 ' + run.page + ' 页等待翻译 · 正在处理第 ' + working.number + ' 页'
      : record?.status || '正在准备第 ' + run.page + ' 页…');
    if (status.textContent !== message) status.textContent = message;
    retry.hidden = !slot?.renderError && record?.phase !== 'error' && record?.phase !== 'partial';
  }

  function setStatus(run, record, phase, text) {
    record.phase = phase;
    record.status = text;
    if (state === run && run.mounted.get(run.page)?.record === record) updateStatus(run);
  }

  function activeSlot(run, slot) {
    return state === run && run.mounted.get(slot.number) === slot;
  }

  function drawSlot(run, slot) {
    if (!run.width) return;
    for (const [name, pdfPage, node] of [
      ['sourcePaint', slot.sourcePage, slot.source], ['targetPaint', slot.targetPage, slot.target]
    ]) {
      if (!pdfPage) continue;
      const job = slot[name];
      if (job?.width === run.width) continue;
      job?.render.cancel();
      const viewport = pdfPage.getViewport({scale: run.width / pdfPage.getViewport({scale: 1}).width});
      const canvas = createPdfPageCanvas(viewport);
      const render = pdfPage.render({
        canvasContext: canvas.getContext('2d', {alpha: false}),
        viewport,
        transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
      });
      const paint = slot[name] = {render, width: run.width};
      render.promise.then(() => {
        if (activeSlot(run, slot) && slot[name] === paint) node.replaceChildren(canvas);
      }).catch(() => {
        if (!activeSlot(run, slot) || slot[name] !== paint) return;
        if (node === slot.target) {
          slot.targetPaint = null;
          const message = '译文页面无法显示，可重试加载。';
          slot.renderError = {message};
          placeholder(node, message);
          updateStatus(run);
        } else placeholder(node, '暂时无法显示原页。');
      });
    }
  }

  function showError(slot, message) {
    const runtimeError = /ONNXRuntimeError|NCHWc|ReorderOutput/i.test(message);
    if (!slot.snippets?.childElementCount) {
      placeholder(slot.target, runtimeError
        ? 'PDFMathTranslate 的版面分析失败，可重试。'
        : (message && message.length <= 100 ? message : '译文暂不可用，请重试。'));
    }
    if (message && (runtimeError || message.length > 100)) {
      const details = document.createElement('details');
      details.className = 'pdf-compare-error-details';
      const summary = document.createElement('summary');
      summary.textContent = '错误详情';
      const body = document.createElement('pre');
      body.textContent = message;
      details.append(summary, body);
      slot.target.append(details);
    }
  }

  function showSnippet(slot, text) {
    if (!slot.snippets) {
      slot.snippets = document.createElement('div');
      slot.snippets.className = 'pdf-compare-snippets';
      slot.target.replaceChildren(slot.snippets);
    }
    const paragraph = document.createElement('p');
    paragraph.textContent = text.replace(/\{v\d+\}/gi, '［公式］');
    slot.snippets.append(paragraph);
  }

  function markTranslated(run, record, result) {
    const phase = result.untranslated ? (result.skippedParagraphs ? 'error' : 'done') :
      (result.skippedParagraphs ? 'partial' : 'done');
    const message = result.untranslated ? '第 ' + record.number + ' 页未生成中文译文' :
      '已翻译第 ' + record.number + ' 页' +
      (result.skippedParagraphs ? '，' + result.skippedParagraphs + ' 个段落保留原文。' : '');
    record.paragraphs.length = 0;
    record.error = '';
    record.hasResult = true;
    setStatus(run, record, phase, message);
  }

  async function renderTranslation(run, slot, result) {
    if (!activeSlot(run, slot)) return;
    slot.targetPaint?.render.cancel();
    if (slot.task) void slot.task.destroy().catch(() => {});
    slot.targetPaint = slot.targetPage = slot.task = null;
    slot.renderError = null;
    const version = slot.targetVersion = (slot.targetVersion || 0) + 1;
    const stillCurrent = () => activeSlot(run, slot) && slot.targetVersion === version;
    if (result.untranslated) {
      placeholder(slot.target, result.skippedParagraphs ? '本页未生成有效译文。' : '没有可显示的译文。扫描页可先做 OCR。');
      return;
    }
    try {
      const task = await localPdfTask(session.library, result.blob, slot.controller.signal);
      if (!stillCurrent()) {
        await task.destroy().catch(() => {});
        return;
      }
      slot.task = task;
      const translated = await task.promise;
      if (translated.numPages !== 1) throw new Error('译文页数与原页不一致。');
      const translatedPage = await translated.getPage(1);
      if (!stillCurrent()) return;
      slot.targetPage = translatedPage;
      drawSlot(run, slot);
    } catch {
      if (!stillCurrent()) return;
      if (slot.task) void slot.task.destroy().catch(() => {});
      slot.task = null;
      const message = '译文文件无法打开，可重试生成。';
      slot.renderError = {message, invalid: true};
      placeholder(slot.target, message);
      updateStatus(run);
    }
  }

  async function translatePage(run, {record, translation, controller}) {
    const signal = controller.signal;
    const number = record.number;
    const mounted = () => {
      const slot = run.mounted.get(number);
      return state === run && slot?.record === record ? slot : null;
    };
    const progress = text => {
      if (!signal.aborted) setStatus(run, record, 'working', text);
    };
    try {
      if (!run.opening) {
        run.opening = window.PdfMathTranslate.open(run.blob, {
          signal: run.controller.signal,
          onProgress(text) {
            const current = run.job;
            if (current && !current.controller.signal.aborted) setStatus(run, current.record, 'working', text);
          }
        }).catch(error => {
          run.opening = null;
          throw error;
        });
      }
      const document = await run.opening;
      signal.throwIfAborted();
      const result = await document.translate(number, {
        preference: translation.preference,
        signal,
        source: { fileId: session.file?.id, page: number, name: session.file?.name },
        onProgress: progress,
        onParagraph(text) {
          if (signal.aborted || !text?.trim()) return;
          record.paragraphs.push(text);
          const slot = mounted();
          if (slot && !slot.targetPage) showSnippet(slot, text);
          setStatus(run, record, 'working', '第 ' + number + ' 页 · 已显示 ' + record.paragraphs.length + ' 段');
        }
      });
      signal.throwIfAborted();
      const key = translation.key(number);
      remember(key, result);
      const saving = PdfPreviewCache.put('page', key, result).then(() => result);
      record.saving = saving;
      void saving.finally(() => {
        if (record.saving === saving) record.saving = null;
      });
      markTranslated(run, record, result);
      const slot = mounted();
      if (slot) void renderTranslation(run, slot, result);
    } catch (error) {
      if (signal.aborted) {
        record.paragraphs.length = 0;
        const slot = mounted();
        if (slot && !slot.targetPage) {
          slot.snippets = null;
          placeholder(slot.target, '等待翻译…');
        }
        setStatus(run, record, 'pending', '等待翻译第 ' + number + ' 页…');
        return;
      }
      record.error = error?.message || '译文暂不可用，请重试。';
      const slot = mounted();
      if (slot && !slot.targetPage) showError(slot, record.error);
      setStatus(run, record, 'error', '第 ' + number + ' 页翻译失败');
    }
  }

  function queueTranslation(run) {
    if (state !== run) return;
    const current = run.mounted.get(run.page)?.record;
    if (!current) return;
    if (run.job) {
      // Keep useful nearby work, but a newly visible uncached page has priority
      // over a speculative translation several pages away.
      if (current.phase === 'pending' && Math.abs(run.job.record.number - current.number) > 1) {
        run.job.controller.abort();
      }
      return;
    }
    clearTimeout(run.timer);
    const ahead = run.mounted.get(run.page + 1)?.record;
    const canPrefetch = ['done', 'partial'].includes(current.phase);
    const record = current.phase === 'pending' ? current : canPrefetch && ahead?.phase === 'pending' ? ahead : null;
    if (!record) return;
    // Let the visible page start straight away, and defer only speculative work.
    run.timer = setTimeout(() => {
      if (state !== run || run.mounted.get(record.number)?.record !== record || run.job || record.phase !== 'pending') return;
      const job = run.job = {record, translation: run.translation, controller: new AbortController()};
      setStatus(run, record, 'working', '正在准备第 ' + record.number + ' 页…');
      updateStatus(run);
      void translatePage(run, job).finally(() => {
        run.job = null;
        if (state === run) updateStatus(run);
        queueTranslation(run);
      });
    }, record === current ? 0 : 120);
  }

  async function mountTranslation(run, slot) {
    const record = slot.record;
    const key = run.translation.key(slot.number);
    for (const paragraph of record.paragraphs) showSnippet(slot, paragraph);
    if (record.error) showError(slot, record.error);
    else if (!slot.snippets) {
      const message = {working: '正在翻译…', pending: '等待翻译…'}[record.phase];
      placeholder(slot.target, message || '正在读取译文…');
    }
    if (record.phase === 'checking' || record.hasResult) {
      const targetVersion = slot.targetVersion;
      const cached = memo.get(key) || await record.saving || await PdfPreviewCache.get('page', key);
      if (!activeSlot(run, slot) || slot.targetVersion !== targetVersion) return;
      if (cached?.blob instanceof Blob) {
        remember(key, cached);
        if (record.phase === 'checking') markTranslated(run, record, cached);
        void renderTranslation(run, slot, cached);
      } else if (record.phase === 'checking' || record.phase === 'done' || record.phase === 'partial') {
        record.hasResult = false;
        placeholder(slot.target, '等待翻译…');
        setStatus(run, record, 'pending', '等待翻译第 ' + slot.number + ' 页…');
      }
    }
    queueTranslation(run);
  }

  function mount(run, number) {
    if (run.mounted.has(number)) return;
    const row = run.rows[number - 1];
    row.removeAttribute('aria-hidden');
    const source = document.createElement('div');
    const target = document.createElement('div');
    source.dataset.source = '';
    target.dataset.target = '';
    row.append(source, target);
    placeholder(source, '正在打开原页…');
    const slot = {number, source, target, record: translationRecord(run, number), controller: new AbortController()};
    run.mounted.set(number, slot);
    void session.pdf.getPage(number).then(pdfPage => {
      if (!activeSlot(run, slot)) return;
      const viewport = pdfPage.getViewport({scale: 1});
      const offset = run.rows[run.page - 1].offsetTop;
      row.style.setProperty('--compare-page-ratio', viewport.width / viewport.height);
      if (number === total) pages.style.setProperty('--compare-last-ratio', viewport.width / viewport.height);
      if (number < run.page) scroll.scrollTop += run.rows[run.page - 1].offsetTop - offset;
      slot.sourcePage = pdfPage;
      drawSlot(run, slot);
    }).catch(() => {
      if (activeSlot(run, slot)) placeholder(source, '暂时无法显示原页。');
    });
    void mountTranslation(run, slot);
  }

  function unmount(run, slot) {
    run.mounted.delete(slot.number);
    slot.controller.abort();
    slot.sourcePaint?.render.cancel();
    slot.targetPaint?.render.cancel();
    if (slot.task) void slot.task.destroy().catch(() => {});
    const row = run.rows[slot.number - 1];
    row.setAttribute('aria-hidden', 'true');
    row.replaceChildren();
  }

  function refresh(run) {
    if (state !== run || !run.width) return;
    const page = indexAt(run, scroll.scrollTop + 2) + 1;
    const end = indexAt(run, scroll.scrollTop + scroll.clientHeight) + 1;
    const changed = run.page !== page;
    run.page = page;
    if (document.activeElement !== input) input.value = String(page);
    prev.disabled = page === 1;
    next.disabled = page === total;
    const first = Math.max(1, page - 1);
    const last = Math.min(total, Math.max(page + 1, end));
    for (const slot of run.mounted.values()) {
      if (slot.number < first || slot.number > last) unmount(run, slot);
    }
    mount(run, page);
    for (let number = first; number <= last; number++) mount(run, number);
    updateStatus(run);
    queueTranslation(run);
    if (changed) scheduleReadingSave(session);
  }

  function jumpToPage(run, number, fraction = 0) {
    number = Math.min(total, Math.max(1, Math.round(number) || run.page));
    const row = run.rows[number - 1];
    scroll.scrollTo(scroll.scrollLeft, number === 1 && fraction === 0 ? 0 : row.offsetTop + fraction * row.offsetHeight);
    input.value = String(number);
    refresh(run);
  }

  function stop() {
    const run = state;
    if (!run) return;
    state = null;
    clearTimeout(run.timer);
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    run.job?.controller.abort();
    run.controller.abort();
    for (const slot of run.mounted.values()) unmount(run, slot);
    stack.replaceChildren();
  }

  const resize = new ResizeObserver(() => { if (state) adjustWidth(state); });
  resize.observe(scroll);
  zoom.onchange = () => { if (state) adjustWidth(state); };
  scroll.onscroll = () => {
    if (!state || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (state) refresh(state);
    });
  };

  prev.onclick = () => { if (state) jumpToPage(state, state.page - 1); };
  next.onclick = () => { if (state) jumpToPage(state, state.page + 1); };
  input.onchange = () => { if (state) jumpToPage(state, Number(input.value)); };
  input.onkeydown = event => { if (event.key === 'Enter') input.blur(); };
  engine.onchange = () => {
    const run = state;
    if (!run) return;
    try { localStorage.setItem(enginePreferenceKey, engine.value); } catch {}
    if (!run.engines.has(engine.value)) run.engines.set(engine.value, createTranslation(run, engine.value));
    clearTimeout(run.timer);
    run.job?.controller.abort();
    run.translation = run.engines.get(engine.value);
    for (const slot of run.mounted.values()) unmount(run, slot);
    refresh(run);
  };
  retry.onclick = () => {
    const run = state;
    const slot = run?.mounted.get(run.page);
    if (!slot) return;
    if (slot.renderError && !slot.renderError.invalid) {
      slot.renderError = null;
      drawSlot(run, slot);
      updateStatus(run);
      return;
    }
    const record = slot.record;
    if (!slot.renderError && record.phase !== 'error' && record.phase !== 'partial') return;
    if (slot.renderError) {
      slot.renderError = null;
      record.hasResult = false;
      const key = run.translation.key(slot.number);
      forget(key);
      void PdfPreviewCache.delete('page', key);
    }
    record.error = '';
    record.paragraphs.length = 0;
    if (!slot.targetPage) {
      slot.snippets = null;
      placeholder(slot.target, '等待翻译…');
    }
    setStatus(run, record, 'pending', '正在重试第 ' + slot.number + ' 页…');
    queueTranslation(run);
  };

  get('[data-return]').onclick = async () => {
    if (!state) return;
    const anchor = position(state);
    stop();
    view.hidden = true;
    for (const node of [layout, originalBar, tools, bar]) node.hidden = false;
    await session.showPage(anchor.page, anchor.scroll);
    bar.querySelector('#pdfViewMenuToggle')?.focus({preventScroll: true});
  };

  button.onclick = async () => {
    if (state || starting) return;
    starting = true;
    try {
      if (layout.hidden) await leaveReflow();
      session.controller.signal.throwIfAborted();
      const blob = session.sourceBlob;
      if (!blob?.size) {
        toast('PDF 原件尚未就绪。');
        return;
      }
      const viewport = (await session.pdf.getPage(session.page)).getViewport({scale: 1});
      session.controller.signal.throwIfAborted();
      let choice;
      try { choice = localStorage.getItem(enginePreferenceKey); } catch {}
      engine.value = ['offline', 'gguf'].includes(choice) ? choice :
        (window.desktopTranslation?.localConfigured?.() ? 'gguf' : 'offline');
      const fragment = document.createDocumentFragment();
      const rows = Array.from({length: total}, (_, index) => {
        const row = document.createElement('section');
        row.className = 'pdf-compare-row';
        row.setAttribute('aria-label', '第 ' + (index + 1) + ' 页');
        row.setAttribute('aria-hidden', 'true');
        fragment.append(row);
        return row;
      });
      const start = session.page;
      const fraction = session.scroll;
      state = {
        blob, fingerprint: pdfPreviewFingerprint(session), page: start,
        width: 0, rows, mounted: new Map(), engines: new Map(), controller: new AbortController()
      };
      state.translation = createTranslation(state, engine.value);
      state.engines.set(engine.value, state.translation);
      stack.style.setProperty('--compare-default-ratio', viewport.width / viewport.height);
      pages.style.removeProperty('--compare-last-ratio');
      stack.replaceChildren(fragment);
      for (const node of [layout, originalBar, tools, bar]) node.hidden = true;
      view.hidden = false;
      adjustWidth(state);
      jumpToPage(state, start, fraction);
      get('[data-return]').focus({preventScroll: true});
    } catch (error) {
      if (!session.controller.signal.aborted) toast(error.message || '无法打开整页对照。');
    } finally {
      starting = false;
    }
  };

  session.comparisonPosition = () => state ? position(state) : null;
  session.controller.signal.addEventListener('abort', () => {
    stop();
    resize.disconnect();
    memo.clear();
  }, {once: true});
}
