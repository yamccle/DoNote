/**
 * [INPUT]: 读取 PDF 原始字节流、结构化段落列表与 WebView2 桌面宿主消息通道。
 * [OUTPUT]: 提供 wellFormedText、window.BilingualBook 双语配对桥与 window.PdfMathTranslate 整页分块流式翻译桥。
 * [POS]: PDF 文档级翻译底层 IPC 协议桥，按文档维度聚合并同步后台任务中心状态。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

function wellFormedText(value) {
  const text = String(value ?? '').replace(/\0/g, '');
  let clean = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { clean += text[index] + text[index + 1]; index++; continue; }
      clean += '\uFFFD'; continue;
    }
    clean += code >= 0xDC00 && code <= 0xDFFF ? '\uFFFD' : text[index];
  }
  return clean;
}

const pdf2zhPending = new Map();
const pdf2zhSources = new Map();
const pdf2zhActiveDocReq = new Map();
function pdf2zhTaskKey(id) {
  const source = pdf2zhSources.get(id);
  return 'pdf2zh:doc:' + (source?.fileId || source?.docId || id);
}
function pdf2zhTaskPatch(id) {
  const source = pdf2zhSources.get(id);
  return {
    fileId: source?.fileId || null,
    page: source?.page || null,
    title: source?.name ? source.name + ' · 整页翻译' : 'PDF 整页双语翻译'
  };
}
const bilingualPairPending = new Map();
const pdf2zhChunkSize = 256 * 1024;
const pdf2zhUploadWindow = 4;
function pdf2zhKey(type, id, seq = '') { return type + ':' + id + ':' + seq; }
function pdf2zhEncode(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}
function pdf2zhDecode(encoded) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(encoded);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function pdf2zhRequest(host, message, response, signal, timeout = 60000) {
  signal?.throwIfAborted();
  const key = pdf2zhKey(response, message.id, response === 'ack' ? message.seq ?? -1 : '');
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      pdf2zhPending.delete(key);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('整页翻译响应超时，请重试。')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    pdf2zhPending.set(key, finish);
    try { host.postMessage(message); } catch (error) { finish(error); }
  });
}
if (window.chrome?.webview) {
  window.chrome.webview.addEventListener('message', event => {
    const data = event.data;
    if (data?.type === 'bilingual-pair-progress') {
      bilingualPairPending.get(data.id)?.onPair(data.pair);
      return;
    }
    if (data?.type === 'bilingual-pair-result') {
      const entry = bilingualPairPending.get(data.id);
      if (!entry) return;
      bilingualPairPending.delete(data.id);
      if (data.error) entry.finish(new Error(data.error)); else entry.finish(null, data);
      return;
    }
    if (['pdf2zh-progress', 'pdf2zh-paragraph', 'pdf2zh-output'].includes(data?.type)) {
      pdf2zhPending.get(data.type + ':' + data.id)?.(data);
      if (data.type === 'pdf2zh-progress' && window.DoNoteTasks && pdf2zhSources.has(data.id)) {
        const taskKey = pdf2zhTaskKey(data.id);
        if (!pdf2zhActiveDocReq.has(taskKey) || pdf2zhActiveDocReq.get(taskKey) === data.id) {
          window.DoNoteTasks.upsert(taskKey, {
            kind: 'translate',
            ...pdf2zhTaskPatch(data.id),
            detail: data.status || data.message || data.stage || '正在排版与翻译文档…',
            percent: Number.isFinite(data.percent) ? data.percent : null,
            state: 'running'
          });
        }
      }
      return;
    }
    if (data?.type === 'pdf2zh-result' && window.DoNoteTasks && pdf2zhSources.has(data.id)) {
      const taskKey = pdf2zhTaskKey(data.id);
      if (!pdf2zhActiveDocReq.has(taskKey) || pdf2zhActiveDocReq.get(taskKey) === data.id) {
        const patch = pdf2zhTaskPatch(data.id);
        const pageLabel = patch.page ? `第 ${patch.page} 页` : '整页';
        window.DoNoteTasks.upsert(taskKey, {
          kind: 'translate',
          ...patch,
          detail: data.error ? ('翻译未完成：' + data.error) : (pageLabel + '双语对照翻译已完成，点击打开文档'),
          percent: data.error ? null : 100,
          state: data.error ? 'error' : 'done'
        });
      }
    }
    if (!['pdf2zh-ack', 'pdf2zh-ready', 'pdf2zh-result'].includes(data?.type)) return;
    const resultType = data.type.slice('pdf2zh-'.length);
    const key = pdf2zhKey(resultType, data.id, resultType === 'ack' ? data.seq : '');
    const finish = pdf2zhPending.get(key);
    if (data.error && !finish) {
      const pending = [...pdf2zhPending].find(([name]) => name.startsWith('ack:' + data.id + ':') || name === pdf2zhKey('ready', data.id));
      pending?.[1](new Error(data.error));
    } else {
      finish?.(data.error ? new Error(data.error) : null, data);
    }
  });
}
window.BilingualBook = {
  available: !!window.chrome?.webview,
  pair(blocks, { translate = false, preference = 'large', source = 'en', target = 'zh', glossary = null, signal, onPair = () => {}, timeout = 13 * 60 * 1000 } = {}) {
    const host = window.chrome?.webview;
    if (!host) return Promise.reject(new Error('智能排版翻译只在 DoNote 桌面版中可用。'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = crypto.randomUUID();
    const cleanBlocks = blocks.map(({ id: blockId, type, level, text, translation }) => ({
      id: wellFormedText(blockId), type: wellFormedText(type), level, text: wellFormedText(text), translation: wellFormedText(translation)
    }));
    const cleanGlossary = Array.isArray(glossary) ? glossary.slice(0, 500) : null;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); bilingualPairPending.delete(id); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const cancel = error => { finish(error); try { host.postMessage({ type: 'bilingual-pair-cancel', id }); } catch {} };
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(new Error('智能排版翻译响应超时。')), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      bilingualPairPending.set(id, { finish, onPair });
      try { host.postMessage({ type: 'bilingual-pair', id, blocks: cleanBlocks, translate, preference, source, target, glossary: cleanGlossary }); }
      catch (error) { finish(error); }
    });
  }
};
window.PdfMathTranslate = {
  available: !!window.chrome?.webview,
  async open(blob, { signal, onProgress = () => {} } = {}) {
    const host = window.chrome?.webview;
    if (!host) throw new Error('整页对照翻译需要 DoNote 桌面版。');
    if (!(blob instanceof Blob) || !blob.size) throw new Error('PDF 原件不可用。');
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const documentController = new AbortController();
    const documentSignal = documentController.signal;
    const send = (type, values, response, timeout, requestSignal = documentSignal) =>
      pdf2zhRequest(host, { type: 'pdf2zh-' + type, id, ...values }, response, requestSignal, timeout);
    const close = () => {
      if (documentSignal.aborted) return;
      documentController.abort(signal?.reason);
      signal?.removeEventListener('abort', close);
      try { host.postMessage({ type: 'pdf2zh-close', id }); } catch {}
    };
    signal?.addEventListener('abort', close, { once: true });
    try {
      await send('open', { size: blob.size }, 'ack');
      let previousPercent = -1;
      const count = Math.ceil(blob.size / pdf2zhChunkSize);
      for (let first = 0; first < count; first += pdf2zhUploadWindow) {
        documentSignal.throwIfAborted();
        const last = Math.min(count, first + pdf2zhUploadWindow);
        const chunks = await Promise.all(Array.from({ length: last - first }, async (_, index) => {
          const offset = (first + index) * pdf2zhChunkSize;
          return new Uint8Array(await blob.slice(offset, offset + pdf2zhChunkSize).arrayBuffer());
        }));
        documentSignal.throwIfAborted();
        await Promise.all(chunks.map((bytes, index) =>
          send('chunk', { seq: first + index, data: pdf2zhEncode(bytes) }, 'ack', 120000)));
        const percent = Math.round(Math.min(last * pdf2zhChunkSize, blob.size) / blob.size * 100);
        if (percent !== previousPercent) onProgress('正在准备 PDF · ' + percent + '%');
        previousPercent = percent;
      }
      await send('ready', {}, 'ready');
    } catch (error) {
      close();
      throw error;
    }
    return {
      close,
      async translate(page, { preference, mode = 'full', glossary = null, silentTask = false, signal: pageSignal, onProgress: onPageProgress = () => {}, onParagraph = () => {}, source } = {}) {
        const requestSignal = pageSignal ? AbortSignal.any([documentSignal, pageSignal]) : documentSignal;
        requestSignal.throwIfAborted();
        const requestId = crypto.randomUUID();
        if (!silentTask) {
          pdf2zhSources.set(requestId, { ...(source || {}), docId: id, page });
          const taskKey = pdf2zhTaskKey(requestId);
          pdf2zhActiveDocReq.set(taskKey, requestId);
          if (window.DoNoteTasks) {
            window.DoNoteTasks.upsert(taskKey, {
              kind: 'translate',
              ...pdf2zhTaskPatch(requestId),
              detail: '正在准备第 ' + page + ' 页…',
              percent: null,
              state: 'running'
            });
          }
        }
        const parts = [];
        let bytes = 0;
        let invalidOutput = false;
        const progressKey = 'pdf2zh-progress:' + requestId;
        const paragraphKey = 'pdf2zh-paragraph:' + requestId;
        const outputKey = 'pdf2zh-output:' + requestId;
        pdf2zhPending.set(progressKey, data => onPageProgress(data.status));
        pdf2zhPending.set(paragraphKey, data => { if (typeof data.text === 'string') onParagraph(data.text); });
        pdf2zhPending.set(outputKey, data => {
          if (data.seq !== parts.length || typeof data.data !== 'string') {
            invalidOutput = true;
            return;
          }
          try {
            const chunk = pdf2zhDecode(data.data);
            bytes += chunk.byteLength;
            parts.push(chunk);
          } catch {
            invalidOutput = true;
          }
        });
        try {
          const safeMode = mode === 'fast' ? 'fast' : 'full';
          const cleanGlossary = Array.isArray(glossary) ? glossary.slice(0, 500) : null;
          const result = await send('translate', { id: requestId, documentId: id, start: page, end: page, preference, mode: safeMode, glossary: cleanGlossary },
            'result', 26 * 60 * 1000, requestSignal);
          if (invalidOutput || result.start !== page || bytes !== result.size || !bytes) {
            throw new Error('译文 PDF 接收不完整，请重试。');
          }
          return {
            blob: new Blob(parts, { type: 'application/pdf' }),
            untranslated: result.untranslatedPages?.includes(page) || false,
            skippedParagraphs: Number(result.skippedParagraphs) || 0,
          };
        } catch (error) {
          if (!silentTask && requestSignal.aborted) {
            const taskKey = pdf2zhTaskKey(requestId);
            if (pdf2zhActiveDocReq.get(taskKey) === requestId) {
              pdf2zhActiveDocReq.delete(taskKey);
              window.DoNoteTasks?.remove?.(taskKey);
            }
          }
          if (!documentSignal.aborted) {
            try { host.postMessage({ type: 'pdf2zh-cancel-page', id: requestId, documentId: id }); } catch {}
          }
          throw error;
        } finally {
          pdf2zhPending.delete(progressKey);
          pdf2zhPending.delete(paragraphKey);
          pdf2zhPending.delete(outputKey);
          pdf2zhSources.delete(requestId);
        }
      },
    };
  }
};
