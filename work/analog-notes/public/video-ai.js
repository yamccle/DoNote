/**
 * [INPUT]: 读取当前视频播放会话、实时画面帧、双语字幕时间轴及 reader-ai.js 问答模型配置。
 * [OUTPUT]: 提供 mountVideoAiAssistant，在视频右侧栏挂载多模态与双语字幕感知的 AI 助教问答工作台。
 * [POS]: 视频学习侧栏核心智能增强层，支持画面视觉解析、附近字幕上下文、时间码胶囊跳播与一键沉淀定格/研究笔记。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(function () {
  const VIDEO_AI_PROMPTS = [
    ['解析当前画面与推导', '请结合当前视频画面中的课件图表/公式与附近讲解，深入解析这一部分的核心原理、架构逻辑或数学推导。'],
    ['总结附近 3 分钟要点', '请用条理清晰的中文提炼当前播放时间点前后片段的核心观点、关键术语与结论。'],
    ['梳理全片章节时间轴', '请根据字幕内容梳理本视频的结构化章节大纲，并用 [MM:SS] 标注每个关键节点的时间码。'],
    ['提炼关键方法与局限', '请总结讲解中提到的关键技术方案、设计折中（Trade-off）、误差来源或适用边界。']
  ];

  function formatVideoStamp(sec) {
    const whole = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return h > 0
      ? [h, m, s].map(v => String(v).padStart(2, '0')).join(':')
      : [m, s].map(v => String(v).padStart(2, '0')).join(':');
  }

  function parseStampToSeconds(raw) {
    const parts = String(raw || '').split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function getActiveVideoCues(session) {
    const key = session.profileId + '/' + session.file.id;
    const liveJob = typeof videoSubtitleJobs !== 'undefined' ? videoSubtitleJobs.get(key) : null;
    if (liveJob?.cues?.length) return liveJob.cues;
    const owner = records.find(n => n.id === session.ownerId);
    const saved = owner?.videoSubtitles?.[session.file.id];
    return Array.isArray(saved) ? saved : [];
  }

  function captureCurrentFrameJpeg(video) {
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      return null;
    }
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    return dataUrl.startsWith('data:image/jpeg;base64,') ? dataUrl : null;
  }

  function buildVideoTranscriptContext(session, video, mode) {
    const cues = getActiveVideoCues(session);
    const cur = Number(video?.currentTime) || 0;
    if (!cues.length || mode === 'frame') return '';
    if (mode === 'nearby') {
      const windowCues = cues.filter(c => c.end >= cur - 180 && c.start <= cur + 180);
      const picked = windowCues.length ? windowCues : cues.slice(0, 40);
      return picked
        .map(c => '[' + formatVideoStamp(c.start) + '] ' + [c.en, c.zh].filter(Boolean).join(' / '))
        .join('\n')
        .slice(0, 18000);
    }
    // full outline: sample evenly if very long
    const step = Math.max(1, Math.ceil(cues.length / 240));
    const sampled = [];
    for (let i = 0; i < cues.length; i += step) {
      const c = cues[i];
      sampled.push('[' + formatVideoStamp(c.start) + '] ' + [c.en, c.zh].filter(Boolean).join(' / '));
    }
    return sampled.join('\n').slice(0, 22000);
  }

  function decorateVideoTimestamps(container, video) {
    const stampRe = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('.katex,code,pre,button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) {
      if (/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(walker.currentNode.data)) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const text = node.data;
      stampRe.lastIndex = 0;
      let offset = 0;
      let replaced = false;
      const frag = document.createDocumentFragment();
      for (const m of text.matchAll(stampRe)) {
        const secs = parseStampToSeconds(m[1]);
        if (secs === null || (Number.isFinite(video.duration) && secs > video.duration + 5)) continue;
        frag.append(text.slice(offset, m.index));
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ai-page-chip ai-time-chip';
        chip.textContent = '▶ ' + m[1];
        chip.title = '跳转到视频 ' + m[1];
        chip.onclick = () => {
          video.currentTime = Math.min(secs, Number.isFinite(video.duration) ? video.duration : secs);
        };
        frag.append(chip);
        offset = m.index + m[0].length;
        replaced = true;
      }
      if (replaced) {
        frag.append(text.slice(offset));
        node.replaceWith(frag);
      }
    }
  }

  function renderVideoAiAnswer(container, answer, video, session) {
    renderAiAnswerRich(container, answer, [], session);
    decorateVideoTimestamps(container, video);
  }

  function mountVideoAiAssistant(session, video, sidePanel, saveFrameNoteCallback) {
    if (!sidePanel) return;
    const framesBody = document.createElement('div');
    framesBody.className = 'video-side-pane is-frames';
    while (sidePanel.firstChild) {
      framesBody.append(sidePanel.firstChild);
    }

    const tabBar = document.createElement('div');
    tabBar.className = 'video-side-tabs';
    tabBar.setAttribute('role', 'tablist');
    tabBar.innerHTML =
      '<button type="button" role="tab" data-video-tab="frames" aria-selected="true" class="is-active">定格批注</button>' +
      '<button type="button" role="tab" data-video-tab="ai" aria-selected="false">✦ AI 助教问答</button>';

    const aiPane = document.createElement('div');
    aiPane.className = 'video-side-pane is-ai';
    aiPane.hidden = true;
    aiPane.innerHTML =
      '<div class="video-ai-head">' +
        '<button type="button" class="ai-model-pill" data-video-ai-settings title="配置问答模型地址与密钥"><span class="ai-model-dot" aria-hidden="true"></span><span data-video-ai-model>配置问答模型</span></button>' +
        '<button type="button" class="link-button" data-video-ai-clear>清空</button>' +
      '</div>' +
      '<div class="video-ai-context">' +
        '<div class="video-ai-context-row">' +
          '<select data-video-ai-mode aria-label="视频提问上下文">' +
            '<option value="nearby">附近 ±3 分钟字幕</option>' +
            '<option value="full">全片字幕时间轴</option>' +
            '<option value="frame">仅当前画面解析</option>' +
          '</select>' +
          '<label class="ai-vision-pill" title="截取当前播放画面一并发送给支持视觉的模型，无字幕也能解析课件与电路图">' +
            '<input type="checkbox" data-video-ai-vision checked> 附带当前画面' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="video-ai-scroll" data-video-ai-scroll>' +
        '<div class="reader-ai-empty" data-video-ai-empty>' +
          '<p>可暂停在任意课件页解析电路/公式推导，或结合双语字幕梳理视频脉络：</p>' +
          '<div class="ai-prompt-chips" data-video-ai-chips></div>' +
        '</div>' +
        '<div class="reader-ai-messages" data-video-ai-messages></div>' +
      '</div>' +
      '<div class="video-ai-composer">' +
        '<textarea rows="2" maxlength="6000" data-video-ai-input placeholder="向视频 AI 助教提问（Enter 发送，Shift+Enter 换行）…" aria-label="向视频 AI 提问"></textarea>' +
        '<div class="pdf-ai-send">' +
          '<span class="pdf-panel-help" data-video-ai-status role="status">支持公式排版与 [MM:SS] 点击跳播</span>' +
          '<div class="pdf-ai-send-btns">' +
            '<button type="button" class="secondary" data-video-ai-stop hidden>停止</button>' +
            '<button type="button" class="primary" data-video-ai-ask>发送</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    sidePanel.append(tabBar, framesBody, aiPane);

    const modelBtn = aiPane.querySelector('[data-video-ai-settings]');
    const modelLabel = aiPane.querySelector('[data-video-ai-model]');
    const modeSelect = aiPane.querySelector('[data-video-ai-mode]');
    const visionCheck = aiPane.querySelector('[data-video-ai-vision]');
    const emptyBox = aiPane.querySelector('[data-video-ai-empty]');
    const chipsHost = aiPane.querySelector('[data-video-ai-chips]');
    const msgHost = aiPane.querySelector('[data-video-ai-messages]');
    const inputEl = aiPane.querySelector('[data-video-ai-input]');
    const statusEl = aiPane.querySelector('[data-video-ai-status]');
    const stopBtn = aiPane.querySelector('[data-video-ai-stop]');
    const askBtn = aiPane.querySelector('[data-video-ai-ask]');
    const clearBtn = aiPane.querySelector('[data-video-ai-clear]');

    let history = [];
    let controller = null;
    session.controller.signal.addEventListener('abort', () => controller?.abort(), { once: true });

    function refreshModelBadge() {
      const cfg = typeof aiCredentials !== 'undefined' ? aiCredentials.get(appState?.activeId) : null;
      modelLabel.textContent = cfg?.model || '配置问答模型';
      modelBtn.classList.toggle('is-ready', !!cfg?.model);
    }
    refreshModelBadge();
    void getAiModelConfig(session.profileId).then(refreshModelBadge).catch(() => {});

    tabBar.querySelectorAll('[data-video-tab]').forEach(btn => {
      btn.onclick = () => {
        const isAi = btn.dataset.videoTab === 'ai';
        tabBar.querySelectorAll('[data-video-tab]').forEach(b => {
          const active = b === btn;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-selected', String(active));
        });
        framesBody.hidden = isAi;
        aiPane.hidden = !isAi;
        if (isAi) refreshModelBadge();
      };
    });

    modelBtn.onclick = () => openAiModelSettings();
    document.getElementById('aiModelDialog')?.addEventListener('close', refreshModelBadge);

    for (const [label, prompt] of VIDEO_AI_PROMPTS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-prompt-chip';
      chip.textContent = label;
      chip.onclick = () => {
        inputEl.value = prompt;
        const cfg = aiCredentials.get(session.profileId);
        if (cfg?.model) void askVideoAi(prompt);
        else { openAiModelSettings(); }
      };
      chipsHost.append(chip);
    }

    function syncEmpty() {
      emptyBox.hidden = msgHost.children.length > 0;
    }

    async function saveAsResearchNote(stampSec, question, answer) {
      const owner = records.find(n => n.id === session.ownerId);
      const titleBase = owner?.title || session.file.name.replace(/\.[^.]+$/, '');
      const stamp = formatVideoStamp(stampSec);
      const note = normalizeRichNote({
        id: crypto.randomUUID(),
        type: activeCategory('paper') ? 'paper' : defaultRecordType(),
        title: (titleBase + ' · ' + stamp + ' AI 精读笔记').slice(0, 240),
        date: today(),
        author: owner?.author || '',
        reference: '',
        url: '',
        body: '视频来源：' + titleBase + ' [' + stamp + ']\n提问：' + question + '\n\n' + answer,
        tags: ['视频精读'],
        status: statusOptions.paper?.[0] || '在读',
        pinned: false,
        relatedResources: owner ? [owner.id] : [],
        attachments: []
      });
      await put(note);
      toast('已存为研究笔记', { label: '查看笔记', run: () => showDetail(note.id) });
    }

    function appendVideoExchange({ stampSec, question, answer }) {
      const stamp = formatVideoStamp(stampSec);
      const wrap = document.createElement('div');
      wrap.className = 'ai-exchange';
      const user = document.createElement('div');
      user.className = 'ai-bubble ai-bubble-user';
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'ai-user-page ai-time-chip';
      badge.textContent = '▶ ' + stamp;
      badge.title = '跳回提问时刻 ' + stamp;
      badge.onclick = () => { video.currentTime = stampSec; };
      const qNode = document.createElement('p');
      qNode.className = 'ai-quote';
      qNode.textContent = question;
      user.append(badge, qNode);

      const assistant = document.createElement('div');
      assistant.className = 'ai-bubble ai-bubble-assistant';
      const body = document.createElement('div');
      body.className = 'ai-answer-body rich-content';
      renderVideoAiAnswer(body, answer, video, session);

      const actions = document.createElement('div');
      actions.className = 'ai-actions';
      const mkBtn = (label, fn, danger = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ai-action' + (danger ? ' is-danger' : '');
        b.textContent = label;
        b.onclick = fn;
        return b;
      };
      actions.append(
        mkBtn('复制', async () => {
          try { await navigator.clipboard.writeText(answer); toast('回答已复制'); } catch { toast('请手动选择复制'); }
        }),
        ...(typeof saveFrameNoteCallback === 'function' && session.ownerId ? [
          mkBtn('存为定格批注', async () => {
            try {
              await saveFrameNoteCallback(stampSec, ('【AI 解析】' + answer).slice(0, 1980));
              toast('已存入定格批注（' + stamp + '）');
            } catch (e) { toast(e.message); }
          })
        ] : []),
        mkBtn('存为笔记', () => { void saveAsResearchNote(stampSec, question, answer).catch(e => toast(e.message)); }),
        mkBtn('删除', () => { wrap.remove(); syncEmpty(); }, true)
      );
      assistant.append(body, actions);
      wrap.append(user, assistant);
      msgHost.append(wrap);
      syncEmpty();
      wrap.scrollIntoView({ block: 'nearest' });
    }

    async function sendChatCompletion(config, messages, signal) {
      return fetch(aiEndpoint(config.base), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.key ? { Authorization: 'Bearer ' + config.key } : {})
        },
        body: JSON.stringify({ model: config.model, stream: true, messages }),
        signal
      });
    }

    async function askVideoAi(rawQuestion) {
      if (controller) return;
      const question = String(rawQuestion || '').trim();
      if (!question) { toast('请输入提问内容。'); return; }
      let config;
      try { config = await getAiModelConfig(session.profileId); }
      catch (err) { statusEl.textContent = err.message; return; }
      refreshModelBadge();
      if (!config?.model) {
        statusEl.textContent = '请先配置阅读与视频共用的 AI 模型服务。';
        openAiModelSettings();
        return;
      }

      const stampSec = Math.max(0, Number(video.currentTime) || 0);
      const stamp = formatVideoStamp(stampSec);
      const mode = modeSelect.value;
      const transcript = buildVideoTranscriptContext(session, video, mode);
      const frameDataUrl = visionCheck.checked ? captureCurrentFrameJpeg(video) : null;
      if (!transcript && !frameDataUrl) {
        statusEl.textContent = '当前尚无字幕且画面未就绪：请先播放加载视频帧并勾选「附带当前画面」，或先生成英文字幕。';
        return;
      }

      const owner = records.find(n => n.id === session.ownerId);
      const metaHeader = [
        '视频标题：' + (owner?.title || session.file.name),
        owner?.author ? '主讲人 / 来源：' + owner.author : '',
        '当前播放位置：[' + stamp + ']' + (Number.isFinite(video.duration) ? ' / 总时长 ' + formatVideoStamp(video.duration) : '')
      ].filter(Boolean).join('\n');

      const textPrompt = metaHeader +
        (transcript ? '\n\n以下是视频字幕节选（带时间码）：\n<transcript>\n' + transcript + '\n</transcript>' : '\n\n（当前未提供字幕文本，请重点结合所附视频画面分析）') +
        '\n\n学习者问题：' + question;

      const systemMsg = {
        role: 'system',
        content: '你是专业课程与学术研讨视频助教。请用条理清晰的简体中文 Markdown 解答问题，数学与物理公式使用标准 LaTeX（行内 $...$，独立 $$...$$）。引用字幕时间节点时请保留 [MM:SS] 格式以便学习者点击跳转。结合课件画面或字幕客观作答，区分视频原意与延伸补充。'
      };

      controller = new AbortController();
      const timeoutId = setTimeout(() => controller?.abort(), 120000);
      askBtn.disabled = true;
      stopBtn.hidden = false;
      statusEl.textContent = '正在结合 ' + (frameDataUrl ? '当前画面' : '') + (frameDataUrl && transcript ? '与' : '') + (transcript ? '字幕上下文' : '') + ' 推演…';

      const pendingWrap = document.createElement('div');
      pendingWrap.className = 'ai-exchange';
      pendingWrap.innerHTML =
        '<div class="ai-bubble ai-bubble-user"><span class="ai-user-page">▶ ' + stamp + '</span><p class="ai-quote"></p></div>' +
        '<div class="ai-bubble ai-bubble-assistant"><div class="ai-answer-body rich-content"><span class="ai-thinking">正在分析视频内容…</span></div></div>';
      pendingWrap.querySelector('.ai-quote').textContent = question;
      msgHost.append(pendingWrap);
      syncEmpty();
      pendingWrap.scrollIntoView({ block: 'nearest' });
      const liveBody = pendingWrap.querySelector('.ai-answer-body');

      try {
        const userContent = frameDataUrl
          ? [{ type: 'text', text: textPrompt }, { type: 'image_url', image_url: { url: frameDataUrl } }]
          : textPrompt;
        let res = await sendChatCompletion(config, [systemMsg, ...history.slice(-6), { role: 'user', content: userContent }], controller.signal);
        if (!res.ok && frameDataUrl && [400, 415, 422].includes(res.status) && transcript) {
          // 若当前模型不支持多模态图片输入但已有字幕，自动优雅回退为纯字幕文本请求
          statusEl.textContent = '当前模型不支持画面输入，已自动切换为字幕上下文回答…';
          res = await sendChatCompletion(config, [systemMsg, ...history.slice(-6), { role: 'user', content: textPrompt }], controller.signal);
        }
        if (!res.ok) throw new Error('模型服务返回 HTTP ' + res.status + '，请检查模型名称、地址或密钥。');

        let paintTimer = 0;
        const answer = await readAiCompletionText(res, partial => {
          if (paintTimer) return;
          paintTimer = setTimeout(() => {
            paintTimer = 0;
            renderVideoAiAnswer(liveBody, partial, video, session);
          }, 90);
        });
        clearTimeout(paintTimer);
        if (!answer || !answer.trim()) throw new Error('模型未返回有效内容。');

        pendingWrap.remove();
        history.push({ role: 'user', content: '[' + stamp + '] ' + question }, { role: 'assistant', content: answer });
        appendVideoExchange({ stampSec, question, answer });
        inputEl.value = '';
        statusEl.textContent = '回答完成 · 点击 [MM:SS] 可直接跳播对应片段';
      } catch (err) {
        pendingWrap.remove();
        syncEmpty();
        statusEl.textContent = err.name === 'AbortError' ? '已停止生成。' : err.message;
      } finally {
        clearTimeout(timeoutId);
        controller = null;
        askBtn.disabled = false;
        stopBtn.hidden = true;
      }
    }

    askBtn.onclick = () => void askVideoAi(inputEl.value);
    stopBtn.onclick = () => controller?.abort();
    clearBtn.onclick = () => {
      msgHost.replaceChildren();
      history = [];
      syncEmpty();
      statusEl.textContent = '对话已清空。';
    };
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void askVideoAi(inputEl.value);
      }
    });
  }

  window.mountVideoAiAssistant = mountVideoAiAssistant;
})();
