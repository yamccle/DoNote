/**
 * [INPUT]: 接收导入、备份、云端传输、在线更新、网页抓取、PDF 翻译重排与视频语音识别任务的实时状态。
 * [OUTPUT]: 提供后台任务进度和文件跳转。视频字幕任务在生成时也能返回原视频。
 * [POS]: 全局非阻塞后台任务可观测层，关闭各业务弹窗后仍可实时查看进度、定位或取消任务。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(function () {
  const MAX_HISTORY = 24;
  const KIND_LABELS = {
    update: '软件更新',
    asr: '语音识别',
    translate: '双语翻译',
    reflow: '文档重排',
    backup: '数据备份',
    cloud: '云端同步',
    import: '资料入库',
    capture: '网页收藏',
    sync: '多端同步',
    task: '后台任务'
  };

  const tasks = new Map();
  let triggerBtn = null;
  let readerPill = null;
  let popoverEl = null;
  let lastAnchor = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function clampPercent(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  function activeTasks() {
    return [...tasks.values()].filter(item => item.state === 'running');
  }

  function orderedTasks() {
    return [...tasks.values()].sort((a, b) => {
      const aRun = a.state === 'running' ? 1 : 0;
      const bRun = b.state === 'running' ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
  }

  function pruneHistory() {
    if (tasks.size <= MAX_HISTORY) return;
    const finished = [...tasks.values()]
      .filter(item => item.state !== 'running')
      .sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
    while (tasks.size > MAX_HISTORY && finished.length) {
      tasks.delete(finished.shift().id);
    }
  }

  function formatRelativeTime(iso) {
    const ms = Date.now() - Date.parse(iso || '');
    if (!Number.isFinite(ms) || ms < 45000) return '刚刚';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + ' 分钟前';
    const hours = Math.floor(mins / 60);
    return hours + ' 小时前';
  }

  function ensureTaskCenterDom() {
    if (!popoverEl) {
      popoverEl = document.createElement('section');
      popoverEl.id = 'taskCenterPopover';
      popoverEl.className = 'task-center-popover';
      popoverEl.setAttribute('popover', 'auto');
      popoverEl.setAttribute('aria-label', '后台任务进度中心');
      popoverEl.innerHTML =
        '<header class="task-center-head">' +
          '<div><strong>后台任务中心</strong><small id="taskCenterSummary">实时汇总识别、翻译、备份与下载进度</small></div>' +
          '<div class="task-center-head-actions">' +
            '<button type="button" class="secondary task-center-clear" id="taskCenterClearBtn" hidden>清理记录</button>' +
            '<button type="button" class="icon-button" id="taskCenterCloseBtn" aria-label="关闭任务中心">✕</button>' +
          '</div>' +
        '</header>' +
        '<div class="task-center-list" id="taskCenterList" role="status" aria-live="polite"></div>';
      document.body.append(popoverEl);
      popoverEl.querySelector('#taskCenterCloseBtn').onclick = () => popoverEl.hidePopover?.();
      popoverEl.querySelector('#taskCenterClearBtn').onclick = () => clearCompleted();
      popoverEl.addEventListener('toggle', () => {
        const isOpen = popoverEl.matches(':popover-open');
        if (triggerBtn) triggerBtn.setAttribute('aria-expanded', String(isOpen));
        if (readerPill) readerPill.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) positionPopover(lastAnchor || triggerBtn);
      });
      window.addEventListener('resize', () => {
        if (popoverEl?.matches(':popover-open')) positionPopover(lastAnchor || triggerBtn);
      });
    }

    const intro = document.getElementById('workspaceIntro');
    if (intro && (!triggerBtn || !triggerBtn.isConnected)) {
      triggerBtn = document.createElement('button');
      triggerBtn.type = 'button';
      triggerBtn.id = 'taskCenterTrigger';
      triggerBtn.className = 'secondary task-center-trigger';
      triggerBtn.setAttribute('aria-haspopup', 'dialog');
      triggerBtn.setAttribute('aria-expanded', 'false');
      triggerBtn.title = '查看后台下载、识别、翻译、备份与同步进度';
      triggerBtn.onclick = () => togglePopover(triggerBtn);
      const actions = intro.querySelector('.workspace-intro-actions');
      if (actions) intro.insertBefore(triggerBtn, actions);
      else intro.append(triggerBtn);
    }

    const reader = document.getElementById('reader');
    if (reader && (!readerPill || !readerPill.isConnected)) {
      readerPill = document.createElement('button');
      readerPill.type = 'button';
      readerPill.id = 'readerTaskPill';
      readerPill.className = 'reader-task-pill';
      readerPill.hidden = true;
      readerPill.setAttribute('aria-haspopup', 'dialog');
      readerPill.setAttribute('aria-expanded', 'false');
      readerPill.onclick = () => togglePopover(readerPill);
      reader.append(readerPill);
    }
  }

  function positionPopover(anchor) {
    if (!popoverEl) return;
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height)) {
      popoverEl.style.top = '64px';
      popoverEl.style.right = '24px';
      popoverEl.style.left = 'auto';
      return;
    }
    const width = Math.min(392, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const preferAbove = rect.top > window.innerHeight * 0.65;
    popoverEl.style.width = width + 'px';
    popoverEl.style.left = left + 'px';
    popoverEl.style.right = 'auto';
    if (preferAbove) {
      popoverEl.style.top = 'auto';
      popoverEl.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + 'px';
    } else {
      popoverEl.style.bottom = 'auto';
      popoverEl.style.top = Math.min(window.innerHeight - 180, rect.bottom + 8) + 'px';
    }
  }

  function togglePopover(anchor) {
    ensureTaskCenterDom();
    lastAnchor = anchor || triggerBtn;
    if (!popoverEl.togglePopover) return;
    if (popoverEl.matches(':popover-open')) {
      popoverEl.hidePopover();
    } else {
      renderTaskCenter();
      popoverEl.showPopover();
      positionPopover(lastAnchor);
    }
  }

  function renderTriggerContent() {
    ensureTaskCenterDom();
    const running = activeTasks();
    const all = orderedTasks();
    const primary = running[0];
    const doneCount = all.length - running.length;

    if (triggerBtn) {
      triggerBtn.classList.toggle('is-active', running.length > 0);
      triggerBtn.dataset.activeCount = String(running.length);
      if (primary) {
        const pct = primary.percent !== null ? ' ' + primary.percent + '%' : '';
        const label = primary.title.length > 12 ? primary.title.slice(0, 12) + '…' : primary.title;
        triggerBtn.innerHTML =
          '<span class="task-ring is-spinning" aria-hidden="true"></span>' +
          '<span class="task-trigger-text">' + esc(label + pct) + '</span>' +
          '<span class="task-trigger-badge">' + running.length + '</span>';
      } else {
        triggerBtn.innerHTML =
          '<svg class="task-idle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h2.3l1.6-3.5 3.1 7 1.7-3.5h2.3"/></svg>' +
          '<span class="task-trigger-text">任务</span>' +
          (doneCount > 0 ? '<span class="task-trigger-badge is-muted">' + doneCount + '</span>' : '');
      }
    }

    if (readerPill) {
      if (running.length > 0) {
        const pct = primary.percent !== null ? ' · ' + primary.percent + '%' : '';
        readerPill.hidden = false;
        readerPill.innerHTML =
          '<span class="task-ring is-spinning" aria-hidden="true"></span>' +
          '<span>' + esc(primary.title + pct) + '</span>' +
          (running.length > 1 ? '<span class="task-trigger-badge">' + running.length + '</span>' : '');
      } else {
        readerPill.hidden = true;
      }
    }
  }

  function renderTaskCenter() {
    ensureTaskCenterDom();
    renderTriggerContent();
    if (!popoverEl) return;
    const running = activeTasks();
    const all = orderedTasks();
    const summary = popoverEl.querySelector('#taskCenterSummary');
    const clearBtn = popoverEl.querySelector('#taskCenterClearBtn');
    const list = popoverEl.querySelector('#taskCenterList');
    if (summary) {
      summary.textContent = running.length
        ? running.length + ' 项任务正在后台运行 · 关闭原窗口不会中断处理'
        : all.length
          ? '当前无运行中任务 · 保留最近 ' + all.length + ' 条记录'
          : '空闲中 · 下载、识别、翻译、备份与同步进度会在此实时展示';
    }
    if (clearBtn) {
      clearBtn.hidden = !all.some(item => item.state !== 'running');
    }
    if (!list) return;
    list.replaceChildren();
    if (!all.length) {
      const empty = document.createElement('div');
      empty.className = 'task-center-empty';
      empty.textContent = '暂无后台任务。发起语音识别、整页翻译、网页抓取、云端备份或在线更新后，可随时在此查看实时进度。';
      list.append(empty);
      return;
    }

    for (const item of all) {
      const card = document.createElement('article');
      card.className = 'task-item is-' + item.state;
      card.dataset.taskId = item.id;
      const openDocument = item.fileId && (item.state === 'done' || item.openWhileRunning && item.state === 'running')
        ? () => openFile(item.fileId, item.page, item.profileId)
        : null;
      if (openDocument) {
        card.classList.add('is-openable');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.title = item.openLabel || '打开对应文档';
        card.onclick = event => {
          if (event.target.closest('button')) return;
          popoverEl.hidePopover?.();
          openDocument();
        };
        card.onkeydown = event => {
          if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          popoverEl.hidePopover?.();
          openDocument();
        };
      }

      const top = document.createElement('div');
      top.className = 'task-item-top';
      const kindBadge = document.createElement('span');
      kindBadge.className = 'task-kind-pill';
      kindBadge.textContent = KIND_LABELS[item.kind] || KIND_LABELS.task;
      const title = document.createElement('strong');
      title.className = 'task-item-title';
      title.textContent = item.title;
      const stateTag = document.createElement('span');
      stateTag.className = 'task-state-label';
      stateTag.textContent = item.state === 'running'
        ? (item.percent !== null ? item.percent + '%' : '进行中')
        : item.state === 'done'
          ? '已完成'
          : item.state === 'cancelled'
            ? '已取消'
            : '异常';
      top.append(kindBadge, title, stateTag);
      card.append(top);

      if (item.detail) {
        const detail = document.createElement('p');
        detail.className = 'task-item-detail';
        detail.textContent = item.detail;
        card.append(detail);
      }

      if (item.state === 'running' || item.percent !== null) {
        const barWrap = document.createElement('div');
        barWrap.className = 'task-progress-track' + (item.state === 'running' && item.percent === null ? ' is-indeterminate' : '');
        const barFill = document.createElement('span');
        barFill.className = 'task-progress-fill';
        barFill.style.width = (item.percent !== null ? item.percent : item.state === 'done' ? 100 : 38) + '%';
        barWrap.append(barFill);
        card.append(barWrap);
      }

      const foot = document.createElement('div');
      foot.className = 'task-item-foot';
      const time = document.createElement('small');
      time.textContent = formatRelativeTime(item.updatedAt);
      const actions = document.createElement('div');
      actions.className = 'task-item-actions';
      if (openDocument || typeof item.onOpen === 'function') {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'secondary task-mini-btn';
        openBtn.textContent = item.openLabel || (openDocument ? '打开' : '查看');
        openBtn.onclick = event => {
          event.stopPropagation();
          popoverEl.hidePopover?.();
          if (openDocument) openDocument();
          else item.onOpen();
        };
        actions.append(openBtn);
      }
      if (item.state === 'running' && typeof item.onCancel === 'function') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'secondary task-mini-btn is-danger';
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = () => item.onCancel();
        actions.append(cancelBtn);
      }
      foot.append(time, actions);
      card.append(foot);
      list.append(card);
    }
  }

  function upsert(id, patch = {}) {
    if (!id) return null;
    const prev = tasks.get(id) || {
      id,
      kind: 'task',
      title: '后台任务',
      detail: '',
      percent: null,
      state: 'running',
      createdAt: nowIso()
    };
    const next = {
      ...prev,
      ...patch,
      id,
      percent: patch.percent !== undefined ? clampPercent(patch.percent) : prev.percent,
      updatedAt: nowIso()
    };
    if (next.state === 'done' && next.percent === null && prev.percent !== null) {
      next.percent = 100;
    }
    tasks.set(id, next);
    pruneHistory();
    renderTaskCenter();
    document.dispatchEvent(new CustomEvent('donote-tasks-changed', { detail: { id, task: next } }));
    return next;
  }

  function remove(id) {
    if (!tasks.delete(id)) return;
    renderTaskCenter();
    document.dispatchEvent(new CustomEvent('donote-tasks-changed', { detail: { id, task: null } }));
  }

  function clearCompleted() {
    for (const [id, item] of tasks) {
      if (item.state !== 'running') tasks.delete(id);
    }
    renderTaskCenter();
  }

  function wireExistingPipelines() {
    ensureTaskCenterDom();
    renderTaskCenter();

    if (typeof window.startImportProgress === 'function' && !window.startImportProgress.__donoteTaskWrapped) {
      const origStart = window.startImportProgress;
      const origSet = window.setImportProgress;
      const origFinish = window.finishImportProgress;
      window.startImportProgress = function (message) {
        upsert('batch-import', {
          kind: 'import',
          title: '批量导入资料',
          detail: message || '正在读取文件…',
          percent: 0,
          state: 'running',
          onCancel: () => document.getElementById('importProgressCancel')?.click(),
          onOpen: () => {
            const dlg = document.getElementById('importProgressDialog');
            if (dlg && !dlg.open) dlg.showModal();
          }
        });
        return origStart.apply(this, arguments);
      };
      window.startImportProgress.__donoteTaskWrapped = true;
      window.setImportProgress = function (done, total, current) {
        const pct = total ? Math.round((done / total) * 100) : 0;
        upsert('batch-import', {
          kind: 'import',
          title: '批量导入资料',
          detail: (total ? '已处理 ' + done + ' / ' + total + ' 份' : '准备中…') + (current ? ' · ' + current : ''),
          percent: pct,
          state: 'running'
        });
        return origSet.apply(this, arguments);
      };
      window.finishImportProgress = function (message) {
        const failed = /中断|失败/.test(String(message || ''));
        upsert('batch-import', {
          kind: 'import',
          title: '批量导入资料',
          detail: message || '批量导入已完成',
          percent: failed ? null : 100,
          state: failed ? 'error' : 'done',
          onCancel: null,
          onOpen: null
        });
        return origFinish.apply(this, arguments);
      };
    }

    const importMsg = document.getElementById('importMessage');
    const backupBar = document.getElementById('backupProgressBar');
    if (importMsg) {
      const syncBackupTask = () => {
        const text = importMsg.textContent.trim();
        if (!text) {
          if (tasks.get('local-backup')?.state === 'running') remove('local-backup');
          return;
        }
        const isDone = /^(已保存|大文件备份已完成|导入完成|没有需要导入的新记录)/.test(text);
        const isErr = /(未完成|失败|不足|无效|超出|过大|缺少|异常|已变化)/.test(text);
        const isCancel = /已取消/.test(text);
        const pct = backupBar && !backupBar.hidden && backupBar.hasAttribute('value')
          ? Math.round((Number(backupBar.value) / Math.max(1, Number(backupBar.max) || 100)) * 100)
          : isDone ? 100 : null;
        upsert('local-backup', {
          kind: 'backup',
          title: /导入|恢复/.test(text) ? '本地备份恢复' : '本地备份导出',
          detail: text,
          percent: pct,
          state: isCancel ? 'cancelled' : isErr ? 'error' : isDone ? 'done' : 'running',
          onOpen: () => {
            const dlg = document.getElementById('backup');
            if (dlg && !dlg.open) dlg.showModal();
          }
        });
      };
      new MutationObserver(syncBackupTask).observe(importMsg, { childList: true, characterData: true, subtree: true });
    }
  }

  function findTaskAttachment(fileId, profileId) {
    const profiles = appState?.profiles || [];
    const current = profiles.find(profile => profile.id === (profileId || appState?.activeId));
    for (const profile of profileId ? [current] : [current, ...profiles]) {
      for (const note of profile?.records || []) {
        const file = (note.attachments || []).find(item => item.id === fileId);
        if (file) return { file, profileId: profile.id };
      }
    }
    return null;
  }

  async function openFile(fileId, page, profileId) {
    const target = findTaskAttachment(fileId, profileId);
    if (!target) {
      if (typeof toast === 'function') toast('找不到这份文档。');
      return;
    }
    try {
      const { file } = target;
      const reader = document.getElementById('reader');
      const alreadyOpen = reader?.open && readingSession?.file?.id === file.id &&
        readingSession.profileId === target.profileId;
      if (!alreadyOpen) {
        if (reader?.open) await new Promise(resolve => {
          reader.addEventListener('close', resolve, { once: true });
          reader.close();
        });
        if (appState.activeId !== target.profileId) {
          await waitForReaderSaves();
          const next = structuredClone(appState);
          next.activeId = target.profileId;
          await commitState(next);
          updateIdentity();
          switchView('all');
        }
        await openAttachment(file);
      }
      if (page && readingSession?.file?.id === file.id && typeof readingSession.showPage === 'function') {
        await readingSession.showPage(page);
      }
    } catch (error) {
      toast(error.message);
    }
  }

  window.DoNoteTasks = {
    upsert,
    remove,
    clearCompleted,
    list: orderedTasks,
    activeCount: () => activeTasks().length,
    openPopover: () => togglePopover(triggerBtn),
    openFile
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireExistingPipelines, { once: true });
  } else {
    wireExistingPipelines();
  }
})();
