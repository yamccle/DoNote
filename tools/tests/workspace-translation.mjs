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
              baiduConfigured: req.provider === 'baidu' || Boolean(req.appId),
              baiduId: req.appId || '20261128002724674',
              baiduQpsMode: req.baiduQpsMode === 'pro' ? 'pro' : 'standard',
              baiduCustomDict: req.baiduCustomDict === 'true',
              azureConfigured: req.provider === 'azure',
              openaiBaseUrl: req.openaiBaseUrl || 'https://api.deepseek.com',
              openaiModel: req.openaiModel || 'deepseek-chat',
              openaiConcurrency: Number(req.openaiConcurrency) || 8,
              localModel: 'large',
              localConfigured: true,
              localModelKeys: { large: 'qwen3-4b' }
            });
            window.qaRelease.post({ type: 'translation-response', id: req.id });
          });
        } else if (req.action === 'test') {
          queueMicrotask(() => {
            window.qaRelease.post({
              type: 'translation-response',
              id: req.id,
              value: '✓ 连接可用（0.3s）：太赫兹平面天线实现了低欧姆损耗。'
            });
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
      if (message?.type === 'donote-ai-hub') {
        queueMicrotask(() => {
          const mockState = {
            providers: [
              { id: 'prov-ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', hasKey: true, isLocal: false, maskedKey: 'sk-ab••••cdef' },
              { id: 'prov-qw', name: '通义千问 · 百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-vl-max', hasKey: true, isLocal: false, maskedKey: 'sk-qw••••9988' }
            ],
            primaryProviderId: 'prov-ds',
            translateMode: 'cloud',
            translateProviderId: '',
            translateModel: '',
            translateConcurrency: 8,
            localModel: 'large',
            reader: { providerId: '', model: 'deepseek-reasoner' },
            vision: { providerId: 'prov-qw', model: 'qwen-vl-max' },
            subtitle: { providerId: '', model: '' },
            summaries: {
              translate: 'DeepSeek · deepseek-chat',
              reader: 'DeepSeek · deepseek-reasoner',
              vision: '通义千问 · 百炼 · qwen-vl-max',
              subtitle: 'DeepSeek · deepseek-chat'
            }
          };
          if (message.action === 'resolve') {
            const map = {
              reader: { providerId: 'prov-ds', providerName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner', key: 'sk-secret-ds' },
              vision: { providerId: 'prov-qw', providerName: '通义千问 · 百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', key: 'sk-secret-qw' },
              subtitle: { providerId: 'prov-ds', providerName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', key: 'sk-secret-ds' }
            };
            window.qaRelease.post({ type: 'donote-ai-hub-result', id: message.id, config: map[message.scene] || map.reader });
          } else {
            window.qaRelease.post({ type: 'donote-ai-hub-result', id: message.id, state: mockState, message: '✓ 连接正常（0.3s · deepseek-chat）' });
          }
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
        mode: 'fast',
        source: { fileId: 'f-test', page: 1, name: 'Terahertz.pdf' },
        onProgress: text => progresses.push(text),
        onParagraph: text => paragraphs.push(text)
      });
      const pageOut2 = await doc.translate(2, {
        preference: 'openai',
        mode: 'fast',
        source: { fileId: 'f-test', page: 2, name: 'Terahertz.pdf' }
      });
      doc.close();
      const pdf2zhTasks = window.DoNoteTasks.list().filter(item => String(item.id).startsWith('pdf2zh:'));

      const bbOut = await window.BilingualBook.pair(
        [{ id: '0', type: 'para', text: 'Low-power SAR ADC' }],
        { translate: true, preference: 'openai', onPair: pair => pairs.push(pair) }
      );

      const onlineText = await translatePdfOnline(' Terahertz FSS ', 'en', 'zh', new AbortController().signal, () => {}, 'ctx', 'openai');
      const onlineText2 = await translatePdfOnline(' Dielectric loss ', 'en', 'zh', new AbortController().signal, () => {}, 'ctx', 'openai');
      const testConnMsg = await window.desktopTranslation.request({
        action: 'test',
        provider: 'openai',
        openaiBaseUrl: 'https://api.deepseek.com',
        openaiModel: 'deepseek-chat',
        openaiConcurrency: '8',
        key: ''
      });
      document.getElementById('openTranslationSettings')?.click();
      const keyPlaceholder = document.getElementById('translationKey')?.placeholder || '';
      const keyLabel = document.getElementById('translationKeyLabelText')?.textContent || '';
      document.getElementById('translationSettings')?.close();

      await window.desktopAiHub.open('vision');
      const hubCardCount = document.querySelectorAll('#aiHubProviderList .ai-hub-provider-card').length;
      const hubCardText = document.getElementById('aiHubProviderList')?.innerText || '';
      const hubHasLegacyTranslateSelect = Boolean(document.getElementById('aiHubTranslateMode'));
      document.getElementById('aiProviderHubDialog')?.close();

      await window.desktopTranslation.request({
        action: 'save',
        provider: 'baidu',
        appId: '20261128002724674',
        baiduQpsMode: 'pro',
        baiduCustomDict: 'true',
        key: 'baidu-test-key'
      });
      const baiduProviderAfterSave = window.desktopTranslation.provider();
      const baiduQpsAfterSave = window.desktopTranslation.baiduQpsMode();
      const baiduCacheKey = window.desktopTranslation.modelCacheKey('api');
      const baiduOnlineText = await translatePdfOnline('Low phase noise in phase-locked loop with $x_0$', 'en', 'zh', new AbortController().signal, () => {}, 'ctx', 'baidu');
      await window.desktopTranslation.request({
        action: 'save',
        provider: 'openai',
        openaiBaseUrl: 'https://api.deepseek.com',
        openaiModel: 'deepseek-chat',
        openaiConcurrency: '8',
        key: 'sk-test'
      });

      const resolvedReader = await getAiModelConfig('prof-hub-test', 'reader');
      const resolvedVision = await getAiModelConfig('prof-hub-test', 'vision');
      const normEndpoint1 = aiEndpoint('https://api.deepseek.com');
      const normEndpoint2 = aiEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1');

      return {
        provider: window.desktopTranslation.provider(),
        openaiConfigured: window.desktopTranslation.openaiConfigured(),
        cacheKey: window.desktopTranslation.modelCacheKey('openai'),
        baiduProviderAfterSave,
        baiduQpsAfterSave,
        baiduCacheKey,
        baiduOnlineText,
        hubHasLegacyTranslateSelect,
        blobSize: pageOut.blob.size,
        expectedSize: outBytes.byteLength,
        progresses,
        paragraphs,
        pairsCount: pairs.length,
        bbTranslation: bbOut.pairs[0]?.translation,
        onlineText,
        onlineText2,
        testConnMsg,
        keyPlaceholder,
        keyLabel,
        hubCardCount,
        hubCardText,
        resolvedReaderModel: resolvedReader?.model,
        resolvedVisionModel: resolvedVision?.model,
        normEndpoint1,
        normEndpoint2,
        pdf2zhTaskCount: pdf2zhTasks.length,
        pdf2zhTaskPage: pdf2zhTasks[0]?.page,
        pdf2zhTaskState: pdf2zhTasks[0]?.state
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
  assert.equal(result.onlineText2, '[openai] 译： Dielectric loss ');
  assert.ok(result.testConnMsg.includes('连接可用'));
  assert.ok(result.keyPlaceholder.includes('密钥已保存'));
  assert.ok(result.keyLabel.includes('已加密保存'));
  assert.equal(result.hubCardCount, 2);
  assert.equal(result.hubHasLegacyTranslateSelect, false);
  assert.equal(result.baiduProviderAfterSave, 'baidu');
  assert.equal(result.baiduQpsAfterSave, 'pro');
  assert.equal(result.baiduCacheKey, 'api:baidu:dict');
  assert.equal(result.baiduOnlineText, '[baidu] 译：Low 相位噪声 in 锁相环 with $x_0$');
  assert.ok(result.hubCardText.includes('sk-ab••••cdef'));
  assert.equal(result.resolvedReaderModel, 'deepseek-reasoner');
  assert.equal(result.resolvedVisionModel, 'qwen-vl-max');
  assert.equal(result.normEndpoint1, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(result.normEndpoint2, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(result.pdf2zhTaskCount, 1);
  assert.equal(result.pdf2zhTaskPage, 2);
  assert.equal(result.pdf2zhTaskState, 'done');
  console.log('PASS desktop translation bridges: PdfMathTranslate, BilingualBook and OpenAI provider');
}
