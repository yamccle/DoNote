/**
 * [INPUT]: 读取整页对照退出页码、PdfPreviewCache 缓存层、PdfMathTranslate 桥与任务中心接口。
 * [OUTPUT]: 提供 windowPagesAround、stopCompareBgJob、startCompareBgPrefetch、createCompareTranslationSpec 及对照占位/报错/流式片段渲染函数。
 * [POS]: PDF 整页对照翻译的调度与预缓存状态层，供 pdf-page-comparison.js 调用。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

let activeCompareBgJob = null;

function windowPagesAround(center, maxPage, radius = 5) {
  const pages = [center];
  for (let delta = 1; delta <= radius; delta++) {
    if (center + delta <= maxPage) pages.push(center + delta);
    if (center - delta >= 1) pages.push(center - delta);
  }
  return pages;
}

async function stopCompareBgJob() {
  const job = activeCompareBgJob;
  if (!job) return;
  activeCompareBgJob = null;
  job.abort();
  await job.done.catch(() => {});
}
window.addEventListener('donote-translation-settings-change', () => { void stopCompareBgJob(); });
window.addEventListener('donote-glossary-change', () => { void stopCompareBgJob(); });

function startCompareBgPrefetch({ exitPage, total, translation, opening, blob, docController, fileId, fileName, profileId, fingerprint }) {
  const pages = windowPagesAround(exitPage, total, 5);
  const minP = Math.min(...pages), maxP = Math.max(...pages);
  const taskId = 'pdf2zh:doc:' + (fileId || fingerprint);
  const title = fileName ? fileName + ' · 整页翻译' : 'PDF 整页双语翻译';
  const bgController = new AbortController();
  let userCancelled = false;
  const putTask = patch => window.DoNoteTasks?.upsert?.(taskId, {
    kind: 'translate', fileId: fileId || null, profileId: profileId || null, page: exitPage, title, onCancel: null, ...patch
  });
  const cancel = () => {
    userCancelled = true;
    bgController.abort();
    docController.abort();
    putTask({ detail: '已停止后台预译', percent: null, state: 'cancelled' });
  };
  const done = (async () => {
    try {
      let finished = 0;
      const todo = [];
      for (const p of pages) {
        if (bgController.signal.aborted) return;
        const cached = await PdfPreviewCache.get('page', translation.key(p)).catch(() => null);
        if (cached?.blob instanceof Blob) finished++;
        else todo.push(p);
      }
      if (!todo.length || bgController.signal.aborted) {
        if (!userCancelled) putTask({ detail: `第 ${minP}–${maxP} 页（±5 页）均已预缓存，点击打开文档`, percent: 100, state: 'done' });
        return;
      }
      const doc = await (opening || window.PdfMathTranslate.open(blob, { signal: docController.signal }));
      for (const p of todo) {
        if (bgController.signal.aborted) return;
        putTask({
          page: p, openWhileRunning: true, onCancel: cancel, state: 'running',
          percent: Math.round((finished / pages.length) * 100),
          detail: `后台预译第 ${p} 页（已完成 ${finished} / ${pages.length} · 范围 ${minP}–${maxP} 页）`
        });
        const result = await doc.translate(p, {
          preference: translation.preference, mode: translation.mode, glossary: translation.glossary, silentTask: true,
          signal: bgController.signal, source: { fileId, page: p, name: fileName }
        });
        if (bgController.signal.aborted) return;
        await PdfPreviewCache.put('page', translation.key(p), result).catch(() => {});
        finished++;
      }
      if (!bgController.signal.aborted && !userCancelled) {
        putTask({ detail: `已完成第 ${minP}–${maxP} 页（退出页 ±5 页）预缓存，点击打开文档`, percent: 100, state: 'done' });
      }
    } catch (error) {
      if (!bgController.signal.aborted && !userCancelled) {
        putTask({ detail: '后台预译未完成：' + (error?.message || '请重试'), percent: null, state: 'error' });
      }
    } finally {
      docController.abort();
      if (activeCompareBgJob?.done === done) activeCompareBgJob = null;
    }
  })();
  activeCompareBgJob = { abort: () => { bgController.abort(); docController.abort(); }, done };
}

function createCompareTranslationSpec(run, choice, layoutMode = 'fast', profileId = appState?.activeId) {
  const settings = window.desktopTranslation;
  const mode = layoutMode === 'full' ? 'full' : 'fast';
  const preference = choice === 'offline' ? 'offline' :
    choice === 'api' ? 'api' :
    choice === 'openai' ? 'openai' :
    (['tiny', 'compact', 'large'].includes(choice) ? choice : (settings?.localModelPreference?.() || 'compact'));
  const modelKey = preference === 'offline' ? 'offline-ct2-v2' :
    preference === 'api' ? (settings?.modelCacheKey?.('api') || 'api') :
    preference === 'openai' ? (settings?.modelCacheKey?.('openai') || 'openai') :
    (settings?.modelCacheKey?.(preference) || preference);
  const glossary = typeof circuitGlossary === 'function' ? circuitGlossary(profileId) : null;
  const glossarySig = typeof circuitGlossarySignature === 'function' ? circuitGlossarySignature(profileId) : '';
  return {
    preference, mode, glossary, records: new Map(),
    key(number) { return JSON.stringify([run.fingerprint, modelKey, 'pdf2zh-' + mode + '-v2-en-zh', glossarySig, number]); }
  };
}

function comparePlaceholder(node, text) {
  const message = document.createElement('p');
  message.className = 'pdf-compare-message';
  message.textContent = text;
  node.replaceChildren(message);
}

function compareShowError(slot, message) {
  const runtimeError = /ONNXRuntimeError|NCHWc|ReorderOutput/i.test(message);
  if (!slot.snippets?.childElementCount) {
    comparePlaceholder(slot.target, runtimeError
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

function compareShowSnippet(slot, text) {
  if (!slot.snippets) {
    slot.snippets = document.createElement('div');
    slot.snippets.className = 'pdf-compare-snippets';
    slot.target.replaceChildren(slot.snippets);
  }
  const paragraph = document.createElement('p');
  paragraph.textContent = text.replace(/\{v\d+\}/gi, '［公式］');
  slot.snippets.append(paragraph);
}
