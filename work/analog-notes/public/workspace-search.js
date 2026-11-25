/**
 * [INPUT]: 读取记录库、PDF/PPT 页面文字索引、逐页批注与视频字幕/定格批注。
 * [OUTPUT]: 提供跨记录、PDF、PPT 讲义及视频时间轴的 MiniSearch 全库全文检索与直达跳页。
 * [POS]: 工作台全局全文检索弹窗控制器，按需构建并缓存当前账户的多模态检索索引。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

// Catalog search shares the PDF/PPT page-text cache with the reader. MiniSearch indexes are
// derived on demand and kept in a small, profile-scoped working set.
(() => {
 const dialog = $('pdfSearchDialog');
 const input = $('pdfSearchQuery');
 const status = $('pdfSearchStatus');
 const results = $('pdfSearchResults');
 const launch = $('openPdfSearch');
 const controls = document.createElement('div');
 controls.className = 'row';
 controls.innerHTML = '<label>范围 <select id="workspaceSearchScope"><option value="all">全部</option><option value="pdf">PDF 文献与批注</option><option value="ppt">PPT 讲义与批注</option><option value="video">视频字幕与批注</option><option value="note">记录与笔记</option></select></label><button type="button" class="secondary" id="workspaceSearchPause" hidden>暂停文档索引</button><button type="button" class="secondary" id="workspaceSearchResume" hidden>继续 / 重试索引</button>';
 status.before(controls);
 const scope = $('workspaceSearchScope');
 const pause = $('workspaceSearchPause');
 const resume = $('workspaceSearchResume');
 $('pdfSearchTitle').textContent = '全库全文检索';
 dialog.querySelector('.section-note').textContent = '离线搜索记录、PDF 正文、PPT 讲义/备注/批注、视频字幕和定格批注。点击结果直达对应页码、幻灯片或视频时间。';
 input.setAttribute('aria-label', '搜索资料库全文');
 input.maxLength = 120;
 launch.textContent = '全文检索';

 const displayLimit = 80;
 const perSourceLimit = 12;
 const cacheLimit = 7200000;
 const sourceCache = new Map();
 let cachedProfile;
 let cacheWeight = 0;
 let cacheRevision = 0;
 let session = null;

 function searchTokens(text, field) {
  const tokens = [];
  const words = text.normalize('NFKC').toLowerCase()
   .match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}\p{M}])+/gu) || [];
  for (const word of words) {
   if (!/^\p{Script=Han}/u.test(word)) {
    tokens.push(word);
    continue;
   }
   const letters = [...word];
   for (let i = 0; i < letters.length; i++) {
    if (field || letters.length === 1) tokens.push(letters[i]);
    if (i + 1 < letters.length) tokens.push(letters[i] + letters[i + 1]);
   }
  }
  return tokens;
 }

 function createIndex() {
  return new MiniSearch({
   fields: ['title', 'text'],
   tokenize: searchTokens,
   searchOptions: {
    boost: {title: 3},
    combineWith: 'AND',
    prefix: term => term.length >= 2 && !/\p{Script=Han}/u.test(term),
    fuzzy: term => term.length >= 5 && term.length <= 40 && /^\p{Script=Latin}+$/u.test(term) ? 0.2 : false,
   },
  });
 }

 function queryTerms(text) {
  return [...new Set(searchTokens(text))];
 }

 function excerpt(text, needle, terms, matchedTerms, normalized) {
  const found = normalized.indexOf(needle);
  const firstTerm = found < 0 && (terms.find(term => normalized.includes(term)) ||
   matchedTerms.find(term => normalized.includes(term)));
  const position = found >= 0 ? found : firstTerm ? normalized.indexOf(firstTerm) : 0;
  const start = Math.max(0, position - 42);
  const end = Math.min(text.length, start + 174);
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
 }

 function matchingRows(entry, query) {
  if (!entry?.index) return {count: 0, rows: []};
  const phrase = query.normalize('NFKC').toLowerCase();
  const terms = queryTerms(phrase);
  const hanPhrases = phrase.match(/\p{Script=Han}+/gu) || [];
  const matches = entry.index.search(query);
  const selected = [];
  for (const hit of matches) {
   const item = entry.documents.get(hit.id);
   const normalizedTitle = item.title?.normalize('NFKC').toLowerCase() || '';
   const normalizedText = item.text.normalize('NFKC').toLowerCase();
   const fullPhrase = normalizedTitle.includes(phrase) || normalizedText.includes(phrase);
   // Chinese bigrams can occur separately in a page; verify the complete query fragments.
   if (hanPhrases.some(term => !normalizedTitle.includes(term) && !normalizedText.includes(term))) continue;
   const rank = Math.log1p(hit.score) + (fullPhrase ? 3 : 0) + (normalizedTitle.includes(phrase) ? 2 : 0);
   selected.push({item, rank, normalizedText, matchedTerms: hit.terms});
  }
  const limit = entry.notes ? displayLimit : perSourceLimit;
  const rows = selected.sort((a, b) => b.rank - a.rank).slice(0, limit).map(({item, rank, normalizedText, matchedTerms}) => {
   const {text, ...location} = item;
   return {...location, rank, snippet: excerpt(text, phrase, terms, matchedTerms, normalizedText)};
  });
  return {count: selected.length, rows};
 }

 let notesIndex;
 function syncNotes(noteRecords) {
  if (notesIndex?.records === noteRecords) return notesIndex;
  notesIndex ||= {index: createIndex(), documents: new Map(), notes: true};
  const {documents, index} = notesIndex;
  const active = new Set();
  for (const note of noteRecords) {
   if (note.flashcardKind) continue;
   active.add(note.id);
   const body = note.body || (note.bodyHtml && richPlainText(safeRichHtml(note.bodyHtml)));
   const text = [note.author, note.reference, body, note.webArticle?.searchText, ...note.tags,
    ...Object.values(note.literature || {}).filter(value => typeof value === 'string'),
    ...(note.attachments || []).map(file => file.name)].filter(Boolean).join(' ');
   const previous = documents.get(note.id);
   if (previous?.title === note.title && previous.text === text) continue;
   const item = {id: note.id, noteId: note.id, kind: 'note', title: note.title, text};
   if (previous) index.replace(item);
   else index.add(item);
   documents.set(note.id, item);
  }
  for (const id of documents.keys()) {
   if (active.has(id)) continue;
   index.discard(id);
   documents.delete(id);
  }
  notesIndex.records = noteRecords;
  return notesIndex;
 }

 const sourceKey = ({kind, file}) => kind + '/' + file.id;
 const fileStamp = file => [file.name, file.mime, file.size, file.addedAt, file.sha256].join('\u0000');
 const allowPdf = () => scope.value === 'all' || scope.value === 'pdf';
 const allowPpt = () => scope.value === 'all' || scope.value === 'ppt';
 const allowDocIndex = () => allowPdf() || allowPpt();
 const activeProfile = current => current.profileId === appState.activeId;

 function clearCachedSource(key) {
  const saved = sourceCache.get(key);
  if (!saved) return;
  cacheWeight -= saved.weight;
  sourceCache.delete(key);
 }

 function rememberSource(key, entry) {
  clearCachedSource(key);
  if (entry.weight > cacheLimit) return;
  while (cacheWeight + entry.weight > cacheLimit || sourceCache.size >= 64) {
   clearCachedSource(sourceCache.keys().next().value);
  }
  sourceCache.set(key, entry);
  cacheWeight += entry.weight;
 }

 function resetCache(profileId) {
  if (cachedProfile === profileId) return;
  cachedProfile = profileId;
  cacheRevision++;
  sourceCache.clear();
  cacheWeight = 0;
  notesIndex = null;
 }

 function searchSources(noteRecords) {
  const sources = new Map();
  for (const note of noteRecords) for (const file of note.attachments || []) {
   const kind = fileIsPdf(file) ? 'pdf' : (typeof fileIsPresentation === 'function' && fileIsPresentation(file)) ? 'ppt' : fileIsVideo(file) ? 'video' : '';
   if (!kind) continue;
   const source = {kind, file, note};
   const key = sourceKey(source);
   if (!sources.has(key) || note.videoSubtitles?.[file.id]?.length) sources.set(key, source);
  }
  return [...sources.values()];
 }

 function sameTimedText(a, b, subtitle) {
  return a === b || (a?.length || 0) === (b?.length || 0) && (!a?.length || a.every((item, i) => {
   const other = b[i];
   return subtitle ? item.start === other.start && item.en === other.en && item.zh === other.zh
                   : item.id === other.id && item.time === other.time && item.text === other.text;
  }));
 }

 async function indexSource(profileId, source, signal) {
  const {kind, file, note} = source;
  const key = sourceKey(source);
  const stamp = fileStamp(file);
  const subtitles = Array.isArray(note.videoSubtitles?.[file.id]) ? note.videoSubtitles[file.id] : undefined;
  const backupFrames = file.videoFrameNotes?.map(({id, time, text}) => ({id, time, text}));
  const revision = cacheRevision;
  const cached = sourceCache.get(key);
  if (cached?.stamp === stamp && sameTimedText(cached.subtitles, subtitles, true) && sameTimedText(cached.backupFrames, backupFrames, false)) {
   sourceCache.delete(key);
   sourceCache.set(key, cached);
   return cached;
  }
  const entries = [];
  const location = {noteId: note.id, fileId: file.id};
  let pdf;
  if (kind === 'pdf' || kind === 'ppt') {
   const [docIdx, marks] = await Promise.all([
    readSearchIndex(file.id, profileId),
    typeof fileAnnotations === 'function' ? fileAnnotations(profileId, file).catch(() => []) : Promise.resolve([])
   ]);
   pdf = docIdx;
   const byPage = new Map((pdf?.pages || []).map(p => [p.n, p.text]));
   for (const mark of marks || []) {
    if (!Number.isInteger(mark?.page) || mark.page < 1) continue;
    const extra = [mark.quote, mark.note].filter(Boolean).join(' ').trim();
    if (!extra) continue;
    const prev = byPage.get(mark.page) || '';
    if (!prev.includes(extra)) byPage.set(mark.page, (prev ? prev + ' · ' + extra : extra).slice(0, 60000));
   }
   for (const [pageNum, pageText] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    entries.push({...location, id: 'p' + pageNum, kind, page: pageNum, text: pageText});
   }
  } else {
   for (const [i, cue] of (subtitles || []).entries()) {
    if (!Number.isFinite(cue.start) || cue.start < 0) continue;
    const text = [cue.en, cue.zh].filter(Boolean).join(' · ');
    if (text) entries.push({...location, id: 's' + i, kind: 'subtitle', time: cue.start, text});
   }
   const frames = await fileVideoFrameNotes(profileId, file);
   for (const frame of frames) {
    if (frame.text.trim()) entries.push({...location, id: 'f' + frame.id, kind: 'frame', time: frame.time, text: frame.text});
   }
  }
  signal.throwIfAborted();
  const index = entries.length ? createIndex() : null;
  // Yield between batches so assembling a cached large PDF does not block typing.
  for (let start = 0; start < entries.length; start += 28) {
   index.addAll(entries.slice(start, start + 28));
   if (start + 28 < entries.length) await new Promise(resolve => setTimeout(resolve, 0));
   signal.throwIfAborted();
  }
  const weight = entries.reduce((total, entry) => total + entry.text.length + 100, 0);
  const documents = new Map(entries.map(entry => [entry.id, entry]));
  const entry = {
   stamp, subtitles, backupFrames, index, documents, weight,
   incomplete: (kind === 'pdf' || kind === 'ppt') && (!pdf || pdf.scannedPages < pdf.totalPages),
   failedPages: !!pdf?.failedPages.length,
   warning: pdf && pdfIndexCoverage(pdf),
  };
  // File caches can change while this async index is being assembled.
  if (cachedProfile === profileId && revision === cacheRevision) rememberSource(key, entry);
  return entry;
 }

 function seekVideoResult(reader, time) {
  const video = reader.video;
  if (!video) return;
  const seek = () => {
   if (readingSession !== reader) return;
   if (Number.isFinite(video.duration)) video.currentTime = Math.min(time, video.duration);
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
  else video.addEventListener('loadedmetadata', seek, {once: true, signal: reader.controller.signal});
 }

 async function openResult(current, result) {
  if (!activeProfile(current)) return;
  const owner = records.find(note => note.id === result.noteId);
  const file = owner?.attachments?.find(item => item.id === result.fileId);
  if (!owner || result.kind !== 'note' && !file) {
   toast('这条搜索结果已移除，请重新搜索。');
   return;
  }
  dialog.close();
  if (result.kind === 'note') { showDetail(owner.id); return; }
  await openAttachment(file);
  const reader = readingSession;
  if (reader?.file.id !== file.id || reader.profileId !== current.profileId) return;
  if (result.kind === 'pdf' || result.kind === 'ppt') reader.showPage?.(result.page);
  else seekVideoResult(reader, result.time);
 }

 function formatTime(seconds) {
  const total = Math.floor(seconds);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
   .map(value => String(value).padStart(2, '0')).join(':');
 }

 function drawResults(current, run) {
  if (!run || session !== current || current.run !== run || run.signal.aborted || !activeProfile(current)) return;
  const groups = [...run.matches.values()];
  const count = groups.reduce((total, group) => total + group.count, 0);
  const rows = groups.flatMap(group => group.rows).sort((a, b) => b.rank - a.rank).slice(0, displayLimit);
  const progress = run.scanning ? '正在查找已有索引…' : current.indexProgress || '';
  const pausedLabel = current.paused && allowDocIndex() ? '文档索引已暂停' : '';
  status.textContent = [count ? '共 ' + count + ' 处命中' + (count > rows.length ? '，显示 ' + rows.length + ' 处' : '') :
   progress ? '暂未命中' : '没有找到匹配内容', pausedLabel || progress].filter(Boolean).join(' · ');
  pause.hidden = !current.indexing || current.paused;
  resume.hidden = !allowDocIndex() || (!current.paused && !run.retryable.size);
  if (results.contains(document.activeElement)) return;
  const fragment = document.createDocumentFragment();
  const labels = {note: '记录', pdf: 'PDF', ppt: 'PPT 讲义', subtitle: '字幕', frame: '定格批注'};
  for (const row of rows) {
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'pdf-search-doc workspace-search-result';
   button.dataset.searchKind = row.kind;
   const title = document.createElement('strong');
   const where = (row.kind === 'pdf' || row.kind === 'ppt') ? ' · 第 ' + row.page + ' 页' : row.time !== undefined ? ' · ' + formatTime(row.time) : '';
   title.textContent = (row.resultTitle || row.title) + ' · ' + labels[row.kind] + where;
   const snippet = document.createElement('span');
   snippet.textContent = row.snippet;
   button.append(title);
   if (row.fileName && row.fileName !== row.resultTitle) {
    const filename = document.createElement('small');
    filename.textContent = row.fileName;
    button.append(filename);
   }
   if (row.snippet) button.append(snippet);
   button.onclick = () => void openResult(current, row);
   fragment.append(button);
  }
  const warnings = [...run.warnings.values()].filter(Boolean);
  if (warnings.length) {
   const details = document.createElement('details');
   details.className = 'section-note';
   const summary = document.createElement('summary');
   summary.textContent = '索引详情（' + warnings.length + ' 份）';
   details.append(summary);
   for (const warning of warnings) {
    const line = document.createElement('p');
    line.textContent = warning;
    details.append(line);
   }
   fragment.append(details);
  }
  results.replaceChildren(fragment);
 }

 async function scanSource(current, run, source) {
  const key = sourceKey(source);
  const name = source.file.name;
  const scan = Symbol();
  run.scans.set(key, scan);
  try {
   const entry = await indexSource(current.profileId, source, run.signal);
   run.signal.throwIfAborted();
   if (run.scans.get(key) !== scan) return entry;
   const {count, rows} = matchingRows(entry, run.query);
   for (const row of rows) {
    row.resultTitle = source.note.title || name;
    row.fileName = name;
    row.noteId = source.note.id;
   }
   run.matches.set(key, {count, rows});
   run.warnings.set(key, current.failures.get(key) || (entry.warning ? name + ' · ' + entry.warning : ''));
   if (entry.failedPages || current.failures.has(key)) run.retryable.add(key);
   else run.retryable.delete(key);
   return entry;
  } catch (error) {
   if (!run.signal.aborted && run.scans.get(key) === scan) {
    run.warnings.set(key, name + ' · 读取索引失败（' + error.message + '）');
    if (source.kind === 'pdf') run.retryable.add(key);
   }
   return null;
  }
 }

 function stopPdfIndex(current) {
  const controller = current.indexing;
  if (!controller) return;
  current.indexing = null;
  current.indexProgress = '';
  controller.abort();
 }

 async function indexMissingPdfs(current, sources, retry) {
  if (current.indexing || current.paused || !sources.length) return;
  const controller = new AbortController();
  const {signal} = controller;
  current.indexing = controller;
  try {
   for (const [i, source] of sources.entries()) {
    if (signal.aborted || !activeProfile(current)) break;
    const key = sourceKey(source);
    const kindName = source.kind === 'ppt' ? 'PPT' : 'PDF';
    const label = '建立 ' + kindName + ' 索引 ' + (i + 1) + '/' + sources.length + ' · ' + source.file.name;
    const update = suffix => {
     if (signal.aborted || session !== current || !activeProfile(current)) return;
     const old = current.indexProgress;
     current.indexProgress = label + suffix;
     const displayed = status.textContent;
     if (old && displayed.endsWith(old)) status.textContent = displayed.slice(0, -old.length) + current.indexProgress;
     else if (current.run) drawResults(current, current.run);
    };
    update('…');
    try {
     if (source.kind === 'ppt' && typeof buildPresentationSearchIndex === 'function') {
      await buildPresentationSearchIndex(source.file, {profileId: current.profileId, signal,
       onProgress: ({page, total}) => update(' · ' + page + '/' + total + ' 页')});
     } else {
      await buildPdfSearchIndex(source.file, {profileId: current.profileId, signal, retry,
       onProgress: ({page, total}) => update(' · ' + page + '/' + total + ' 页')});
     }
     current.failures.delete(key);
    } catch (error) {
     if (signal.aborted) break;
     current.failures.set(key, source.file.name + ' · 索引失败（' + error.message + '）');
    }
    const run = current.run;
    if (!signal.aborted && run && !run.signal.aborted && ((source.kind === 'pdf' && allowPdf()) || (source.kind === 'ppt' && allowPpt()))) {
     clearCachedSource(key);
     await scanSource(current, run, source);
     drawResults(current, run);
    }
   }
  } finally {
   if (current.indexing === controller) {
    current.indexing = null;
    current.indexProgress = '';
    if (current.run) drawResults(current, current.run);
   }
  }
 }

 async function runSearch(current, retry = false) {
  current.controller?.abort();
  current.controller = new AbortController();
  const signal = current.controller.signal;
  const query = input.value.trim();
  current.run = null;
  results.replaceChildren();
  pause.hidden = !current.indexing;
  resume.hidden = !current.paused || !allowDocIndex();
  if (!queryTerms(query).length) {
   stopPdfIndex(current);
   pause.hidden = true;
   status.textContent = query ? '请输入可搜索的文字或数字。' : '';
   return;
  }
  const run = {query, signal, scans: new Map(), matches: new Map(), warnings: new Map(), retryable: new Set(), scanning: true};
  current.run = run;
  try {
   const noteRecords = records;
   const sources = searchSources(noteRecords);
   if (scope.value === 'all' || scope.value === 'note') {
    run.matches.set('records', matchingRows(syncNotes(noteRecords), query));
   }
   drawResults(current, run);
   const docs = sources.filter(source => (source.kind === 'pdf' && allowPdf()) || (source.kind === 'ppt' && allowPpt()));
   const videos = scope.value === 'all' || scope.value === 'video' ? sources.filter(source => source.kind === 'video') : [];
   for (const source of videos) {
    signal.throwIfAborted();
    await scanSource(current, run, source);
   }
   drawResults(current, run);
   const pending = [];
   let lastPublish = performance.now();
   for (const source of docs) {
    signal.throwIfAborted();
    const entry = await scanSource(current, run, source);
    if (!current.failures.has(sourceKey(source)) && (!entry || entry.incomplete || retry && entry.failedPages)) pending.push(source);
    if (performance.now() - lastPublish >= 100) {
     drawResults(current, run);
     lastPublish = performance.now();
    }
   }
   signal.throwIfAborted();
   run.scanning = false;
   drawResults(current, run);
   void indexMissingPdfs(current, pending, retry);
  } catch (error) {
   if (!signal.aborted && current.run === run) status.textContent = '检索失败。' + error.message;
  }
 }

 function openSearch() {
  if (!ensureReady() || dialog.open) return;
  if (typeof MiniSearch !== 'function') { toast('本地检索组件未加载。'); return; }
  const current = {profileId: appState.activeId, failures: new Map(), paused: false};
  resetCache(current.profileId);
  session = current;
  input.value = '';
  scope.value = 'all';
  results.replaceChildren();
  status.textContent = '';
  pause.hidden = true;
  resume.hidden = true;
  dialog.showModal();
  input.focus();
 }

 function runCurrent(retry = false) {
  if (!session || !activeProfile(session)) return;
  clearTimeout(session.timer);
  if (retry) session.failures.clear();
  void runSearch(session, retry);
 }

 launch.onclick = openSearch;
 results.addEventListener('focusout', () => {
  const current = session;
  if (current?.run) setTimeout(() => drawResults(current, current.run), 0);
 });
 dialog.addEventListener('close', () => {
  if (!session || dialog.open) return;
  clearTimeout(session.timer);
  session.controller?.abort();
  stopPdfIndex(session);
  session = null;
 });
 input.oninput = () => {
  if (!session) return;
  clearTimeout(session.timer);
  session.controller?.abort();
  session.timer = setTimeout(runCurrent, 220);
 };
 input.onkeydown = event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  runCurrent();
 };
 scope.onchange = () => {
  if (session && !allowDocIndex()) stopPdfIndex(session);
  runCurrent();
 };
 pause.onclick = () => {
  if (!session) return;
  session.paused = true;
  stopPdfIndex(session);
  if (session.run) drawResults(session, session.run);
 };
 resume.onclick = () => {
  if (!session) return;
  session.paused = false;
  stopPdfIndex(session);
  runCurrent(true);
 };

 document.addEventListener('workspace-search-file-updated', ({detail}) => {
  if (!detail || detail.profileId !== cachedProfile) return;
  const key = String(detail.key || '');
  cacheRevision++;
  if (!key || key.startsWith('pdf-index-v3/') || key.startsWith('pdf-marks/') || key.startsWith('annotations/')) {
   clearCachedSource('pdf/' + detail.fileId);
   clearCachedSource('ppt/' + detail.fileId);
  }
  if (!key || key.startsWith('video-frame-notes/')) {
   clearCachedSource('video/' + detail.fileId);
  }
 });
 document.addEventListener('workspace-search-profile', () => {
  resetCache(appState.activeId);
  if (dialog.open && session && !activeProfile(session)) dialog.close();
 });
})();
