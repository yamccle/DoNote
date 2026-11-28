/**
 * [INPUT]: 读取 #aiProviderHubDialog 控件、设置中心大模型场景胶囊与 WebView2 宿主 donote-ai-hub 消息。
 * [OUTPUT]: 暴露 window.desktopAiHub，专管生成式大模型（LLM / VLM）凭证增删测速与「PDF 问答 / 视频视觉 / 字幕精译」场景模型分配。
 * [POS]: 桌面端 AI 大模型服务商中心控制器，与「翻译服务设置」（百度/微软专用翻译 API 等）正交解耦并支持按需提供复用密钥。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
  const host = location.origin === 'https://yams-one.example' ? window.chrome?.webview : null;
  const dialog = document.getElementById('aiProviderHubDialog');
  if (host && dialog) {
    const PRESETS = {
      deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', needKey: true },
      qwen: { name: '通义千问 · 百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needKey: true },
      siliconflow: { name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', needKey: true },
      openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true },
      kimi: { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', needKey: true },
      ollama: { name: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b', needKey: false }
    };

    const pending = new Map();
    let hubState = null;
    let loadingPromise = null;
    const el = id => document.getElementById(id);

    function hubRequest(payload, timeoutMs = 30000) {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('AI 大模型中心响应超时，请重试。'));
        }, timeoutMs);
        pending.set(id, data => {
          clearTimeout(timer);
          pending.delete(id);
          if (data?.error) reject(new Error(data.error));
          else resolve(data);
        });
        try { host.postMessage({ type: 'donote-ai-hub', id, ...payload }); }
        catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
      });
    }

    const refreshFromHost = (timeoutMs = 8000) => hubRequest({ action: 'read' }, timeoutMs)
      .then(res => { if (res?.state) applyHubState(res.state, false); return hubState; });

    const ensureLoaded = () => hubState ? Promise.resolve(hubState)
      : (loadingPromise ??= refreshFromHost(6000).finally(() => { loadingPromise = null; }));

    function refreshSettingsPaneSummary() {
      const s = hubState;
      if (!s) return;
      const count = s.providers?.length || 0;
      const summaryEl = el('settingsAiHubSummary');
      if (summaryEl) {
        summaryEl.textContent = count
          ? `已加密保存 ${count} 个大模型服务商 · 一次填 Key 供 PDF 问答、视频视觉与字幕共用`
          : '管理 DeepSeek、通义千问、OpenAI 或本机 Ollama 密钥（专用翻译 API 在上方「翻译服务设置」独立配置）';
      }
      const setPill = (id, text) => { const node = el(id); if (node) node.textContent = text || '未配置'; };
      setPill('settingsSceneReader', s.summaries?.reader || '未配置');
      setPill('settingsSceneVision', s.summaries?.vision || '未配置');
      setPill('settingsSceneSubtitle', s.summaries?.subtitle || '未配置');
    }

    function populateProviderSelect(selectEl, inheritLabel, selectedId) {
      if (!selectEl) return;
      const providers = hubState?.providers || [];
      selectEl.replaceChildren();
      if (inheritLabel) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = inheritLabel;
        selectEl.append(opt);
      }
      for (const p of providers) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name}（${p.defaultModel}）`;
        selectEl.append(opt);
      }
      selectEl.value = [...selectEl.options].some(o => o.value === selectedId) ? selectedId : (selectEl.options[0]?.value || '');
    }

    function openProviderEditor(prov = null, preset = null) {
      const editor = el('aiHubProviderEditor');
      editor.hidden = false;
      el('aiHubProvStatus').textContent = '';
      el('aiHubProvId').value = prov?.id || '';
      el('aiHubProvName').value = prov?.name || preset?.name || '';
      el('aiHubProvUrl').value = prov?.baseUrl || preset?.baseUrl || '';
      el('aiHubProvModel').value = prov?.defaultModel || preset?.model || '';
      el('aiHubProvKey').value = '';
      if (prov?.hasKey) {
        el('aiHubProvKeyLabel').textContent = `API Key（✓ 已保存 ${prov.maskedKey}，留空保留）`;
        el('aiHubProvKey').placeholder = '•••••••• 留空保留原密钥，输入新值可替换';
      } else if (prov?.isLocal || preset?.needKey === false) {
        el('aiHubProvKeyLabel').textContent = 'API Key（本机服务可留空）';
        el('aiHubProvKey').placeholder = '本机 Ollama / vLLM 无需密钥可留空';
      } else {
        el('aiHubProvKeyLabel').textContent = 'API Key';
        el('aiHubProvKey').placeholder = '请输入 API Key（如 sk-...）';
      }
      el('aiHubEditorTitle').textContent = prov ? ('编辑大模型服务商 · ' + prov.name) : '添加大模型服务商';
      (preset ? el('aiHubProvKey') : el('aiHubProvName')).focus();
    }

    function renderProviderList() {
      const box = el('aiHubProviderList');
      const providers = hubState?.providers || [];
      box.replaceChildren();
      if (!providers.length) {
        const empty = document.createElement('p');
        empty.className = 'ai-hub-empty';
        empty.textContent = '尚未添加生成式大模型服务商。如需使用 PDF 精读问答、视频看图助教或大模型翻译，可点击上方「+ DeepSeek / + 通义千问」等预设添加（若仅使用百度/微软专用翻译 API，无需在此添加）。';
        box.append(empty);
        return;
      }
      for (const p of providers) {
        const isPrimary = p.id === hubState.primaryProviderId;
        const card = document.createElement('div');
        card.className = 'ai-hub-provider-card' + (isPrimary ? ' is-primary' : '');
        const info = document.createElement('div');
        info.className = 'ai-hub-prov-info';
        const title = document.createElement('div');
        title.className = 'ai-hub-prov-title';
        const strong = document.createElement('strong');
        strong.textContent = p.name;
        title.append(strong);
        if (isPrimary) {
          const b = document.createElement('span');
          b.className = 'ai-hub-badge is-ok';
          b.textContent = '默认首选';
          title.append(b);
        }
        const keyBadge = document.createElement('span');
        keyBadge.className = 'ai-hub-badge' + (p.hasKey || p.isLocal ? ' is-ok' : '');
        keyBadge.textContent = p.hasKey ? ('✓ 密钥 ' + p.maskedKey) : (p.isLocal ? '✓ 本机免密' : '未填密钥');
        title.append(keyBadge);

        const sub = document.createElement('div');
        sub.className = 'ai-hub-prov-sub';
        sub.textContent = `默认模型：${p.defaultModel}　·　接口：${p.baseUrl}`;
        info.append(title, sub);

        const actions = document.createElement('div');
        actions.className = 'ai-hub-prov-actions';
        const mkBtn = (label, cls, fn) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = cls + ' settings-mini-btn';
          btn.textContent = label;
          btn.onclick = fn;
          return btn;
        };
        actions.append(
          mkBtn('测试', 'secondary', async ev => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            btn.textContent = '测速中…';
            try {
              const res = await hubRequest({ action: 'test-provider', provider: { id: p.id, baseUrl: p.baseUrl, defaultModel: p.defaultModel, apiKey: '' } });
              el('aiHubRoutingStatus').textContent = `${p.name}：${res.message || '✓ 连接正常'}`;
            } catch (err) {
              el('aiHubRoutingStatus').textContent = `${p.name} 测试未通过：${err.message}`;
            } finally {
              btn.disabled = false;
              btn.textContent = '测试';
            }
          }),
          mkBtn('编辑', 'secondary', () => openProviderEditor(p))
        );
        if (!isPrimary) {
          actions.append(mkBtn('设为首选', 'secondary', async () => {
            try {
              el('aiHubPrimaryProvider').value = p.id;
              await saveRouting(false);
              toast('已设为首选大模型服务商：' + p.name);
            } catch (err) { el('aiHubRoutingStatus').textContent = err.message; }
          }));
        }
        actions.append(mkBtn('删除', 'secondary is-danger', async () => {
          if (!confirm(`确定删除大模型服务商「${p.name}」吗？`)) return;
          try {
            const res = await hubRequest({ action: 'delete-provider', providerId: p.id });
            if (res?.state) applyHubState(res.state, true);
            toast('已删除服务商：' + p.name);
          } catch (err) { el('aiHubRoutingStatus').textContent = err.message; }
        }));
        card.append(info, actions);
        box.append(card);
      }
    }

    function renderHubDialog() {
      const s = hubState;
      if (!s) return;
      renderProviderList();
      populateProviderSelect(el('aiHubPrimaryProvider'), s.providers?.length ? '' : '暂未添加服务商', s.primaryProviderId || '');
      const primaryObj = (s.providers || []).find(p => p.id === s.primaryProviderId);
      const followPrimary = primaryObj ? `跟随首选（${primaryObj.name} · ${primaryObj.defaultModel}）` : '跟随首选服务商';

      populateProviderSelect(el('aiHubReaderProvider'), followPrimary, s.reader?.providerId || '');
      el('aiHubReaderModel').value = s.reader?.model || '';

      populateProviderSelect(el('aiHubVisionProvider'), '同 PDF 文献问答（或单独指定多模态服务商）', s.vision?.providerId || '');
      el('aiHubVisionModel').value = s.vision?.model || '';

      populateProviderSelect(el('aiHubSubtitleProvider'), followPrimary, s.subtitle?.providerId || '');
      el('aiHubSubtitleModel').value = s.subtitle?.model || '';

      const transBridge = el('aiHubTransBridgeInfo');
      if (transBridge) {
        const curTrans = window.desktopTranslation?.label?.() || '本地或专用翻译服务';
        transBridge.textContent = `当前文献与划词翻译引擎：${curTrans}（与问答模型互不覆盖）`;
      }
    }

    function applyHubState(nextState, broadcast = false) {
      hubState = nextState;
      refreshSettingsPaneSummary();
      if (dialog.open) renderHubDialog();
      if (broadcast) {
        window.dispatchEvent(new CustomEvent('donote-ai-hub-change', { detail: nextState }));
      }
    }

    host.addEventListener('message', event => {
      const data = event.data;
      if (data?.type === 'donote-ai-hub-result') {
        pending.get(data.id)?.(data);
      } else if (data?.type === 'donote-ai-hub-state' && data.state) {
        applyHubState(data.state, false);
      }
    });

    function currentEditorPayload() {
      return {
        id: el('aiHubProvId').value.trim(),
        name: el('aiHubProvName').value.trim(),
        baseUrl: el('aiHubProvUrl').value.trim(),
        defaultModel: el('aiHubProvModel').value.trim(),
        apiKey: el('aiHubProvKey').value.trim()
      };
    }

    async function saveEditorProviderIfComplete() {
      const editor = el('aiHubProviderEditor');
      if (editor.hidden) return false;
      const payload = currentEditorPayload();
      const isLocalLoopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(payload.baseUrl);
      if (!payload.baseUrl || !payload.defaultModel || (!payload.apiKey && !payload.id && !isLocalLoopback)) {
        return false;
      }
      const res = await hubRequest({ action: 'save-provider', provider: payload });
      el('aiHubProvKey').value = '';
      editor.hidden = true;
      if (res?.state) applyHubState(res.state, true);
      return true;
    }

    async function saveRouting(closeAfter = true) {
      const btn = el('aiHubSaveRoutingBtn');
      btn.disabled = true;
      el('aiHubRoutingStatus').textContent = '';
      try {
        await saveEditorProviderIfComplete();
        const s = hubState || {};
        const routing = {
          primaryProviderId: el('aiHubPrimaryProvider').value,
          translateMode: s.translateMode || 'localai',
          translateProviderId: s.translateProviderId || '',
          translateModel: s.translateModel || '',
          translateConcurrency: String(s.translateConcurrency || 8),
          localModel: s.localModel || 'large',
          readerProviderId: el('aiHubReaderProvider').value,
          readerModel: el('aiHubReaderModel').value.trim(),
          visionProviderId: el('aiHubVisionProvider').value,
          visionModel: el('aiHubVisionModel').value.trim(),
          subtitleProviderId: el('aiHubSubtitleProvider').value,
          subtitleModel: el('aiHubSubtitleModel').value.trim()
        };
        const res = await hubRequest({ action: 'save-routing', routing });
        if (res?.state) applyHubState(res.state, true);
        if (closeAfter) {
          dialog.close();
          toast('大模型场景分配已保存');
        }
      } catch (err) {
        el('aiHubRoutingStatus').textContent = err.message || '保存失败，请检查填写项。';
        throw err;
      } finally {
        btn.disabled = false;
      }
    }

    async function openHubDialog(focusScene = '') {
      el('aiHubRoutingStatus').textContent = '';
      el('aiHubProvStatus').textContent = '';
      el('aiHubProviderEditor').hidden = true;
      if (hubState) renderHubDialog();
      if (!dialog.open) dialog.showModal();
      await refreshFromHost(8000).catch(() => {});
      renderHubDialog();
      dialog.querySelectorAll('.ai-hub-scene-card').forEach(card => {
        card.classList.toggle('is-highlighted', !!focusScene && card.dataset.sceneBox === focusScene);
      });
      if (focusScene && hubState?.providers?.length) {
        dialog.querySelector(`[data-scene-box="${focusScene}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    el('openAiHubDialog').onclick = () => void openHubDialog();
    el('aiHubOpenTransDialogBtn').onclick = () => { dialog.close(); el('openTranslationSettings')?.click(); };
    document.querySelectorAll('[data-hub-scene]').forEach(pill => {
      pill.addEventListener('click', event => {
        event.stopPropagation();
        const settingsPanel = el('desktopSettings');
        if (settingsPanel?.matches(':popover-open')) settingsPanel.hidePopover();
        void openHubDialog(pill.dataset.hubScene);
      });
    });

    dialog.querySelectorAll('[data-ai-preset]').forEach(chip => {
      chip.onclick = () => {
        const preset = PRESETS[chip.dataset.aiPreset];
        if (preset) openProviderEditor(null, preset);
      };
    });
    el('aiHubShowAddBtn').onclick = () => openProviderEditor(null, null);
    el('aiHubProvCancelBtn').onclick = () => { el('aiHubProvKey').value = ''; el('aiHubProviderEditor').hidden = true; };

    el('aiHubProvTestBtn').onclick = async () => {
      const testBtn = el('aiHubProvTestBtn'), saveBtn = el('aiHubProvSaveBtn');
      testBtn.disabled = true; saveBtn.disabled = true;
      el('aiHubProvStatus').textContent = '正在实测接口响应…';
      try {
        const res = await hubRequest({ action: 'test-provider', provider: currentEditorPayload() });
        el('aiHubProvStatus').textContent = res.message || '✓ 连接正常。';
      } catch (err) {
        el('aiHubProvStatus').textContent = err.message || '连接测试失败。';
      } finally {
        testBtn.disabled = false; saveBtn.disabled = false;
      }
    };

    el('aiHubProvSaveBtn').onclick = async () => {
      const saveBtn = el('aiHubProvSaveBtn'), testBtn = el('aiHubProvTestBtn');
      saveBtn.disabled = true; testBtn.disabled = true;
      el('aiHubProvStatus').textContent = '';
      try {
        const payload = currentEditorPayload();
        const res = await hubRequest({ action: 'save-provider', provider: payload });
        el('aiHubProvKey').value = '';
        el('aiHubProviderEditor').hidden = true;
        if (res?.state) applyHubState(res.state, true);
        toast('已保存大模型服务商：' + (payload.name || payload.baseUrl));
      } catch (err) {
        el('aiHubProvStatus').textContent = err.message || '保存服务商失败。';
      } finally {
        saveBtn.disabled = false; testBtn.disabled = false;
      }
    };

    el('aiHubSaveRoutingBtn').onclick = () => void saveRouting(true).catch(() => {});
    dialog.querySelectorAll('[data-close-ai-hub]').forEach(btn => btn.onclick = () => dialog.close());
    dialog.addEventListener('close', () => { el('aiHubProvKey').value = ''; });

    window.desktopAiHub = {
      open: scene => openHubDialog(scene),
      ready: ensureLoaded,
      refresh: refreshFromHost,
      getState: () => hubState,
      summaryLabel(scene = 'reader') {
        if (!hubState) return '';
        return hubState.summaries?.[scene] || hubState.summaries?.reader || '';
      },
      async resolveProviderKey(providerId) {
        const res = await hubRequest({ action: 'resolve-provider', providerId }, 6000).catch(() => null);
        return res?.config?.key || '';
      },
      async resolve(scene = 'reader') {
        if (!hubState) await refreshFromHost(6000).catch(() => {});
        const res = await hubRequest({ action: 'resolve', scene }, 8000);
        const cfg = res?.config;
        if (!cfg?.baseUrl || !cfg?.model) return null;
        return { base: cfg.baseUrl, model: cfg.model, key: cfg.key || '', providerName: cfg.providerName || '' };
      }
    };

    void ensureLoaded().catch(() => {});
  }
}
