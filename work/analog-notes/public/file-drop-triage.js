/**
 * [INPUT]: 监听窗口外部文件拖拽事件或分拣导入按钮触发，读取当前工作台栏目、文件夹与研究方向配置。
 * [OUTPUT]: 提供篮板式全局拖拽投递浮层 #globalDropOverlay、投递归档分拣台 #dropTriageDialog 与 window.openDropTriageWithFiles。
 * [POS]: 文件入库前站，串联原件归档、Markdown/DOCX 正文解析、即时新建文件夹、标签打标与后台任务进度汇报。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(function () {
  const SUPPORTED_EXT = /\.(pdf|pptx|ppt|docx|md|markdown|mp4|webm|mov|m4v|ogv|mp3|png|jpe?g|webp|gif|bmp)$/i;
  let overlay = null;
  let dialog = null;
  let dragDepth = 0;
  let stagedItems = [];
  let selectedTopics = new Set();
  let importing = false;

  function formatBadgeFor(file) {
    const ext = (String(file.name || '').split('.').pop() || '').toUpperCase();
    if (['PDF', 'PPTX', 'PPT', 'DOCX', 'MP4', 'MP3'].includes(ext)) return ext;
    if (ext === 'MD' || ext === 'MARKDOWN') return 'MD';
    if (/^(PNG|JPE?G|WEBP|GIF|BMP)$/.test(ext) || /^image\//i.test(file.type || '')) return 'IMG';
    if (/^(WEBM|MOV|M4V|OGV)$/.test(ext) || /^video\//i.test(file.type || '')) return 'VIDEO';
    return ext.slice(0, 5) || 'FILE';
  }

  function baseTitleFromFileName(name) {
    return String(name || '').replace(/\.[^.]+$/, '').trim().slice(0, 240) || '未命名资料';
  }

  function cleanAcademicTitle(raw) {
    let text = String(raw || '').trim();
    text = text.replace(/^(?:\[\d{4}[a-z]?\]|\(\d{4}\))\s*/i, '');
    text = text.replace(/\s*\(\d+\)$/, '');
    text = text.replace(/(?:[_-](?:final|v\d+|rev\d+|copy|副本))+$/i, '');
    text = text.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return text.slice(0, 240) || raw;
  }

  function libraryTotalCount() {
    if (typeof records === 'undefined' || !Array.isArray(records)) return 0;
    return records.filter(n => !n.flashcardKind && (n.type === 'resource' || n.type === 'paper')).length;
  }

  function hasExternalFiles(event) {
    if (typeof categoryDragTarget !== 'undefined' && categoryDragTarget) return false;
    if (event.target?.closest?.('#widgetEditTop, #widgetEditSide')) return false;
    if ($('editor')?.open && event.target?.closest?.('#editor')) return false;
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes('Files');
  }

  function ensureDropUi() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'globalDropOverlay';
      overlay.className = 'global-drop-overlay';
      overlay.hidden = true;
      overlay.innerHTML =
        '<div class="drop-backboard-card" id="dropBackboardCard">' +
          '<div class="drop-backboard-top">' +
            '<span class="drop-eyebrow">DROP &amp; TRIAGE · 快速投递</span>' +
            '<span class="drop-score-pill" id="dropScorePill">已收录 0 份资料</span>' +
          '</div>' +
          '<div class="drop-hoop-stage" aria-hidden="true">' +
            '<svg class="drop-hoop-svg" viewBox="0 0 180 128" fill="none">' +
              '<rect x="46" y="14" width="88" height="58" rx="10" stroke="currentColor" stroke-width="2" stroke-dasharray="5 5" opacity="0.55"/>' +
              '<rect x="68" y="32" width="44" height="30" rx="4" stroke="currentColor" stroke-width="2.2"/>' +
              '<ellipse cx="90" cy="66" rx="28" ry="7" stroke="var(--drop-rim, #d96b43)" stroke-width="3.2"/>' +
              '<path d="M65 68 L72 104 M77 72 L81 106 M90 73 L90 107 M103 72 L99 106 M115 68 L108 104" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.45"/>' +
              '<path d="M68 82 Q90 90 112 82 M71 95 Q90 102 109 95" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.35"/>' +
            '</svg>' +
            '<span class="drop-score-pop" id="dropScorePop" hidden>+1</span>' +
          '</div>' +
          '<h2>松手投递文件，进入归档分拣台</h2>' +
          '<p>支持 PDF、PPTX、DOCX、Markdown、课程视频、音频与图片 · 可一键改名、选目录、建新文件夹并打标</p>' +
        '</div>';
      document.body.append(overlay);
    }

    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'dropTriageDialog';
      dialog.className = 'drop-triage-dialog';
      dialog.setAttribute('aria-labelledby', 'dropTriageTitle');
      dialog.innerHTML =
        '<form id="dropTriageForm">' +
          '<div class="modalhead">' +
            '<div>' +
              '<h2 id="dropTriageTitle">投递归档分拣台</h2>' +
              '<p class="tiny" id="dropTriageSub">入库前集中确认标题、目标栏目、归档文件夹与研究标签</p>' +
            '</div>' +
            '<div class="drop-head-right">' +
              '<span class="drop-score-pill" id="dropTriageScore">待归档 0 份</span>' +
              '<button type="button" class="icon-button" id="dropTriageClose" aria-label="关闭">✕</button>' +
            '</div>' +
          '</div>' +
          '<div class="modalbody drop-triage-body">' +
            '<section class="drop-files-pane" aria-label="待入库文件清单">' +
              '<div class="drop-pane-bar">' +
                '<strong>待入库文件</strong>' +
                '<div class="drop-pane-actions">' +
                  '<button type="button" class="secondary settings-mini-btn" id="dropCleanTitlesBtn" title="去除下划线、括号年份与冗余后缀">智能清理标题</button>' +
                  '<button type="button" class="secondary settings-mini-btn" id="dropAddMoreBtn">+ 继续添加</button>' +
                  '<input type="file" id="dropAddMoreInput" multiple hidden>' +
                '</div>' +
              '</div>' +
              '<div class="drop-file-list" id="dropTriageList"></div>' +
            '</section>' +
            '<section class="drop-org-pane" aria-label="归档与分类设置">' +
              '<div class="field-row">' +
                '<div class="field"><label for="dropTargetType">归入栏目</label><select id="dropTargetType"></select></div>' +
                '<div class="field"><label for="dropTargetStatus">初始状态</label><select id="dropTargetStatus"></select></div>' +
              '</div>' +
              '<label class="drop-inline-check" id="dropMergeRow" hidden>' +
                '<input type="checkbox" id="dropMergeSingle"> 将以上文件合并为同一条记录的多个附件' +
              '</label>' +
              '<div class="field-row">' +
                '<div class="field"><label for="dropTargetFolder">归档文件夹</label><select id="dropTargetFolder"></select></div>' +
                '<div class="field"><label for="dropNewFolder">新建子目录（可选）</label><input id="dropNewFolder" maxlength="120" placeholder="如：2026 春季文献 / 精读"></div>' +
              '</div>' +
              '<div class="field">' +
                '<label>点击套用研究方向标签</label>' +
                '<div class="drop-topic-pills" id="dropTopicPills"></div>' +
                '<input id="dropCustomTags" maxlength="180" placeholder="补充自定义标签，用逗号分隔（可选）">' +
              '</div>' +
              '<label class="drop-inline-check">' +
                '<input type="checkbox" id="dropAutoOpen"> 归档完成后立即打开第一份文件阅读' +
              '</label>' +
              '<div class="drop-upload-card" id="dropUploadCard" hidden role="status" aria-live="polite">' +
                '<div class="drop-upload-row"><strong id="dropUploadLabel">正在归档…</strong><span id="dropUploadPercent">0%</span></div>' +
                '<div class="drop-upload-track"><span id="dropUploadFill" style="width:0%"></span></div>' +
              '</div>' +
              '<p class="form-message" id="dropTriageError" role="alert"></p>' +
            '</section>' +
          '</div>' +
          '<div class="modalfoot">' +
            '<span class="tiny">原件完整保存在本机资料库，PDF 入库后自动识别标题与 DOI 元数据</span>' +
            '<div class="right">' +
              '<button type="button" class="secondary" id="dropTriageCancel">取消</button>' +
              '<button type="submit" class="primary" id="dropTriageSubmit">确认归档入库</button>' +
            '</div>' +
          '</div>' +
        '</form>';
      document.body.append(dialog);

      dialog.querySelector('#dropTriageClose').onclick = () => { if (!importing) dialog.close(); };
      dialog.querySelector('#dropTriageCancel').onclick = () => { if (!importing) dialog.close(); };
      dialog.querySelector('#dropCleanTitlesBtn').onclick = () => {
        stagedItems.forEach(item => { item.title = cleanAcademicTitle(item.title); });
        renderFileRows();
      };
      dialog.querySelector('#dropAddMoreBtn').onclick = () => dialog.querySelector('#dropAddMoreInput').click();
      dialog.querySelector('#dropAddMoreInput').onchange = e => {
        const extra = [...(e.target.files || [])];
        e.target.value = '';
        if (extra.length) appendFilesToStage(extra);
      };
      dialog.querySelector('#dropTargetType').onchange = () => syncTypeDependentSelectors();
      dialog.querySelector('#dropTriageForm').onsubmit = e => {
        e.preventDefault();
        void executeTriageImport();
      };
    }

    const libControls = document.getElementById('libraryControls');
    const folderBtn = document.getElementById('importResourceFolder');
    if (libControls && folderBtn && !document.getElementById('openDropTriageBtn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'openDropTriageBtn';
      btn.className = 'secondary';
      btn.textContent = '分拣导入';
      btn.title = '打开投递归档分拣台，支持拖拽文件、批量清洗标题、新建文件夹与打标签';
      btn.onclick = () => openDropTriageWithFiles([]);
      folderBtn.after(btn);
    }
  }

  function syncTypeDependentSelectors() {
    const typeSelect = dialog.querySelector('#dropTargetType');
    const statusSelect = dialog.querySelector('#dropTargetStatus');
    const folderSelect = dialog.querySelector('#dropTargetFolder');
    const chosenType = typeSelect.value || 'resource';
    const statuses = statusOptions[chosenType] || ['待读', '在读', '已读'];
    statusSelect.replaceChildren(...statuses.map(s => new Option(s, s)));

    const scope = folderScope(chosenType);
    folderSelect.innerHTML = '<option value="">未归档（根目录）</option>' + recordFolderOptions(scope);
    const activeFilter = activeFolderFilter(scope);
    if (activeFilter && activeFilter !== FOLDER_ROOT && activeFilter !== FOLDER_ALL && scopedFolderId(chosenType, activeFilter)) {
      folderSelect.value = activeFilter;
    }
  }

  function renderTopicPills() {
    const wrap = dialog.querySelector('#dropTopicPills');
    const topics = activeProfile()?.topics || [];
    wrap.replaceChildren();
    for (const tag of topics.slice(0, 16)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drop-topic-pill' + (selectedTopics.has(tag) ? ' is-selected' : '');
      btn.dataset.dropTopic = tag;
      btn.setAttribute('aria-pressed', String(selectedTopics.has(tag)));
      btn.textContent = tag;
      btn.onclick = () => {
        if (selectedTopics.has(tag)) selectedTopics.delete(tag);
        else selectedTopics.add(tag);
        btn.classList.toggle('is-selected', selectedTopics.has(tag));
        btn.setAttribute('aria-pressed', String(selectedTopics.has(tag)));
      };
      wrap.append(btn);
    }
  }

  function renderFileRows() {
    const list = dialog.querySelector('#dropTriageList');
    const score = dialog.querySelector('#dropTriageScore');
    const mergeRow = dialog.querySelector('#dropMergeRow');
    const submitBtn = dialog.querySelector('#dropTriageSubmit');
    score.textContent = '待归档 ' + stagedItems.length + ' 份';
    mergeRow.hidden = stagedItems.length <= 1;
    submitBtn.disabled = importing || stagedItems.length === 0;
    submitBtn.textContent = stagedItems.length > 1
      ? '归档全部 ' + stagedItems.length + ' 份文件'
      : '确认归档入库';

    list.replaceChildren();
    if (!stagedItems.length) {
      const empty = document.createElement('div');
      empty.className = 'drop-empty-hint';
      empty.innerHTML = '<strong>直接将桌面或资源管理器中的文件拖入此处</strong><span>或点击右上角「+ 继续添加」选取 PDF、PPTX、DOCX、视频或图片</span>';
      list.append(empty);
      return;
    }

    stagedItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'drop-file-row';
      const badge = document.createElement('span');
      badge.className = 'drop-file-ext';
      badge.dataset.ext = item.badge;
      badge.textContent = item.badge;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'drop-file-title';
      input.maxLength = 240;
      input.value = item.title;
      input.setAttribute('aria-label', '文件标题 ' + (index + 1));
      input.oninput = () => { item.title = input.value; };

      const size = document.createElement('small');
      size.className = 'drop-file-size';
      size.textContent = sizeLabel(item.file.size);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-button drop-file-remove';
      removeBtn.setAttribute('aria-label', '移除 ' + item.file.name);
      removeBtn.textContent = '✕';
      removeBtn.onclick = () => {
        if (importing) return;
        stagedItems.splice(index, 1);
        renderFileRows();
      };
      row.append(badge, input, size, removeBtn);
      list.append(row);
    });
  }

  function appendFilesToStage(rawFiles) {
    const errEl = dialog.querySelector('#dropTriageError');
    errEl.textContent = '';
    const rejected = [];
    for (const file of rawFiles) {
      if (!file || (!SUPPORTED_EXT.test(file.name || '') && !/^(application\/pdf|image\/|video\/|audio\/)/i.test(file.type || ''))) {
        rejected.push(file?.name || '未知文件');
        continue;
      }
      if (file.size > MAX_FILE) {
        rejected.push(file.name + '（超过 2 GB）');
        continue;
      }
      stagedItems.push({
        id: crypto.randomUUID(),
        file,
        badge: formatBadgeFor(file),
        title: baseTitleFromFileName(file.name)
      });
    }
    if (rejected.length) {
      errEl.textContent = '已跳过不支持或超限文件：' + rejected.slice(0, 3).join('、') + (rejected.length > 3 ? ' 等' : '');
    }
    renderFileRows();
  }

  function openDropTriageWithFiles(files, options = {}) {
    if (typeof ensureReady === 'function' && !ensureReady()) return;
    ensureDropUi();
    importing = false;
    stagedItems = [];
    selectedTopics = new Set(typeof topic === 'string' && topic ? [topic] : []);

    const cats = categoryList();
    const typeSelect = dialog.querySelector('#dropTargetType');
    typeSelect.replaceChildren(
      new Option((names.resource || '文献与媒体库') + '（原始资料 · 推荐）', 'resource'),
      ...cats.map(c => new Option(recordTypeName(c.id), c.id))
    );
    const defaultType = options.defaultType || (activeCategory(view) && view !== 'plan' ? view : 'resource');
    typeSelect.value = [...typeSelect.options].some(o => o.value === defaultType) ? defaultType : 'resource';
    syncTypeDependentSelectors();
    renderTopicPills();

    dialog.querySelector('#dropNewFolder').value = '';
    dialog.querySelector('#dropCustomTags').value = '';
    dialog.querySelector('#dropMergeSingle').checked = false;
    dialog.querySelector('#dropUploadCard').hidden = true;
    dialog.querySelector('#dropUploadCard').classList.remove('is-complete');
    dialog.querySelector('#dropTriageError').textContent = '';

    const list = Array.from(files || []);
    if (list.length) appendFilesToStage(list);
    else renderFileRows();
    dialog.querySelector('#dropAutoOpen').checked = stagedItems.length === 1;

    if (!dialog.open) dialog.showModal();
  }

  async function executeTriageImport() {
    if (importing || !stagedItems.length || !ensureReady()) return;
    importing = true;
    const errEl = dialog.querySelector('#dropTriageError');
    const submitBtn = dialog.querySelector('#dropTriageSubmit');
    const card = dialog.querySelector('#dropUploadCard');
    const cardLabel = dialog.querySelector('#dropUploadLabel');
    const cardPct = dialog.querySelector('#dropUploadPercent');
    const cardFill = dialog.querySelector('#dropUploadFill');
    errEl.textContent = '';
    submitBtn.disabled = true;
    card.hidden = false;
    card.classList.remove('is-complete');

    const targetType = dialog.querySelector('#dropTargetType').value || 'resource';
    const targetStatus = dialog.querySelector('#dropTargetStatus').value || (statusOptions[targetType]?.[0] || '待读');
    const baseFolderId = dialog.querySelector('#dropTargetFolder').value || '';
    const newFolderRaw = dialog.querySelector('#dropNewFolder').value.trim();
    const mergeSingle = stagedItems.length > 1 && dialog.querySelector('#dropMergeSingle').checked;
    const autoOpen = dialog.querySelector('#dropAutoOpen').checked;
    const extraTags = dialog.querySelector('#dropCustomTags').value
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean);
    const allTags = [...new Set([...selectedTopics, ...extraTags])].slice(0, 30);

    const total = stagedItems.length;
    const setProgress = (done, label, complete = false) => {
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 100;
      cardLabel.textContent = label;
      cardPct.textContent = complete ? '✓ 已完成' : pct + '%';
      cardFill.style.width = pct + '%';
      card.classList.toggle('is-complete', complete);
      window.DoNoteTasks?.upsert?.('drop-triage-import', {
        kind: 'import',
        title: '拖拽分拣入库',
        detail: label,
        percent: pct,
        state: complete ? 'done' : 'running'
      });
    };

    try {
      setProgress(0, '正在准备归档目录与校验文件…');
      const profileId = appState.activeId;
      const next = structuredClone(appState);
      const p = next.profiles.find(item => item.id === profileId);
      const scope = folderScope(targetType);
      let resolvedFolderId = scopedFolderId(targetType, baseFolderId, p) || '';
      if (newFolderRaw) {
        const parts = newFolderRaw.split(/[\/\\›>]+/).map(s => s.trim()).filter(Boolean);
        if (parts.length) {
          resolvedFolderId = folderFromImportPath(p, scope, parts, resolvedFolderId) || resolvedFolderId;
          if (!validRecordFolders(p.folders)) throw new Error('文件夹层级或数量超出上限，请精简目录路径。');
        }
      }

      const writes = [];
      const createdNotes = [];
      const allRawFiles = stagedItems.map(entry => entry.file);
      const now = new Date().toISOString();

      if (mergeSingle) {
        const attachments = [];
        let mergedHtml = '';
        for (let i = 0; i < stagedItems.length; i++) {
          const { file } = stagedItems[i];
          setProgress(i, '正在封装附件 ' + (i + 1) + ' / ' + total + ' · ' + file.name);
          const att = attachmentFromFile(file);
          attachments.push(att);
          writes.push({ key: fileKey(p.id, att.id), blob: file });
          if (!mergedHtml && /\.(md|markdown)$/i.test(file.name) && file.size <= 600000) {
            mergedHtml = await parseMarkdown(file, allRawFiles, attachments, writes, p.id);
          } else if (!mergedHtml && fileIsDocx(att) && !requiresExternalReader(att)) {
            mergedHtml = await readDocxHtml(file).catch(() => '');
          }
        }
        const firstTitle = (stagedItems[0].title || '').trim() || baseTitleFromFileName(stagedItems[0].file.name);
        const note = normalizeRichNote({
          id: crypto.randomUUID(),
          type: targetType,
          title: firstTitle.slice(0, 240),
          date: today(),
          body: '',
          bodyHtml: mergedHtml,
          author: '',
          reference: '',
          url: '',
          status: targetStatus,
          tags: allTags,
          journalKind: 'daily',
          pinned: false,
          attachments,
          createdAt: now,
          updatedAt: now
        });
        if (targetType === 'plan') {
          note.planStart = today();
          note.planEnd = planEndFor(note.planStart, 'week');
        }
        if (resolvedFolderId) note.folderId = resolvedFolderId;
        window.DoNoteSync?.stampRecordMutation?.(note, null);
        if (!validate(note)) throw new Error('合并后的记录字段超出限制，请拆分后导入。');
        addNewTopicTags(p, allTags);
        p.records.push(note);
        createdNotes.push(note);
      } else {
        for (let i = 0; i < stagedItems.length; i++) {
          const item = stagedItems[i];
          const { file } = item;
          setProgress(i, '正在归档 ' + (i + 1) + ' / ' + total + ' · ' + file.name);
          const att = attachmentFromFile(file);
          const attachments = [att];
          writes.push({ key: fileKey(p.id, att.id), blob: file });
          let html = '';
          if (targetType !== 'resource') {
            if (/\.(md|markdown)$/i.test(file.name) && file.size <= 600000) {
              html = await parseMarkdown(file, allRawFiles, attachments, writes, p.id);
            } else if (fileIsDocx(att) && !requiresExternalReader(att)) {
              html = await readDocxHtml(file).catch(() => '');
            }
          }
          const cleanTitle = (item.title || '').trim().slice(0, 240) || baseTitleFromFileName(file.name);
          const note = normalizeRichNote({
            id: crypto.randomUUID(),
            type: targetType,
            title: cleanTitle,
            date: today(),
            body: '',
            bodyHtml: html,
            author: '',
            reference: '',
            url: '',
            status: targetStatus,
            tags: allTags,
            journalKind: 'daily',
            pinned: false,
            attachments,
            createdAt: now,
            updatedAt: now
          });
          if (targetType === 'plan') {
            note.planStart = today();
            note.planEnd = planEndFor(note.planStart, 'week');
          }
          if (resolvedFolderId) note.folderId = resolvedFolderId;
          window.DoNoteSync?.stampRecordMutation?.(note, null);
          if (!validate(note)) throw new Error('文件「' + file.name + '」字段不合法。');
          p.records.push(note);
          createdNotes.push(note);
          if (i % 8 === 7) await new Promise(r => requestAnimationFrame(r));
        }
        addNewTopicTags(p, allTags);
      }

      await commitState(next, writes);
      const resourceNotes = createdNotes.filter(n => n.type === 'resource');
      if (resourceNotes.length && typeof queueLiteratureRecognition === 'function') {
        queueLiteratureRecognition(resourceNotes, p.id);
      }
      setProgress(total, '✓ 已成功归档 ' + createdNotes.length + ' 条记录（共 ' + total + ' 份文件）', true);
      if (view !== targetType && targetType === 'resource') {
        if (resolvedFolderId) revealFolderLocation('resource', resolvedFolderId);
        else render();
      } else {
        render();
      }
      toast('已归档 ' + createdNotes.length + ' 条记录');

      const firstNote = createdNotes[0];
      const firstAtt = firstNote?.attachments?.[0];
      setTimeout(() => {
        importing = false;
        if (dialog.open) dialog.close();
        if (autoOpen && firstNote) {
          if (firstNote.type === 'resource') void openResource(firstNote.id);
          else if (firstAtt) void openAttachment(firstAtt);
          else showDetail(firstNote.id);
        }
      }, 420);
    } catch (error) {
      importing = false;
      submitBtn.disabled = false;
      errEl.textContent = error.message || '归档失败，请重试。';
      window.DoNoteTasks?.upsert?.('drop-triage-import', {
        kind: 'import',
        title: '拖拽分拣入库',
        detail: error.message || '归档失败',
        percent: null,
        state: 'error'
      });
    }
  }

  function hideOverlay() {
    dragDepth = 0;
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.remove('is-aiming');
  }

  function bindGlobalDragEvents() {
    ensureDropUi();
    window.addEventListener('dragenter', event => {
      if (!hasExternalFiles(event)) return;
      event.preventDefault();
      dragDepth++;
      const pill = document.getElementById('dropScorePill');
      if (pill) pill.textContent = '已收录 ' + libraryTotalCount() + ' 份资料';
      overlay.hidden = false;
    });

    window.addEventListener('dragover', event => {
      if (!hasExternalFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (overlay.hidden) overlay.hidden = false;
      const card = document.getElementById('dropBackboardCard');
      const rect = card?.getBoundingClientRect();
      const inside = rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      overlay.classList.toggle('is-aiming', !!inside);
    });

    window.addEventListener('dragleave', event => {
      if (overlay.hidden) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 || (!event.relatedTarget && event.clientX <= 0 && event.clientY <= 0)) {
        hideOverlay();
      }
    });

    window.addEventListener('blur', hideOverlay);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && overlay && !overlay.hidden) hideOverlay();
    });

    window.addEventListener('drop', event => {
      if (!hasExternalFiles(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) {
        hideOverlay();
        return;
      }
      if (dialog?.open && !importing) {
        hideOverlay();
        appendFilesToStage(files);
        return;
      }
      const pop = document.getElementById('dropScorePop');
      if (pop && overlay && !overlay.hidden) {
        pop.textContent = '+' + files.length;
        pop.hidden = false;
        pop.classList.add('is-popping');
        setTimeout(() => {
          pop.hidden = true;
          pop.classList.remove('is-popping');
          hideOverlay();
          openDropTriageWithFiles(files);
        }, 220);
      } else {
        hideOverlay();
        openDropTriageWithFiles(files);
      }
    });
  }

  window.openDropTriageWithFiles = openDropTriageWithFiles;
  window.cleanAcademicTitle = cleanAcademicTitle;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindGlobalDragEvents, { once: true });
  } else {
    bindGlobalDragEvents();
  }
})();
