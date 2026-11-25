/**
 * [INPUT]: 读取工作台视图状态、记录列表、主题与用户交互事件。
 * [OUTPUT]: 提供 Ctrl+K 全局聚光灯指令面板、资料库画廊/列表切换、问题与计划交互式拖拽看板及微交互动效。
 * [POS]: 挂载于主渲染流程末端的新世代交互增强层，保持原有记录存储与筛选契约完全兼容。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(() => {
  const LIB_VIEW_KEY = 'donote-library-view-mode';
  const BOARD_VIEW_KEY = 'donote-board-view-modes';
  const KANBAN_ICONS = {
    grid: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    board: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="14" rx="1.5"/></svg>',
    spark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
  };

  let libraryViewMode = 'grid';
  try {
    const saved = localStorage.getItem(LIB_VIEW_KEY);
    if (saved === 'list' || saved === 'grid') libraryViewMode = saved;
  } catch {}

  let boardModes = {};
  try {
    const saved = JSON.parse(localStorage.getItem(BOARD_VIEW_KEY) || '{}');
    if (saved && typeof saved === 'object') boardModes = saved;
  } catch {}

  function setLibraryViewMode(mode) {
    libraryViewMode = mode === 'list' ? 'list' : 'grid';
    try { localStorage.setItem(LIB_VIEW_KEY, libraryViewMode); } catch {}
    render();
  }

  function supportsKanban(v) {
    if (v === 'all' || v === 'resource' || v === 'pinned') return false;
    const statuses = statusOptions[v];
    return Array.isArray(statuses) && statuses.length >= 2 && statuses.length <= 6;
  }

  function isBoardActive(v) {
    if (!supportsKanban(v)) return false;
    if (v === 'plan' && typeof planArchiveMode !== 'undefined' && planArchiveMode) return false;
    return boardModes[v] === 'board';
  }

  function setBoardMode(v, mode) {
    boardModes[v] = mode === 'board' ? 'board' : 'list';
    try { localStorage.setItem(BOARD_VIEW_KEY, JSON.stringify(boardModes)); } catch {}
    render();
  }

  // ── 1. 顶部栏 Ctrl+K 聚光灯触发器 + 视图切换胶囊组 ──
  function ensureViewControls() {
    const introActions = document.querySelector('#workspaceIntro .workspace-intro-actions');
    if (introActions && !$('introCommandTrigger')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'introCommandTrigger';
      btn.className = 'cmdk-intro-pill';
      btn.title = '打开快速跳转与全局指令面板 (Ctrl+K)';
      btn.innerHTML = KANBAN_ICONS.spark + '<span>快速指令</span><kbd>Ctrl K</kbd>';
      btn.onclick = () => openCommandPalette();
      introActions.prepend(btn);
    }

    const libControls = $('libraryControls');
    if (libControls && !$('libraryViewSwitcher')) {
      const seg = document.createElement('div');
      seg.id = 'libraryViewSwitcher';
      seg.className = 'view-mode-segmented';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', '资料库视图切换');
      seg.innerHTML = '<button type="button" data-lib-view="grid" title="视觉画廊卡片视图">' + KANBAN_ICONS.grid + '<span>画廊</span></button>'
        + '<button type="button" data-lib-view="list" title="紧凑列表视图">' + KANBAN_ICONS.list + '<span>列表</span></button>';
      seg.onclick = event => {
        const btn = event.target.closest('[data-lib-view]');
        if (btn) setLibraryViewMode(btn.dataset.libView);
      };
      const anchor = $('librarySelection');
      if (anchor && anchor.parentElement === libControls) libControls.insertBefore(seg, anchor);
      else libControls.append(seg);
    }

    const toolbarBtns = document.querySelector('.workspace-toolbar-buttons');
    if (toolbarBtns && !$('boardViewSwitcher')) {
      const seg = document.createElement('div');
      seg.id = 'boardViewSwitcher';
      seg.className = 'view-mode-segmented';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', '列表与看板视图切换');
      seg.innerHTML = '<button type="button" data-board-mode="list" title="卡片列表视图">' + KANBAN_ICONS.list + '<span>列表</span></button>'
        + '<button type="button" data-board-mode="board" title="状态看板视图（支持拖拽流转）">' + KANBAN_ICONS.board + '<span>看板</span></button>';
      seg.onclick = event => {
        const btn = event.target.closest('[data-board-mode]');
        if (btn && supportsKanban(view)) setBoardMode(view, btn.dataset.boardMode);
      };
      toolbarBtns.prepend(seg);
    }
  }

  function syncViewControlStates() {
    const libSeg = $('libraryViewSwitcher');
    if (libSeg) {
      for (const btn of libSeg.querySelectorAll('[data-lib-view]')) {
        const active = btn.dataset.libView === libraryViewMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    }
    const boardSeg = $('boardViewSwitcher');
    if (boardSeg) {
      const canBoard = supportsKanban(view) && !(view === 'plan' && planArchiveMode);
      boardSeg.hidden = !canBoard;
      if (canBoard) {
        const currentMode = isBoardActive(view) ? 'board' : 'list';
        for (const btn of boardSeg.querySelectorAll('[data-board-mode]')) {
          const active = btn.dataset.boardMode === currentMode;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-pressed', String(active));
        }
      }
    }
  }

  // ── 2. 资料库画廊增强：格式主题色与角标 ──
  function enhanceLibraryCards(items) {
    const host = $('records');
    const isResource = view === 'resource';
    host.classList.toggle('library-grid-mode', isResource && libraryViewMode === 'grid');
    host.classList.toggle('library-list-mode', isResource && libraryViewMode === 'list');
    if (!isResource) return;
    const byId = new Map((items || []).map(n => [n.id, n]));
    let idx = 0;
    for (const card of host.querySelectorAll('.card[data-id]')) {
      card.style.setProperty('--stagger-i', String(Math.min(idx++, 14)));
      const note = byId.get(card.dataset.id);
      if (!note) continue;
      const file = note.attachments?.[0];
      const kindTone = note.webArticle ? 'web'
        : file && fileIsPresentation(file) ? 'ppt'
        : file && fileIsVideo(file) ? 'video'
        : file && fileIsPdf(file) ? 'pdf' : 'note';
      card.dataset.mediaTone = kindTone;
      const cover = card.querySelector('.library-cover');
      if (cover && !cover.querySelector('.cover-format-pill')) {
        const formatLabel = note.webArticle ? 'WEB'
          : file && fileIsPresentation(file) ? 'PPTX'
          : file && fileIsVideo(file) ? 'VIDEO'
          : file && fileIsPdf(file) ? 'PDF'
          : file?.name?.split('.').pop()?.toUpperCase() || 'NOTE';
        const badge = document.createElement('span');
        badge.className = 'cover-format-pill';
        badge.textContent = formatLabel;
        cover.append(badge);
      }
    }
  }

  // ── 3. 问题/计划交互式拖拽看板 (Kanban Board) ──
  let draggedKanbanId = null;

  function statusToneFor(status) {
    if (['已读', '已解决', '已完成'].includes(status)) return 'done';
    if (['在读', '进行中'].includes(status)) return 'active';
    return 'todo';
  }

  function collectKanbanItems(baseItems) {
    if (view !== 'plan') return baseItems;
    // 在计划看板下同时展示未开始、进行中与已完成三列，便于完整拖拽闭环
    const q = $('search').value.trim().toLowerCase();
    const folderFilter = $('recordFolderFilter')?.value || '';
    const folderMatch = recordFolderMatcher(folderScope('plan'), folderFilter);
    return records.filter(r =>
      !r.flashcardKind && r.type === 'plan' &&
      (!topic || r.tags.includes(topic)) &&
      folderMatch(r) &&
      (!q || [r.title, r.author || '', r.body, ...r.tags].join(' ').toLowerCase().includes(q))
    );
  }

  function renderKanbanBoard(visibleList) {
    const host = $('records');
    const statuses = statusOptions[view] || [];
    const allItems = collectKanbanItems(visibleList);
    host.classList.add('kanban-host');
    $('libraryPager').hidden = true;
    $('resultCount').textContent = '看板共 ' + allItems.length + ' 条记录 · 拖动卡片可切换状态';

    const board = document.createElement('div');
    board.className = 'kanban-board';
    board.dataset.kanbanView = view;

    for (const status of statuses) {
      const colItems = allItems.filter(item => item.status === status);
      const tone = statusToneFor(status);
      const col = document.createElement('section');
      col.className = 'kanban-column';
      col.dataset.kanbanStatus = status;
      col.dataset.kanbanTone = tone;
      col.innerHTML = '<header class="kanban-col-head">'
        + '<span class="kanban-col-title"><i class="kanban-dot"></i><strong>' + esc(status) + '</strong></span>'
        + '<span class="kanban-col-count">' + colItems.length + '</span>'
        + '</header><div class="kanban-dropzone"></div>'
        + '<button type="button" class="kanban-add-btn" data-kanban-add="' + esc(status) + '">＋ 新建「' + esc(status) + '」</button>';

      const zone = col.querySelector('.kanban-dropzone');
      if (!colItems.length) {
        const empty = document.createElement('div');
        empty.className = 'kanban-empty-slot';
        empty.textContent = '拖入卡片或点击下方新建';
        zone.append(empty);
      } else {
        for (const [idx, r] of colItems.entries()) {
          const card = document.createElement('article');
          card.className = 'card kanban-card';
          card.dataset.id = r.id;
          card.tabIndex = 0;
          card.draggable = true;
          card.style.setProperty('--stagger-i', String(Math.min(idx, 10)));
          const nextIdx = (statuses.indexOf(status) + 1) % statuses.length;
          const nextStatus = statuses[nextIdx];
          const excerpt = legacyPptxExcerpt(r) ? '' : r.body.slice(0, 76) + (r.body.length > 76 ? '…' : '');
          const dateInfo = r.type === 'plan' && validPlanDates(r.planStart, r.planEnd)
            ? r.planStart.slice(5) + ' → ' + r.planEnd.slice(5)
            : r.date.replaceAll('-', '.');
          card.innerHTML = '<div class="kanban-card-top">'
            + '<span class="kanban-date">' + esc(dateInfo) + '</span>'
            + (r.pinned ? '<span class="pin" title="已置顶">⌑</span>' : '')
            + '</div>'
            + '<h3>' + esc(r.title) + '</h3>'
            + (excerpt ? '<p class="card-excerpt">' + esc(excerpt) + '</p>' : '')
            + '<div class="kanban-card-foot">'
            + '<div class="tags">' + r.tags.slice(0, 3).map(t => '<span class="tag">' + esc(t) + '</span>').join('')
            + ((r.attachments || []).length ? '<span class="kanban-att-chip">📎 ' + r.attachments.length + '</span>' : '')
            + '</div>'
            + '<button type="button" class="kanban-step-btn" data-kanban-advance="' + esc(nextStatus) + '" title="推进至：' + esc(nextStatus) + '">→ ' + esc(nextStatus) + '</button>'
            + '</div>';
          card.onclick = event => {
            const step = event.target.closest('[data-kanban-advance]');
            if (step) {
              event.stopPropagation();
              void moveKanbanRecord(r.id, step.dataset.kanbanAdvance);
              return;
            }
            showDetail(r.id);
          };
          card.onkeydown = event => {
            if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              showDetail(r.id);
            }
          };
          card.ondragstart = event => {
            draggedKanbanId = r.id;
            card.classList.add('is-dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', r.id);
          };
          card.ondragend = () => {
            draggedKanbanId = null;
            card.classList.remove('is-dragging');
            board.querySelectorAll('.is-drop-target').forEach(n => n.classList.remove('is-drop-target'));
          };
          zone.append(card);
        }
      }

      col.ondragover = event => {
        if (!draggedKanbanId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        col.classList.add('is-drop-target');
      };
      col.ondragleave = event => {
        if (!col.contains(event.relatedTarget)) col.classList.remove('is-drop-target');
      };
      col.ondrop = event => {
        event.preventDefault();
        col.classList.remove('is-drop-target');
        const id = draggedKanbanId || event.dataTransfer.getData('text/plain');
        draggedKanbanId = null;
        if (id) void moveKanbanRecord(id, status);
      };
      col.querySelector('[data-kanban-add]').onclick = () => {
        openEditor(view);
        if ($('editor').open && statusOptions[view]?.includes(status)) {
          $('status').value = status;
          queueDraft();
        }
      };
      board.append(col);
    }
    host.replaceChildren(board);
  }

  async function moveKanbanRecord(id, nextStatus) {
    const note = records.find(item => item.id === id);
    if (!note || note.status === nextStatus) return;
    try {
      await put({ ...note, status: nextStatus });
      render();
      toast('已将「' + note.title.slice(0, 22) + '」移至 ' + nextStatus);
    } catch (error) {
      toast(error.message);
    }
  }

  // ── 4. Ctrl+K / Cmd+K 聚光灯全局指令与速查面板 ──
  let cmdDialog, cmdInput, cmdList, cmdActiveIdx = 0, cmdItems = [];

  function ensureCommandPalette() {
    if (cmdDialog) return;
    cmdDialog = document.createElement('dialog');
    cmdDialog.id = 'commandPalette';
    cmdDialog.className = 'command-palette';
    cmdDialog.setAttribute('aria-label', '快速跳转与指令面板');
    cmdDialog.innerHTML = '<div class="cmdk-head">'
      + KANBAN_ICONS.spark
      + '<input id="commandPaletteInput" type="search" autocomplete="off" spellcheck="false" placeholder="输入关键词跳转栏目、搜索文献/PPT/笔记，或执行快捷操作…" aria-label="输入指令或搜索词">'
      + '<kbd class="cmdk-esc">ESC</kbd>'
      + '</div>'
      + '<div id="commandPaletteList" class="cmdk-list" role="listbox"></div>'
      + '<footer class="cmdk-foot"><span><kbd>↑↓</kbd> 选择</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Ctrl+K</kbd> 随时呼出</span></footer>';
    document.body.append(cmdDialog);
    cmdInput = cmdDialog.querySelector('#commandPaletteInput');
    cmdList = cmdDialog.querySelector('#commandPaletteList');
    cmdDialog.addEventListener('click', event => {
      if (event.target === cmdDialog) cmdDialog.close();
    });
    cmdInput.addEventListener('input', () => { cmdActiveIdx = 0; renderCommandItems(); });
    cmdInput.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (cmdItems.length) { cmdActiveIdx = (cmdActiveIdx + 1) % cmdItems.length; syncCmdSelection(); }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (cmdItems.length) { cmdActiveIdx = (cmdActiveIdx - 1 + cmdItems.length) % cmdItems.length; syncCmdSelection(); }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const picked = cmdItems[cmdActiveIdx];
        if (picked) { cmdDialog.close(); picked.run(); }
      }
    });
  }

  function buildCommandCandidates(query) {
    const q = query.trim().toLowerCase();
    const list = [];
    const navTargets = [
      ['all', '前往：' + (names.all || '总览'), '查看精读进度环、近期计划与数据概览'],
      ['resource', '前往：' + (names.resource || '文献与媒体库'), '浏览 PDF、PPT 讲义、离线网页与课程视频'],
      ...categoryList().filter(c => c.id !== 'paper').map(c => [c.id, '前往：' + c.name, navDescription(c.id)]),
      ['pinned', '前往：' + (names.pinned || '置顶收藏'), '查看重点置顶记录']
    ];
    const actions = [
      { group: '快捷动作', title: '新建记录', sub: '创建笔记、问题课题、日志或阶段计划', hint: 'Ctrl+N', run: () => openNewWorkspaceRecord() },
      { group: '快捷动作', title: '收藏公开网页', sub: '单进程极速抓取正文与配图到本机', hint: 'Web', run: () => { switchView('resource'); $('captureWebPage')?.click(); } },
      { group: '快捷动作', title: '全库全文检索（PDF / PPT / 字幕 / 笔记）', sub: '跨文档搜索页码、讲义备注与视频时间轴', hint: '全文', run: () => $('openPdfSearch')?.click() },
      { group: '快捷动作', title: '切换白天 / 夜间外观主题', sub: '在瓷白浅色与深空暗色主题之间切换', hint: '主题', run: () => {
        const dark = document.documentElement.dataset.theme === 'dark';
        window.DoNoteAppearance?.applyTheme(dark ? 'light' : 'dark', true);
      } },
      ...(!$('desktopSettingsButton')?.hidden ? [{
        group: '快捷动作', title: '打开偏好设置中心', sub: '外观阅读、AI 与翻译语向、资料存储与更新', hint: '设置', run: () => $('desktopSettingsButton')?.click()
      }] : []),
      { group: '快捷动作', title: '备份与恢复工作台', sub: '导出 JSON / ZIP / 大文件流式备份或云端快照', hint: '备份', run: () => $('backupBtn')?.click() }
    ];
    for (const act of actions) {
      if (!q || (act.title + ' ' + act.sub).toLowerCase().includes(q)) list.push(act);
    }
    for (const [id, title, sub] of navTargets) {
      if (!q || (title + ' ' + sub).toLowerCase().includes(q)) {
        list.push({ group: '栏目导航', title, sub, hint: '跳转', run: () => switchView(id) });
      }
    }
    const matchedRecords = records
      .filter(r => !r.flashcardKind && (!q || [r.title, r.author || '', r.body.slice(0, 300), ...r.tags, ...(r.attachments || []).map(a => a.name)].join(' ').toLowerCase().includes(q)))
      .slice(0, q ? 14 : 6);
    for (const r of matchedRecords) {
      const att = r.attachments?.[0];
      const badge = r.webArticle ? '网页' : att && fileIsPresentation(att) ? 'PPT' : att && fileIsPdf(att) ? 'PDF' : att && fileIsVideo(att) ? '视频' : (names[r.type] || '记录');
      list.push({
        group: q ? '匹配资料与记录' : '最近记录',
        title: r.title,
        sub: [badge, r.author, r.status, r.date].filter(Boolean).join(' · '),
        hint: r.type === 'resource' && (att || r.webArticle) ? '打开阅读' : '查看详情',
        run: () => {
          if (r.type === 'resource' && r.webArticle) { void openSavedWebpage(r); return; }
          if (r.type === 'resource' && att) { void openAttachment(att); return; }
          showDetail(r.id);
        }
      });
    }
    return list;
  }

  function syncCmdSelection() {
    const rows = [...cmdList.querySelectorAll('.cmdk-item')];
    rows.forEach((row, idx) => {
      const active = idx === cmdActiveIdx;
      row.classList.toggle('is-active', active);
      row.setAttribute('aria-selected', String(active));
      if (active) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function renderCommandItems() {
    cmdItems = buildCommandCandidates(cmdInput.value);
    if (!cmdItems.length) {
      cmdList.innerHTML = '<div class="cmdk-empty">未找到匹配项，可按 Enter 尝试打开「全库全文检索」搜索文档内部页码。</div>';
      cmdItems = [{ group: '检索', title: '全库全文检索', sub: '', hint: 'Enter', run: () => {
        $('openPdfSearch')?.click();
        const qInput = $('pdfSearchQuery');
        if (qInput) { qInput.value = cmdInput.value.trim(); qInput.dispatchEvent(new Event('input')); }
      } }];
      return;
    }
    const frag = document.createDocumentFragment();
    let currentGroup = '';
    cmdItems.forEach((item, idx) => {
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        const head = document.createElement('div');
        head.className = 'cmdk-group-label';
        head.textContent = currentGroup;
        frag.append(head);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmdk-item' + (idx === cmdActiveIdx ? ' is-active' : '');
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(idx === cmdActiveIdx));
      btn.innerHTML = '<span class="cmdk-item-main"><strong>' + esc(item.title) + '</strong>'
        + (item.sub ? '<small>' + esc(item.sub) + '</small>' : '') + '</span>'
        + '<span class="cmdk-item-hint">' + esc(item.hint || '') + '</span>';
      btn.onpointerenter = () => { cmdActiveIdx = idx; syncCmdSelection(); };
      btn.onclick = () => { cmdDialog.close(); item.run(); };
      frag.append(btn);
    });
    cmdList.replaceChildren(frag);
  }

  function openCommandPalette() {
    if (!ready) return;
    ensureCommandPalette();
    if (cmdDialog.open) { cmdDialog.close(); return; }
    if (document.querySelector('dialog[open]')) return;
    if ($('desktopSettings')?.matches(':popover-open')) $('desktopSettings').hidePopover();
    cmdInput.value = '';
    cmdActiveIdx = 0;
    renderCommandItems();
    cmdDialog.showModal();
    cmdInput.focus();
  }
  window.openCommandPalette = openCommandPalette;

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
      if (document.querySelector('dialog[open]:not(#commandPalette)')) return;
      event.preventDefault();
      openCommandPalette();
    }
  });

  // ── 5. 指针跟随微光（60fps 轻量聚光灯）与卡片阶梯入场 ──
  document.addEventListener('pointermove', event => {
    const card = event.target.closest?.('.bento-study-card, .dashboard-card, #records.library-grid-mode .card, .kanban-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', (event.clientX - rect.left) + 'px');
    card.style.setProperty('--my', (event.clientY - rect.top) + 'px');
  }, { passive: true });

  window.enhanceWorkspaceViews = function enhanceWorkspaceViews(visibleList) {
    ensureViewControls();
    syncViewControlStates();
    const host = $('records');
    host.classList.remove('kanban-host');
    if (isBoardActive(view)) {
      renderKanbanBoard(visibleList || []);
      return;
    }
    enhanceLibraryCards(visibleList || []);
    if (view !== 'resource') {
      let idx = 0;
      for (const card of host.querySelectorAll(':scope > .card')) {
        card.style.setProperty('--stagger-i', String(Math.min(idx++, 12)));
      }
    }
  };
})();
