/**
 * [INPUT]: 接收已打开的工作台 Playwright page、closeReader 辅助函数与 3 页测试 PDF 路径。
 * [OUTPUT]: 提供 testWebExcerpt、testAppendPdfExcerpt 与 testPdfBacklinksAndScannedOcr（含备份恢复演练及翻译/批注/AI 问答三面板回归）。
 * [POS]: 由 test-workspace.mjs 调用，专职验证阅读摘录双向回跳、扫描页离线识字入索引、完整备份恢复与右侧三面板核心交互。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function testWebExcerpt(page) {
  const quote = '链上要找回的这一句摘录。';
  await page.evaluate(async quoteText => {
    const before = '锚点之前。';
    const after = '锚点之后。';
    const html = '<p>填充段落。</p>'.repeat(40) + '<p>' + before + quoteText + after + '</p>';
    const fileId = crypto.randomUUID();
    const snapId = crypto.randomUUID();
    const recordId = crypto.randomUUID();
    const blob = new Blob([html], { type: 'text/html' });
    const snap = new Blob(['<!doctype html><title>出处网页</title>' + html], { type: 'text/html' });
    const capturedAt = new Date().toISOString();
    await put({
      id: recordId, type: 'resource', title: '出处网页', author: '', reference: '', url: '',
      body: '', date: today(), tags: [], status: '待读', pinned: false,
      attachments: [
        { id: fileId, name: 'article.html', mime: 'text/html', size: blob.size, addedAt: capturedAt, webRole: 'article' },
        { id: snapId, name: 'snapshot.html', mime: 'text/html', size: snap.size, addedAt: capturedAt, webRole: 'snapshot' }
      ],
      webArticle: { url: canonicalWebArticleUrl('https://example.com/source'), excerpt: quoteText, searchText: before + quoteText + after, capturedAt },
      updatedAt: capturedAt
    }, [
      { key: fileKey(appState.activeId, fileId), blob },
      { key: fileKey(appState.activeId, snapId), blob: snap }
    ]);
    await saveWebExcerpt({
      id: recordId, mode: 'article',
      selection: { quote: quoteText, start: before.length, end: before.length + quoteText.length, before, after }
    });
    const note = records.find(item => item.webSource?.recordId === recordId);
    if (!note || !validate(note)) throw new Error('excerpt note was not saved');
    if (validate({ ...note, webSource: { recordId, quote: ' ', start: 0, end: 1, before: '', after: '' } })) throw new Error('blank quote passed validate');
    const edited = { ...note };
    delete edited.webSource;
    await put(edited);
    if (records.find(item => item.id === note.id)?.webSource?.quote !== quoteText) throw new Error('editor save dropped webSource');
    showDetail(note.id);
    if (![...document.querySelectorAll('#detailContent button')].some(button => button.textContent === '打开原文摘录')) throw new Error('detail has no source button');
    await openWebEvidence(note.webSource);
  }, quote);
  await page.waitForFunction(quoteText => {
    const article = document.querySelector('.web-reader-article');
    const highlight = CSS.highlights?.get('web-article-focus');
    const range = highlight ? [...highlight][0] : null;
    return document.getElementById('reader')?.open && article?.textContent.includes(quoteText) && range?.toString() === quoteText;
  }, quote);
  console.log('PASS web excerpt: record keeps its source and jumps back to the quote');
}

export async function testAppendPdfExcerpt(page) {
  const saved = await page.evaluate(async () => {
    const fileId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const dailyId = crypto.randomUUID();
    const pdf = new Blob(['%PDF-1.1\n%%EOF'], { type: 'application/pdf' });
    const image = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
    const capturedAt = new Date().toISOString();
    await put({
      id: ownerId, type: 'resource', title: 'SAR ADC 论文', author: '', reference: '', url: '',
      body: '', date: today(), tags: [], status: '待读', pinned: false,
      attachments: [{ id: fileId, name: 'sar-adc.pdf', mime: 'application/pdf', size: pdf.size, addedAt: capturedAt }]
    }, [{ key: fileKey(appState.activeId, fileId), blob: pdf }]);
    const base = { date: today(), pinned: false, attachments: [], author: '', reference: '', url: '' };
    await put({ ...base, id: issueId, type: 'issue', title: '比较器失调', body: '待查', tags: [], status: '待排查' });
    await put({ ...base, id: dailyId, type: 'journal', title: '普通日志', body: '今天开会', tags: [], status: '已记录', journalKind: 'daily' });
    if (pdfExcerptTargets().some(item => item.id === dailyId)) throw new Error('plain journal was offered');
    if (!pdfExcerptTargets().some(item => item.id === issueId)) throw new Error('issue was hidden');
    const session = { file: { id: fileId, name: 'sar-adc.pdf' }, profileId: appState.activeId };
    const picked = { page: 3, rects: [[0.1, 0.2, 0.4, 0.15]], quote: '图 4', image };
    await appendPdfExcerpt(session, picked, issueId);
    const issue = records.find(item => item.id === issueId);
    if (!validate(issue) || issue.pdfEvidence?.[0]?.page !== 3 || issue.pdfEvidence[0].fileId !== fileId) throw new Error('evidence was not stored');
    if (!issue.attachments.some(file => file.mime === 'image/png')) throw new Error('chart image was not attached');
    const next = structuredClone(appState);
    const folderId = folderFromImportPath(next.profiles.find(item => item.id === next.activeId), 'issue', ['设计夹']);
    await commitState(next);
    const current = records.find(item => item.id === issueId);
    const edited = { ...current, folderId };
    delete edited.pdfEvidence;
    await put(edited);
    const moved = records.find(item => item.id === issueId);
    if (moved.folderId !== folderId || moved.pdfEvidence?.[0]?.fileId !== fileId) throw new Error('folder move dropped evidence');
    showDetail(issueId);
    const labeled = [...document.querySelectorAll('#detailContent h3')].some(node => node.textContent === '引用资料');
    const button = [...document.querySelectorAll('#detailContent button')].some(node => node.textContent === '打开 sar-adc.pdf · 第 3 页');
    if (!labeled || !button) throw new Error('source link missing');
    const zip = new JSZip();
    const owner = structuredClone(records.find(item => item.id === ownerId));
    const issueCopy = structuredClone(moved);
    owner.attachments[0].path = 'files/sar-adc.pdf';
    delete owner.attachments[0].sha256;
    zip.file(owner.attachments[0].path, pdf);
    for (const file of issueCopy.attachments || []) {
      file.path = 'files/' + file.id + '.png';
      delete file.sha256;
      zip.file(file.path, image);
    }
    const staged = await stageBackupRecords([owner, issueCopy], zip, { records: [] });
    const newFileId = staged.find(entry => entry.note.id === ownerId).note.attachments[0].id;
    const evidence = staged.find(entry => entry.note.id === issueId).note.pdfEvidence[0];
    if (evidence.fileId !== newFileId || evidence.page !== 3 || evidence.rects[0][0] !== 0.1) throw new Error('backup did not keep the source selection');
    return { issueId, fileId };
  });
  await page.reload();
  await page.waitForFunction(() => typeof ready !== 'undefined' && ready);
  assert.equal(await page.evaluate(saved => records.find(item => item.id === saved.issueId)?.pdfEvidence?.[0]?.fileId === saved.fileId, saved), true);
  console.log('PASS pdf excerpt append: evidence survives folder move, reload and backup remap');
}

export async function testPdfBacklinksAndScannedOcr(page, resumeFixture, closeReader) {
  const pdfBytes = Array.from(await readFile(resumeFixture));
  const seeded = await page.evaluate(async ({ pdfBytes }) => {
    const profileId = appState.activeId;
    const pdfBlob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    // 用内置 PDFLib 生成仅含位图、无内嵌文字层的真实单页扫描件 PDF。
    const raster = document.createElement('canvas');
    raster.width = 900;
    raster.height = 360;
    const g = raster.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, raster.width, raster.height);
    g.fillStyle = '#000000';
    g.font = 'bold 64px Arial, sans-serif';
    g.fillText('OFFSET 42MV', 72, 180);
    const pngBytes = new Uint8Array(await (await new Promise(resolve => raster.toBlob(resolve, 'image/png'))).arrayBuffer());
    const scanDoc = await PDFLib.PDFDocument.create();
    const pngImage = await scanDoc.embedPng(pngBytes);
    const scanPage = scanDoc.addPage([600, 240]);
    scanPage.drawImage(pngImage, { x: 0, y: 0, width: 600, height: 240 });
    const scanBlob = new Blob([await scanDoc.save()], { type: 'application/pdf' });

    const pdfFile = { id: crypto.randomUUID(), name: 'resume-backlink.pdf', mime: 'application/pdf', size: pdfBlob.size, addedAt: new Date().toISOString() };
    const scanFile = { id: crypto.randomUUID(), name: 'scan-comparator.pdf', mime: 'application/pdf', size: scanBlob.size, addedAt: new Date().toISOString() };
    const ownerId = crypto.randomUUID();
    const scanOwnerId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const base = { date: today(), pinned: false, author: '', reference: '', url: '', tags: [] };
    await put({ ...base, id: ownerId, type: 'resource', title: 'SAR ADC 双向引用验证', body: '', status: '待读', attachments: [pdfFile] },
      [{ key: fileKey(profileId, pdfFile.id), blob: pdfBlob }]);
    await put({ ...base, id: scanOwnerId, type: 'resource', title: '扫描件讲义', body: '', status: '待读', attachments: [scanFile] },
      [{ key: fileKey(profileId, scanFile.id), blob: scanBlob }]);
    await put({ ...base, id: issueId, type: 'issue', title: '比较器失调复盘', body: '核查失调来源', status: '待排查', attachments: [] });
    showDetail(issueId);
    const initialScanIndex = await buildPdfSearchIndex(scanFile, { profileId });
    if (!initialScanIndex.emptyPages.includes(1) || initialScanIndex.pages.length !== 0) {
      throw new Error('raster scanned PDF should start as an empty page');
    }
    await openAttachment(pdfFile);
    await readingSession.showPage(3);
    return { pdfFileId: pdfFile.id, scanFileId: scanFile.id, issueId };
  }, { pdfBytes });

  await page.waitForFunction(() => document.querySelector('[data-pdf-page="3"] canvas'));
  await page.evaluate(async ({ issueId }) => {
    await appendPdfExcerpt(readingSession, {
      page: 3, rects: [[0.12, 0.24, 0.5, 0.08]], quote: 'Comparator input-referred offset 1.25 mV'
    }, issueId);
    await savePdfExcerpt(readingSession, {
      page: 3, rects: [[0.12, 0.4, 0.45, 0.06]], quote: 'Dynamic latch regeneration tau = 18 ps'
    });
  }, seeded);

  const badge = page.locator('[data-pdf-page="3"] .pdf-backlink-badge');
  await badge.waitFor();
  assert.equal(await badge.innerText(), '被引用 2');
  assert.equal(await page.locator('#showPdfBacklinks').innerText(), '引用 2');
  await badge.click();
  await page.locator('#pdfBacklinksZone').waitFor();
  assert.equal(await page.locator('#pdfBacklinkCount').innerText(), '2 条记录 · 1 页');
  assert.match(await page.locator('#pdfBacklinkList').innerText(), /比较器失调复盘/);
  assert.match(await page.locator('#pdfBacklinkList').innerText(), /Comparator input-referred offset 1\.25 mV/);

  await page.locator('#pdfBacklinkList .pdf-backlink-title', { hasText: '比较器失调复盘' }).click();
  const detailOnTop = await page.evaluate(() => {
    const detail = document.getElementById('detail');
    const reader = document.getElementById('reader');
    const box = detail.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 24);
    return detail.open && reader.open && detail.contains(hit);
  });
  assert.equal(detailOnTop, true, '从阅读器点击反向引用时，记录详情应浮在阅读器上方且不销毁阅读会话');
  assert.equal(await page.locator('#detailContent .pdf-evidence-quote').innerText(), 'Comparator input-referred offset 1.25 mV');

  await page.locator('#detailContent button', { hasText: '打开 resume-backlink.pdf · 第 3 页' }).click();
  await page.waitForFunction(() =>
    !document.getElementById('detail').open &&
    document.getElementById('reader').open &&
    document.querySelector('[data-pdf-page="3"] .pdf-note-source-focus'));
  await closeReader(page);

  await page.evaluate(async scanFileId => {
    const file = records.flatMap(note => note.attachments || []).find(item => item.id === scanFileId);
    await openAttachment(file);
  }, seeded.scanFileId);
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] .pdf-text-layer'));
  await page.evaluate(async () => {
    const box = document.querySelector('[data-pdf-page="1"]');
    await recognizePdfRegion(readingSession, box, [0.04, 0.15, 0.85, 0.65], 1);
  });
  const recognized = await page.locator('#pdfTranslateSource').inputValue();
  assert.match(recognized, /OFFSET/i, '离线 OCR 应识别出扫描页文字: ' + recognized);
  await page.locator('#pdfTranslateSource').fill('OFFSET = 42 mV (calibrated)');
  const appendDone = page.locator('.pdf-selection-menu[aria-label="追加到已有记录"]');
  await page.locator('#appendPdfSelectionRecord').click();
  await appendDone.waitFor();
  await appendDone.locator('select').selectOption(seeded.issueId);
  await appendDone.getByRole('button', { name: '追加', exact: true }).click();
  await appendDone.waitFor({ state: 'hidden' });
  await closeReader(page);

  const ocrVerified = await page.evaluate(async ({ scanFileId, issueId }) => {
    const issue = records.find(note => note.id === issueId);
    const evidence = (issue?.pdfEvidence || []).find(item => item.fileId === scanFileId);
    const index = await readSearchIndex(scanFileId, appState.activeId);
    const hits = searchPdfIndex(index, 'offset');
    return {
      page: evidence?.page,
      rectX: evidence?.rects?.[0]?.[0],
      quote: evidence?.quote,
      emptyPages: index?.emptyPages,
      hitPage: hits[0]?.page || 0
    };
  }, seeded);
  assert.deepEqual(ocrVerified, {
    page: 1,
    rectX: 0.04,
    quote: 'OFFSET = 42 mV (calibrated)',
    emptyPages: [],
    hitPage: 1
  });

  await page.evaluate(() => document.getElementById('openPdfSearch').click());
  await page.locator('#pdfSearchDialog').waitFor();
  await page.locator('#workspaceSearchScope').selectOption('pdf');
  await page.locator('#pdfSearchQuery').fill('OFFSET');
  await page.locator('#pdfSearchResults .workspace-search-result[data-search-kind="pdf"]').filter({ hasText: '扫描件讲义' }).waitFor();
  await page.locator('#pdfSearchDialog [data-close="pdfSearchDialog"]').click();
  console.log('PASS pdf backlinks and scanned OCR: live page badge, top-layer detail jump, offline OCR excerpt and full-text index');

  await testBackupRestoreDrill(page, seeded, closeReader);
}

async function testBackupRestoreDrill(page, seeded, closeReader) {
  const drill = await page.evaluate(async ({ pdfFileId }) => {
    const sourceProfileId = appState.activeId;
    const restoreProfileId = crypto.randomUUID();
    function makeDirHandle(entries, prefix = '') {
      return {
        async getDirectoryHandle(name) {
          const nextPrefix = prefix + name + '/';
          if (!entries.some(item => item.path.startsWith(nextPrefix))) throw new Error('missing dir: ' + nextPrefix);
          return makeDirHandle(entries, nextPrefix);
        },
        async getFileHandle(name) {
          const entry = entries.find(item => item.path === prefix + name);
          if (!entry) throw new Error('missing file: ' + prefix + name);
          return { async getFile() { return new File([entry.blob], name, { type: entry.blob.type }); } };
        }
      };
    }
    const snapshot1 = await folderContents(false, { large: true, restoreOnly: true });
    const next = structuredClone(appState);
    next.profiles.push({
      id: restoreProfileId, name: '隔离恢复演练账户', role: '', topics: [...DEFAULT_TOPICS],
      categories: categoryDefaults(), journalLayoutVersion: 2, planLayoutVersion: 2,
      navLabels: {}, navDescriptions: {}, reading: {}, reminders: [], readingLists: [], folders: [], records: [], trash: []
    });
    next.activeId = restoreProfileId;
    await commitState(next);
    updateIdentity();
    render();
    window.__qaBackupSnapshots = { makeDirHandle, snapshot1, sourceProfileId, restoreProfileId, pdfFileId };
    window.showDirectoryPicker = async () => makeDirHandle(window.__qaBackupSnapshots.current);
    window.__qaBackupSnapshots.current = snapshot1;
    document.getElementById('restoreLargeBackupFolder').hidden = false;
    return { sourceProfileId, restoreProfileId };
  }, seeded);

  await page.evaluate(() => document.getElementById('backupBtn').click());
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restoreLargeBackupFolder').click();
  await page.waitForFunction(() => /导入完成：新增/.test(document.getElementById('importMessage')?.textContent || ''));
  await page.locator('#backup [data-close="backup"]').click();

  // 1. 验证隔离空账户恢复后：目录树保留、PDF 详情回跳 + 页面「被引用 2」角标正常
  showDetailAndJump: {
    await page.evaluate(issueId => showDetail(issueId), seeded.issueId);
    await page.locator('#detailContent button', { hasText: '打开 resume-backlink.pdf · 第 3 页' }).click();
    await page.waitForFunction(() =>
      document.getElementById('reader').open &&
      readingSession?.page === 3 &&
      document.querySelector('[data-pdf-page="3"] .pdf-note-source-focus'));
    assert.equal(await page.locator('[data-pdf-page="3"] .pdf-backlink-badge').innerText(), '被引用 2');
    await closeReader(page);
    await page.locator('#detail [data-close="detail"]').click();
  }

  // 2. 验证网页摘录回跳与高亮在恢复账户中完好
  await page.evaluate(async () => {
    const webNote = records.find(note => note.webSource?.quote === '链上要找回的这一句摘录。');
    if (!webNote) throw new Error('restored web excerpt note missing');
    await openWebEvidence(webNote.webSource);
  });
  await page.waitForFunction(() => {
    const highlight = CSS.highlights?.get('web-article-focus');
    const range = highlight ? [...highlight][0] : null;
    return document.getElementById('reader')?.open && range?.toString() === '链上要找回的这一句摘录。';
  });
  await closeReader(page);

  // 3. 验证扫描页离线 OCR 索引随备份迁移，无需重跑 OCR 即可全文检索命中
  await page.evaluate(() => document.getElementById('openPdfSearch').click());
  await page.locator('#pdfSearchDialog').waitFor();
  await page.locator('#workspaceSearchScope').selectOption('pdf');
  await page.locator('#pdfSearchQuery').fill('OFFSET');
  await page.locator('#pdfSearchResults .workspace-search-result[data-search-kind="pdf"]').filter({ hasText: '扫描件讲义' }).waitFor();
  await page.locator('#pdfSearchDialog [data-close="pdfSearchDialog"]').click();

  // 4. 增量合并恢复演练：原账户新增一条引用同一 PDF 第 2 页的仿真日志，再次合并进恢复账户（原 PDF 被跳过，新记录引用 fileId 自动重映射到恢复账户的附件 ID）
  const simNoteId = await page.evaluate(async ({ sourceProfileId, restoreProfileId, pdfFileId }) => {
    const switchTo = async id => {
      const state = structuredClone(appState);
      state.activeId = id;
      await commitState(state);
      updateIdentity();
      render();
    };
    await switchTo(sourceProfileId);
    const simId = crypto.randomUUID();
    await put({
      id: simId, type: 'study', title: '仿真复盘：再生时间常数', body: '蒙特卡洛仿真收敛记录',
      date: today(), status: '整理中', tags: ['仿真'], pinned: false, author: '', reference: '', url: '', attachments: []
    });
    await appendPdfExcerpt({ file: { id: pdfFileId, name: 'resume-backlink.pdf' }, profileId: sourceProfileId }, {
      page: 2, rects: [[0.15, 0.3, 0.4, 0.08]], quote: 'Monte Carlo sigma = 0.42 mV'
    }, simId);
    const snapshot2 = await folderContents(false, { large: true, restoreOnly: true });
    await switchTo(restoreProfileId);
    window.__qaBackupSnapshots.current = snapshot2;
    return simId;
  }, { ...drill, pdfFileId: seeded.pdfFileId });

  await page.evaluate(() => document.getElementById('backupBtn').click());
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restoreLargeBackupFolder').click();
  await page.waitForFunction(() => /导入完成：新增 1 条/.test(document.getElementById('importMessage')?.textContent || ''));
  await page.locator('#backup [data-close="backup"]').click();

  await page.evaluate(simId => showDetail(simId), simNoteId);
  assert.equal(await page.locator('#detailContent .pdf-evidence-quote').innerText(), 'Monte Carlo sigma = 0.42 mV');
  await page.locator('#detailContent button', { hasText: '打开 resume-backlink.pdf · 第 2 页' }).click();
  await page.waitForFunction(() =>
    document.getElementById('reader').open &&
    readingSession?.page === 2 &&
    document.querySelector('[data-pdf-page="2"] .pdf-note-source-focus'));
  assert.equal(await page.locator('[data-pdf-page="2"] .pdf-backlink-badge').innerText(), '被引用 1');
  await closeReader(page);
  await page.locator('#detail [data-close="detail"]').click();
  console.log('PASS end-to-end backup & restore drill: isolated profile recovery, PDF/web jump-back, OCR index carryover and incremental fileId remap');

  await testPdfReaderPanels(page, closeReader);
}

async function testPdfReaderPanels(page, closeReader) {
  await page.evaluate(async () => {
    const file = records.flatMap(note => note.attachments || []).find(item => item.name === 'resume-backlink.pdf');
    await openAttachment(file);
    await readingSession.showPage(1);
  });
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas'));

  // 1. 翻译面板：语向互换、电路术语胶囊插入译文、复制/清空联动
  assert.equal(await page.locator('#pdfLangFrom').innerText(), '英语');
  assert.equal(await page.locator('#pdfLangTo').innerText(), '中文');
  await page.locator('#pdfLangSwap').click();
  assert.equal(await page.locator('#pdfLangFrom').innerText(), '中文');
  assert.equal(await page.locator('#pdfLangTo').innerText(), '英语');
  await page.locator('#pdfLangSwap').click();

  await page.locator('#pdfTranslateSource').fill('The dynamic comparator exhibits offset voltage and thermal noise.');
  await page.locator('#pdfGlossarySlot .pdf-glossary-bar.has-matches').waitFor();
  assert.match(await page.locator('#pdfGlossarySlot .pdf-glossary-title').innerText(), /命中 3 个电路术语/);
  await page.locator('#pdfGlossarySlot .pdf-glossary-chip', { hasText: '比较器' }).click();
  assert.equal(await page.locator('#pdfTranslateResult').inputValue(), '比较器');
  assert.equal(await page.locator('#copyPdfTranslation').isVisible(), true);
  assert.equal(await page.locator('#pdfClearTranslation').isVisible(), true);
  await page.locator('#pdfClearTranslation').click();
  assert.equal(await page.locator('#pdfTranslateSource').inputValue(), '');
  assert.equal(await page.locator('#pdfTranslateResult').inputValue(), '');
  assert.equal(await page.locator('#copyPdfTranslation').isVisible(), false);

  // 2. 批注面板：页签计数、仅当前页过滤、渐进式添加思考、防抖自动保存、色点切换与回跳闪烁
  await page.evaluate(() => {
    readingSession.annotations.push(
      { id: crypto.randomUUID(), kind: 'highlight', page: 1, quote: 'Input-referred offset 1.25 mV', note: '', color: MARK_COLORS[0], rects: [[0.1, 0.2, 0.4, 0.06]], points: [], createdAt: new Date().toISOString() },
      { id: crypto.randomUUID(), kind: 'bookmark', page: 3, quote: '', note: '第 3 页频谱结果', color: MARK_COLORS[3], rects: [], points: [], createdAt: new Date().toISOString() }
    );
    savePdfMarks(readingSession);
    renderPdfSidebar(readingSession);
    renderPdfMarks(readingSession);
  });
  assert.equal(await page.locator('#showPdfAnnotations').innerText(), '批注 2');
  await page.locator('#showPdfAnnotations').click();
  assert.equal(await page.locator('#pdfAnnotationCount').innerText(), '2 条');

  await page.locator('#pdfAnnotationCurrentPage').click();
  assert.equal(await page.locator('#pdfAnnotationCurrentPage').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#pdfAnnotationCount').innerText(), '1 / 2 条');
  assert.equal(await page.locator('#pdfAnnotationList .pdf-note').count(), 1);

  const highlightCard = page.locator('#pdfAnnotationList .pdf-note').first();
  assert.equal(await highlightCard.locator('textarea').count(), 0, '无文字批注的高亮卡默认折叠输入框');
  await highlightCard.locator('.pdf-note-add-body').click();
  await highlightCard.locator('textarea').fill('蒙特卡洛 200 次失配抽样复核');
  await page.waitForFunction(() =>
    readingSession.annotations.find(item => item.kind === 'highlight')?.note === '蒙特卡洛 200 次失配抽样复核');

  const initialColor = await page.evaluate(() => readingSession.annotations.find(item => item.kind === 'highlight').color);
  await highlightCard.locator('.pdf-note-swatch').click();
  const nextColor = await page.evaluate(() => readingSession.annotations.find(item => item.kind === 'highlight').color);
  assert.notEqual(nextColor, initialColor, '点击圆点色标应切换批注颜色');
  await highlightCard.locator('.pdf-note-link').click();
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] .pdf-note-source-focus'));
  await page.locator('#pdfAnnotationCurrentPage').click();
  assert.equal(await page.locator('#pdfAnnotationList .pdf-note').count(), 2);

  // 3. AI 问答面板：快捷提问、SSE 流式回答、LaTeX 公式防转义渲染、页码胶囊跳转与存为笔记
  const aiRoute = 'http://127.0.0.1:11434/v1/chat/completions';
  await page.route(aiRoute, async route => {
    const sseChunks = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '依据 **Pelgrom 失配模型** [第 1 页]，折合失调标准差为：\n\n$$\\sigma(V_{OS}) = \\frac{A_{VT}}{\\sqrt{W \\cdot L}}$$\n\n' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '增大栅面积会抬升输入寄生电容 $C_{gg}$，可结合 [第 2 页] 校准时序权衡。' } }] }) + '\n\n',
      'data: [DONE]\n\n'
    ].join('');
    await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sseChunks });
  });
  try {
    await page.evaluate(() => {
      aiCredentials.set(appState.activeId, { base: 'http://127.0.0.1:11434/v1', model: 'Qwen3-32B-Instruct', key: '' });
      syncAiModelPill();
    });
    await page.locator('#showReaderAi').click();
    assert.equal(await page.locator('#readerAiModelLabel').innerText(), 'Qwen3-32B-Instruct');
    assert.equal(await page.locator('#readerAiEmpty .ai-prompt-chip').count(), 4);
    await page.locator('#readerAiContext').selectOption('nearby');
    await page.locator('#readerAiEmpty .ai-prompt-chip', { hasText: '推导关键公式' }).click();

    await page.locator('#readerAiMessages .ai-exchange .ai-actions').waitFor();
    assert.equal(await page.locator('#readerAiEmpty').isVisible(), false);
    assert.equal(await page.locator('#readerAiMessages .ai-answer-body strong').innerText(), 'Pelgrom 失配模型');
    const katexCount = await page.locator('#readerAiMessages .ai-answer-body .katex').count();
    assert.equal(katexCount >= 2, true, '独立公式与行内公式均应经 KaTeX 渲染且不被下划线破坏');

    const beforeNotes = await page.evaluate(() => records.filter(note => note.type === 'paper').length);
    await page.locator('#readerAiMessages .ai-action', { hasText: '存为笔记' }).click();
    await page.waitForFunction(prev => records.filter(note => note.type === 'paper').length === prev + 1, beforeNotes);

    await page.locator('#readerAiMessages .ai-page-chip', { hasText: '第 2 页' }).click();
    await page.waitForFunction(() => readingSession?.page === 2);
  } finally {
    await page.unroute(aiRoute);
  }
  await closeReader(page);
  console.log('PASS pdf reader panels: translation glossary & swap, compact annotations & current-page filter, streaming KaTeX AI Q&A & note save');
}
