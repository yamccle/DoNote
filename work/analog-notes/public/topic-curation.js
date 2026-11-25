/**
 * [INPUT]: 读取当前账户 topics 列表、全量记录 tags 引用计数与新增记录标签候选。
 * [OUTPUT]: 暴露 isNoiseTopicTag 拦截文件名/日期/组会标签污染，升级 #topicsDialog 研究方向治理工作台。
 * [POS]: 研究方向（宏观领域）与记录标签（微观属性）解耦治理层，支持一键无损收纳杂项、搜索筛选与移除保留标签。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(function () {
  const ROUTINE_TOPIC_SET = new Set([
    '组会', '组会周报', '工作周志', '工作周报', '学习周志', '周报', '周志', '日报', '月报',
    '导入整理', 'AI辅助', 'AI 辅助', '待办', '临时', '草稿', '拖拽分拣验证'
  ]);
  const AUTO_PROMOTE_KEY = 'donote-auto-topic-promote';

  function isNoiseTopicTag(raw) {
    const tag = String(raw || '').trim();
    if (!tag) return true;
    if (ROUTINE_TOPIC_SET.has(tag)) return true;
    // 文件名后缀（如 GmC_Filter_260811.pptx, paper.pdf, notes.docx）
    if (/\.(pptx?|pdf|docx?|xlsx?|csv|md|markdown|txt|mp4|mp3|webm|mov|zip|rar|7z|png|jpe?g|svg)$/i.test(tag)) return true;
    // 纯日期数字或周次（如 20260811, 260811, 2026-08-11, 2026.08.11, 2026-W32, W32）
    if (/^(?:19|20)?\d{6}$/.test(tag) || /^(?:19|20)\d{6}$/.test(tag)) return true;
    if (/^\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?$/.test(tag)) return true;
    if (/^(?:\d{4}-)?W\d{1,2}$/i.test(tag)) return true;
    // 典型带日期后缀的下划线课件标识（如 XXX_260811, Slide_20260819）
    if (/_(?:19|20)?\d{6}$/.test(tag)) return true;
    // 含明显组会汇报字样且带数字日期
    if (/组会|周报|例会/.test(tag)) return true;
    return false;
  }

  function isAutoPromoteEnabled() {
    try { return localStorage.getItem(AUTO_PROMOTE_KEY) !== 'off'; } catch { return true; }
  }

  function setAutoPromoteEnabled(on) {
    try { localStorage.setItem(AUTO_PROMOTE_KEY, on ? 'on' : 'off'); } catch {}
  }

  let currentFilter = 'all';
  let searchQuery = '';
  let toolsMounted = false;

  function computeTagCounts(profile) {
    const counts = new Map();
    for (const note of profile?.records || []) {
      if (note.flashcardKind) continue;
      for (const tag of new Set(note.tags || [])) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return counts;
  }

  async function demoteTopicsOnly(targetNames, statusHint) {
    if (!targetNames.length) return;
    const removeSet = new Set(targetNames);
    const next = structuredClone(appState);
    const p = next.profiles.find(item => item.id === next.activeId);
    const before = p.topics.length;
    p.topics = p.topics.filter(t => !removeSet.has(t));
    const removed = before - p.topics.length;
    if (!removed) return;
    await commitState(next);
    if (removeSet.has(topic)) topic = '';
    writeSidebarTopicHistory(readSidebarTopicHistory().filter(t => !removeSet.has(t)));
    renderTopicsEnhanced();
    render();
    $('topicMessage').textContent = statusHint || ('已将 ' + removed + ' 项移出「研究方向」（原记录上的标签已完整保留）。');
  }

  function ensureTopicCurationBar() {
    const dialog = $('topicsDialog');
    const form = $('topicForm');
    const list = $('topicList');
    if (!dialog || !form || !list || toolsMounted) return;
    toolsMounted = true;

    const note = dialog.querySelector('.modalbody > .section-note');
    if (note) {
      note.textContent = '「研究方向」用于提炼核心领域导航；组会日期、课件文件名等微观标签会自动留在记录内，不再混入此处。';
    }

    const bar = document.createElement('div');
    bar.className = 'topic-curation-bar';
    bar.innerHTML =
      '<div class="topic-curation-banner" id="topicCleanupBanner" hidden>' +
        '<span id="topicCleanupSummary"></span>' +
        '<div class="topic-curation-actions">' +
          '<button type="button" class="primary settings-mini-btn" id="topicDemoteNoiseBtn" title="只从研究方向导航列表中移除，不删除周报或文献上的原标签">一键收纳杂项（保留记录标签）</button>' +
          '<button type="button" class="secondary settings-mini-btn" id="topicCleanUnusedBtn" hidden>清理 0 条闲置项</button>' +
        '</div>' +
      '</div>' +
      '<div class="topic-filter-row">' +
        '<input type="search" id="topicFilterSearch" class="topic-filter-search" placeholder="筛选研究方向…" aria-label="筛选研究方向">' +
        '<div class="topic-filter-pills" id="topicFilterPills" role="group" aria-label="方向分类筛选">' +
          '<button type="button" data-topic-filter="all" class="is-active">全部</button>' +
          '<button type="button" data-topic-filter="used">有记录</button>' +
          '<button type="button" data-topic-filter="empty">0 条闲置</button>' +
          '<button type="button" data-topic-filter="noise">疑似杂项</button>' +
        '</div>' +
      '</div>' +
      '<label class="topic-auto-toggle">' +
        '<input type="checkbox" id="topicAutoPromoteToggle"> 保存记录时自动将新领域标签加入研究方向（已自动过滤日期、文件名与组会标签）' +
      '</label>';
    form.after(bar);

    const searchEl = bar.querySelector('#topicFilterSearch');
    searchEl.oninput = () => {
      searchQuery = searchEl.value.trim().toLowerCase();
      renderTopicsEnhanced();
    };
    bar.querySelectorAll('[data-topic-filter]').forEach(btn => {
      btn.onclick = () => {
        currentFilter = btn.dataset.topicFilter;
        bar.querySelectorAll('[data-topic-filter]').forEach(b => b.classList.toggle('is-active', b === btn));
        renderTopicsEnhanced();
      };
    });
    const autoToggle = bar.querySelector('#topicAutoPromoteToggle');
    autoToggle.checked = isAutoPromoteEnabled();
    autoToggle.onchange = () => setAutoPromoteEnabled(autoToggle.checked);

    bar.querySelector('#topicDemoteNoiseBtn').onclick = () => {
      const p = activeProfile();
      const noisy = (p?.topics || []).filter(isNoiseTopicTag);
      void demoteTopicsOnly(noisy, '已一键收纳 ' + noisy.length + ' 项组会/日期/文件名杂项，原记录标签均已无损保留。');
    };
    bar.querySelector('#topicCleanUnusedBtn').onclick = () => {
      const p = activeProfile();
      const counts = computeTagCounts(p);
      const unused = (p?.topics || []).filter(t => !counts.get(t));
      void demoteTopicsOnly(unused, '已清理 ' + unused.length + ' 个无关联记录的闲置研究方向。');
    };
  }

  function renderTopicsEnhanced() {
    ensureTopicCurationBar();
    const p = activeProfile();
    if (!p) return;
    const counts = computeTagCounts(p);
    const allTopics = p.topics || [];
    const noisyTopics = allTopics.filter(isNoiseTopicTag);
    const emptyTopics = allTopics.filter(t => (counts.get(t) || 0) === 0);

    const banner = $('topicCleanupBanner');
    const summary = $('topicCleanupSummary');
    const cleanNoiseBtn = $('topicDemoteNoiseBtn');
    const cleanUnusedBtn = $('topicCleanUnusedBtn');
    if (banner && summary) {
      if (noisyTopics.length > 0 || emptyTopics.length >= 4) {
        banner.hidden = false;
        const parts = [];
        if (noisyTopics.length) parts.push('检测到 ' + noisyTopics.length + ' 项疑似组会日期或课件文件名');
        if (emptyTopics.length) parts.push(emptyTopics.length + ' 项为 0 条记录');
        summary.textContent = parts.join('，') + '。';
        if (cleanNoiseBtn) cleanNoiseBtn.hidden = noisyTopics.length === 0;
        if (cleanUnusedBtn) {
          cleanUnusedBtn.hidden = emptyTopics.length === 0;
          cleanUnusedBtn.textContent = '清理 ' + emptyTopics.length + ' 个空方向';
        }
      } else {
        banner.hidden = true;
      }
    }

    const pills = $('topicFilterPills');
    if (pills) {
      const labels = {
        all: '全部 ' + allTopics.length,
        used: '有记录 ' + (allTopics.length - emptyTopics.length),
        empty: '闲置 ' + emptyTopics.length,
        noise: '杂项 ' + noisyTopics.length
      };
      pills.querySelectorAll('[data-topic-filter]').forEach(btn => {
        btn.textContent = labels[btn.dataset.topicFilter] || btn.textContent;
      });
    }

    const filtered = allTopics
      .map((name, index) => ({ name, index, count: counts.get(name) || 0, noise: isNoiseTopicTag(name) }))
      .filter(item => {
        if (searchQuery && !item.name.toLowerCase().includes(searchQuery)) return false;
        if (currentFilter === 'used') return item.count > 0;
        if (currentFilter === 'empty') return item.count === 0;
        if (currentFilter === 'noise') return item.noise;
        return true;
      });

    const list = $('topicList');
    if (!filtered.length) {
      list.innerHTML = '<p class="section-note">' + (allTopics.length ? '当前筛选条件下没有匹配的研究方向。' : '还没有研究方向，添加一个你正在关注的领域吧。') + '</p>';
      return;
    }

    list.innerHTML = filtered.map(item =>
      '<div class="manager-row topic-row' + (item.noise ? ' is-noisy-topic' : '') + '">' +
        '<span class="topic-row-main">' +
          '<strong>' + esc(item.name) + '</strong>' +
          '<small class="tiny">' + item.count + ' 条记录' + (item.noise ? ' · 建议降级为普通标签' : '') + '</small>' +
        '</span>' +
        '<div class="topic-row-actions">' +
          '<button type="button" class="secondary settings-mini-btn" data-topic-rename="' + item.index + '">改名</button>' +
          (item.count > 0
            ? '<button type="button" class="secondary settings-mini-btn" data-topic-demote="' + item.index + '" title="仅从研究方向列表隐藏，保留记录上的标签">移出方向</button>'
            : '') +
          '<button type="button" class="danger settings-mini-btn" data-topic-delete="' + item.index + '">' + (item.count > 0 ? '彻底删除' : '删除') + '</button>' +
        '</div>' +
      '</div>'
    ).join('');

    list.onclick = e => {
      const button = e.target.closest('button');
      if (!button || topicSaving) return;
      const idx = Number(button.dataset.topicRename ?? button.dataset.topicDemote ?? button.dataset.topicDelete);
      const name = p.topics[idx];
      if (!name) return;
      if (button.hasAttribute('data-topic-rename')) {
        setTopicEditor(name);
        $('topicMessage').textContent = '将同步更新所有使用「' + name + '」的记录（改为已有方向名称即可合并）。';
        $('topicName').focus();
        $('topicName').select();
      } else if (button.hasAttribute('data-topic-demote')) {
        void demoteTopicsOnly([name], '已将「' + name + '」移出研究方向，对应记录上的标签已保留。');
      } else {
        const cnt = counts.get(name) || 0;
        if (cnt === 0) void demoteTopicsOnly([name], '已删除空研究方向「' + name + '」。');
        else void removeTopic(name, cnt);
      }
    };
  }

  window.isNoiseTopicTag = isNoiseTopicTag;
  window.shouldAutoPromoteTopicTag = tag => isAutoPromoteEnabled() && !isNoiseTopicTag(tag);
  window.renderTopics = renderTopicsEnhanced;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureTopicCurationBar, { once: true });
  } else {
    ensureTopicCurationBar();
  }
})();
