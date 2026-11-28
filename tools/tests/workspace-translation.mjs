/**
 * [INPUT]: 接收已挂载模拟 WebView2 宿主的 Playwright 页面实例。
 * [OUTPUT]: 端到端验证 PdfMathTranslate 整页桥、BilingualBook 双语排版桥与 OpenAI 兼容翻译设置桥。
 * [POS]: 由 test-workspace.mjs 调用的桌面翻译桥回归模块，防止未声明状态表或消息字段失配漏检。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';

export async function testPdfTranslationBridges(page) {
  const result = await page.evaluate(async () => {
    const sampleBytes = new TextEncoder().encode('%PDF-1.4 mock pdf payload');
    const outBytes = new TextEncoder().encode('%PDF-1.4 translated pdf payload');
    const progresses = [];
    const paragraphs = [];
    const pairs = [];

    const origPost = window.chrome.webview.postMessage;
    window.chrome.webview.postMessage = message => {
      origPost(message);
      if (typeof message === 'string' && message.startsWith('translation:')) {
        const req = JSON.parse(message.slice('translation:'.length));
        if (req.action === 'read' || req.action === 'save') {
          queueMicrotask(() => {
            window.qaRelease.post({
              type: 'translation-settings',
              provider: req.provider || 'openai',
              openaiConfigured: true,
              openaiBaseUrl: req.openaiBaseUrl || 'https://api.deepseek.com',
              openaiModel: req.openaiModel || 'deepseek-chat',
              openaiConcurrency: Number(req.openaiConcurrency) || 8,
              localModel: 'large',
              localConfigured: true,
              localModelKeys: { large: 'qwen3-4b' }
            });
            window.qaRelease.post({ type: 'translation-response', id: req.id });
          });
        } else if (req.action === 'translate') {
          queueMicrotask(() => {
            window.qaRelease.post({
              type: 'translation-response',
              id: req.id,
              value: `[${req.provider}] 译：${req.text}`
            });
          });
        }
        return;
      }
      if (message?.type === 'pdf2zh-open') {
        queueMicrotask(() => window.qaRelease.post({ type: 'pdf2zh-ack', id: message.id, seq: -1 }));
        return;
      }
      if (message?.type === 'pdf2zh-chunk') {
        queueMicrotask(() => window.qaRelease.post({ type: 'pdf2zh-ack', id: message.id, seq: message.seq }));
        return;
      }
      if (message?.type === 'pdf2zh-ready') {
        queueMicrotask(() => window.qaRelease.post({ type: 'pdf2zh-ready', id: message.id }));
        return;
      }
      if (message?.type === 'pdf2zh-translate') {
        queueMicrotask(() => {
          window.qaRelease.post({ type: 'pdf2zh-progress', id: message.id, status: '云端大模型并发翻译 · 第 1 页…' });
          window.qaRelease.post({ type: 'pdf2zh-paragraph', id: message.id, text: '第一段译文' });
          const b64 = btoa(String.fromCharCode(...outBytes));
          window.qaRelease.post({ type: 'pdf2zh-output', id: message.id, seq: 0, data: b64 });
          window.qaRelease.post({
            type: 'pdf2zh-result',
            id: message.id,
            start: message.start,
            end: message.end,
            size: outBytes.byteLength,
            untranslatedPages: [],
            skippedParagraphs: 0
          });
        });
        return;
      }
      if (message?.type === 'bilingual-pair') {
        queueMicrotask(() => {
          const outPairs = message.blocks.map(b => ({ id: b.id, source: b.text, translation: '双语译：' + b.text, type: b.type }));
          for (const p of outPairs) {
            window.qaRelease.post({ type: 'bilingual-pair-progress', id: message.id, pair: { id: p.id, translation: p.translation } });
          }
          window.qaRelease.post({ type: 'bilingual-pair-result', id: message.id, pairs: outPairs });
        });
      }
    };

    try {
      await window.desktopTranslation.request({
        action: 'save',
        provider: 'openai',
        openaiBaseUrl: 'https://api.deepseek.com',
        openaiModel: 'deepseek-chat',
        openaiConcurrency: '8',
        key: 'sk-test'
      });

      const doc = await window.PdfMathTranslate.open(new Blob([sampleBytes], { type: 'application/pdf' }), {
        onProgress: text => progresses.push(text)
      });
      const pageOut = await doc.translate(1, {
        preference: 'openai',
        source: { fileId: 'f-test', page: 1, name: 'Terahertz.pdf' },
        onProgress: text => progresses.push(text),
        onParagraph: text => paragraphs.push(text)
      });
      doc.close();

      const bbOut = await window.BilingualBook.pair(
        [{ id: '0', type: 'para', text: 'Low-power SAR ADC' }],
        { translate: true, preference: 'openai', onPair: pair => pairs.push(pair) }
      );

      const onlineText = await translatePdfOnline(' Terahertz FSS ', 'en', 'zh', new AbortController().signal, () => {}, 'ctx', 'openai');

      return {
        provider: window.desktopTranslation.provider(),
        openaiConfigured: window.desktopTranslation.openaiConfigured(),
        cacheKey: window.desktopTranslation.modelCacheKey('openai'),
        blobSize: pageOut.blob.size,
        expectedSize: outBytes.byteLength,
        progresses,
        paragraphs,
        pairsCount: pairs.length,
        bbTranslation: bbOut.pairs[0]?.translation,
        onlineText
      };
    } finally {
      window.chrome.webview.postMessage = origPost;
    }
  });

  assert.equal(result.provider, 'openai');
  assert.equal(result.openaiConfigured, true);
  assert.equal(result.cacheKey, 'openai:deepseek-chat');
  assert.equal(result.blobSize, result.expectedSize);
  assert.ok(result.progresses.includes('云端大模型并发翻译 · 第 1 页…'));
  assert.deepEqual(result.paragraphs, ['第一段译文']);
  assert.equal(result.pairsCount, 1);
  assert.equal(result.bbTranslation, '双语译：Low-power SAR ADC');
  assert.equal(result.onlineText, '[openai] 译： Terahertz FSS ');
  console.log('PASS desktop translation bridges: PdfMathTranslate, BilingualBook and OpenAI provider');
}
