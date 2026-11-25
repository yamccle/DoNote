/**
 * [INPUT]: 接收已打开的工作台 Playwright page、closeReader 辅助函数与 3 页测试 PDF 路径。
 * [OUTPUT]: 提供 testWebExcerpt、testAppendPdfExcerpt 与 testPdfBacklinksAndScannedOcr（含备份恢复、PDF 三面板、PPT 知识库、三栏设置与单进程网页抓取回归）。
 * [POS]: 由 test-workspace.mjs 调用，专职验证阅读摘录双向回跳、扫描页离线识字入索引、完整备份恢复、PDF/PPT 阅读器与设置中心核心交互。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyPlatformEvolutionR139 } from './workspace-r139.mjs';
import { verifyRefinementsAndSyncProR140 } from './workspace-r140.mjs';

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
  assert.match(await page.locator('#pdfGlossarySlot .pdf-glossary-title').innerText(), /命中 3 个专业术语/);
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

  await testPresentationSettingsAndFastWeb(page, closeReader);
}

async function testPresentationSettingsAndFastWeb(page, closeReader) {
  // 1. PPT 资料库级预览：首页封面缩略图、讲义提取、逐页批注、网格总览、仅已批注筛选、存为研究笔记与反向跳回对应幻灯片
  const pptInfo = await page.evaluate(async () => {
    const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
    zip.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/></Relationships>');
    zip.file('ppt/slides/_rels/slide2.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>');
    const slideXml = title => `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F4F7F4"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="600000" y="900000"/><a:ext cx="7800000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2800" b="1"><a:solidFill><a:srgbClr val="1F3A2E"/></a:solidFill></a:rPr><a:t>${x(title)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    zip.file('ppt/slides/slide1.xml', slideXml('Slide 01 · Noise Transfer Function'));
    zip.file('ppt/slides/slide2.xml', slideXml('Slide 02 · Kickback Neutralization'));
    zip.file('ppt/slides/slide3.xml', slideXml('Slide 03 · Silicon Measurement'));
    zip.file('ppt/notesSlides/notesSlide2.xml', '<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>讲义备注：中和电容需兼顾寄生电容温度漂移。</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>');
    const pptBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const pptFile = { id: crypto.randomUUID(), name: 'comparator-lecture.pptx', mime: pptBlob.type, size: pptBlob.size, addedAt: new Date().toISOString() };
    const ownerId = crypto.randomUUID();
    await put({
      id: ownerId, type: 'resource', title: '比较器电路讲义 PPTX', author: 'Dr. Razavi', reference: '', url: '',
      body: '', date: today(), tags: ['讲义'], status: '待读', pinned: false, attachments: [pptFile]
    }, [{ key: fileKey(appState.activeId, pptFile.id), blob: pptBlob }]);
    $('search').value = '';
    $('libraryKind').value = '';
    $('libraryStatus').value = '';
    topic = '';
    switchView('resource');
    revealFolderLocation('resource', FOLDER_ALL);
    render();
    document.querySelector(`#records .card[data-id="${ownerId}"]`)?.scrollIntoView({ block: 'center' });
    return { ownerId, fileId: pptFile.id };
  });

  await page.waitForFunction(ownerId => {
    const img = document.querySelector(`.library-gallery .card[data-id="${ownerId}"] .library-cover img`);
    return img && img.complete && img.naturalWidth > 100;
  }, pptInfo.ownerId);

  await page.evaluate(async fileId => {
    const file = records.flatMap(n => n.attachments || []).find(a => a.id === fileId);
    await openAttachment(file);
  }, pptInfo.fileId);
  await page.locator('#pptFilmstripList .ppt-thumb-card').nth(2).waitFor();
  assert.equal(await page.locator('#pptFilmstripList .ppt-thumb-card').count(), 3);

  await page.locator('#pptFilmstripList .ppt-thumb-card').nth(1).click();
  await page.waitForFunction(() => document.getElementById('pptPageNumber')?.value === '2');
  assert.match(await page.locator('#pptCurrentSlideTitle').innerText(), /Kickback Neutralization/);
  assert.match(await page.locator('#pptSpeakerText').innerText(), /中和电容需兼顾寄生电容温度漂移/);

  await page.locator('#pptSlideNoteInput').fill('第 2 页复盘：补充抽取后仿 Cgd 偏置曲线');
  await page.waitForFunction(() => document.getElementById('pptToggleNotes')?.textContent === '批注 1');

  await page.locator('#pptGridToggle').click();
  assert.equal(await page.locator('#pptGridView').isVisible(), true);
  await page.locator('#pptFilterNoted').click();
  assert.equal(await page.locator('#pptGridView .ppt-thumb-card').count(), 1);
  await page.locator('#pptFilterNoted').click();
  await page.locator('#pptGridToggle').click();

  const beforePaperCount = await page.evaluate(() => records.filter(n => n.type === 'paper').length);
  await page.locator('#pptSaveAsNote').click();
  await page.waitForFunction(prev => records.filter(n => n.type === 'paper').length === prev + 1, beforePaperCount);
  const slideNoteId = await page.evaluate(fileId => {
    const note = records.find(n => n.type === 'paper' && n.pdfSource?.fileId === fileId && n.pdfSource?.page === 2);
    if (!note || !note.attachments?.some(a => a.mime === 'image/png')) throw new Error('PPT slide note missing screenshot or source');
    return note.id;
  }, pptInfo.fileId);

  // 验证 PPT 一键导出双栏图文讲义 (.html) 与结构化大纲 (.md)
  await page.locator('#pptExportHandout').click();
  await page.waitForFunction(() => window.__lastExportedPptHandout?.format === 'html' && window.__lastExportedPptHandout.slideCount === 3);
  await page.locator('#pptExportHandout').click({ modifiers: ['Shift'] });
  const mdExport = await page.evaluate(() => window.__lastExportedPptHandout);
  assert.equal(mdExport.format, 'md');
  assert.match(mdExport.text, /补充抽取后仿 Cgd 偏置曲线/);
  assert.match(mdExport.text, /中和电容需兼顾寄生电容温度漂移/);
  await closeReader(page);

  // 验证 Bento 总览圆环进度卡、问候眉标与 7天柱状活跃图
  await page.evaluate(() => switchView('all'));
  assert.match(await page.locator('#homeResume').innerText(), /PPT · 第 2 \/ 3 页/);
  assert.equal(await page.locator('#homeResume .bento-study-card .bento-ring').count() >= 1, true);
  assert.equal(await page.locator('#homeGreeting').isVisible(), true);

  await page.evaluate(id => showDetail(id), slideNoteId);
  await page.locator('#detailContent button', { hasText: '打开 comparator-lecture.pptx · 第 2 页' }).click();
  await page.waitForFunction(() =>
    document.getElementById('reader').open &&
    document.getElementById('pptPageNumber')?.value === '2' &&
    document.getElementById('pptSlideNoteInput')?.value.includes('补充抽取后仿 Cgd 偏置曲线'));
  await closeReader(page);
  if (await page.locator('#detail').evaluate(d => d.open)) {
    await page.locator('#detail [data-close="detail"]').click();
  }

  // 验证全库全文检索命中 PPT 讲义正文、演讲者备注与用户逐页批注，并点击直达第 2 页幻灯片
  await page.evaluate(() => document.getElementById('openPdfSearch').click());
  await page.locator('#pdfSearchDialog[open]').waitFor();
  await page.locator('#workspaceSearchScope').selectOption('ppt');
  await page.locator('#pdfSearchQuery').fill('补充抽取后仿');
  await page.locator('#pdfSearchResults .workspace-search-result[data-search-kind="ppt"]').first().waitFor();
  assert.match(await page.locator('#pdfSearchResults .workspace-search-result').first().innerText(), /PPT 讲义 · 第 2 页/);
  await page.locator('#pdfSearchResults .workspace-search-result').first().click();
  await page.waitForFunction(() =>
    document.getElementById('reader').open &&
    document.getElementById('pptPageNumber')?.value === '2');
  await closeReader(page);

  // 验证资料库画廊/列表双视图切换、问题与课题交互式状态看板流转以及 Ctrl+K 全局指令面板
  await page.evaluate(() => switchView('resource'));
  assert.equal(await page.locator('#records').evaluate(el => el.classList.contains('library-grid-mode')), true);
  await page.locator('#libraryViewSwitcher [data-lib-view="list"]').click();
  assert.equal(await page.locator('#records').evaluate(el => el.classList.contains('library-list-mode')), true);
  await page.locator('#libraryViewSwitcher [data-lib-view="grid"]').click();

  const kanbanIssueId = await page.evaluate(async () => {
    const id = crypto.randomUUID();
    await put({
      id, type: 'issue', title: '验证看板状态流转课题', author: '', reference: '', url: '',
      body: '测试多列看板推进状态持久化', date: today(), tags: ['验证'], status: '待排查', pinned: false, attachments: []
    });
    switchView('issue');
    return id;
  });
  await page.locator('#boardViewSwitcher [data-board-mode="board"]').click();
  assert.equal(await page.locator('#records .kanban-column').count(), 3);
  await page.locator(`.kanban-card[data-id="${kanbanIssueId}"] [data-kanban-advance="进行中"]`).click();
  await page.waitForFunction(id => records.find(r => r.id === id)?.status === '进行中', kanbanIssueId);
  await page.locator('#boardViewSwitcher [data-board-mode="list"]').click();

  await page.keyboard.press('Control+k');
  await page.locator('#commandPalette[open]').waitFor();
  await page.locator('#commandPaletteInput').fill('总览');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('commandPalette').open && view === 'all');

  // 验证总览栏目统计卡片点击跳转、全栏目常驻显眼快捷指令栏与新版备份恢复中心健康栏
  await page.locator('#dashboardTop .dashboard-card[data-widget-kind="journal"]').click();
  await page.waitForFunction(() => view === 'journal');
  assert.equal(await page.locator('#introCommandTrigger').isVisible(), true);
  await page.locator('#introCommandTrigger').click();
  await page.locator('#commandPalette[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => switchView('all'));
  await page.locator('#dashboardTop .dashboard-card[data-widget-kind="paper"]').click();
  await page.waitForFunction(() => view === 'resource');
  await page.evaluate(() => switchView('all'));

  await page.evaluate(() => document.getElementById('backupBtn').click());
  await page.locator('#backup[open]').waitFor();
  await page.waitForFunction(() => /\d+ 条记录/.test(document.getElementById('backupStatRecords')?.textContent || ''));
  assert.equal(await page.locator('.backup-primary-grid #writeFolder').count(), 1);
  assert.equal(await page.locator('#restoreFolderSlot #restoreLargeBackupFolder').count(), 1);
  await page.locator('#backup [data-close="backup"]').click();

  // 2. 四栏自适应设置中心：单窗标签切换与内联语音模型 / 默认语向即时同步
  await page.evaluate(() => document.getElementById('desktopSettingsButton').click());
  await page.locator('#desktopSettings:popover-open').waitFor();
  assert.equal(await page.locator('#desktopSettings [data-settings-group]').count(), 4);
  await page.locator('#desktopSettings [data-settings-group="services"]').click();
  await page.locator('#settingsSpeechModelSelect').selectOption('large-v3-turbo');
  await page.locator('#settingsSourceLang').selectOption('de');
  const syncedSettings = await page.evaluate(() => ({
    asr: localStorage.getItem('donote-asr-model'),
    lang: storedTranslateLanguage()
  }));
  assert.equal(syncedSettings.asr, 'large-v3-turbo');
  assert.equal(syncedSettings.lang.source, 'de');
  await page.locator('#settingsSourceLang').selectOption('en');
  await page.locator('#desktopSettingsClose').click();

  // 3. 单进程快速收藏网页（bundle 直通与极速纯正文模式）
  const captureCalls = await page.evaluate(async () => {
    const calls = [];
    const origPost = window.chrome.webview.postMessage;
    window.chrome.webview.postMessage = msg => {
      if (msg?.type === 'capture-web-article') {
        calls.push({ kind: msg.kind, cacheAssets: msg.cacheAssets });
        const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        queueMicrotask(() => window.qaRelease.post({
          type: 'yams-one-web-capture',
          id: msg.id,
          url: msg.url,
          html: '<!doctype html><html><head><title>高速 ADC 架构笔记</title></head><body><article><h1>TI-SAR 时间交织校准综述</h1><p>' + '时间交织通道间增益与采样时刻失配校准方法详述。'.repeat(15) + '</p><img src="https://cdn.example.com/fig1.png" alt="图1"></article></body></html>',
          assets: msg.cacheAssets === false ? {} : { 'https://cdn.example.com/fig1.png': pixel }
        }));
        return;
      }
      return origPost(msg);
    };
    try {
      const full = await captureWebArticle('https://example.com/ti-sar-full');
      const fast = await captureWebArticle('https://example.com/ti-sar-fast', { cacheAssets: false });
      return { calls, fullHasImg: full.contentHtml.includes('data:image/png;base64,'), fastSkippedImg: !fast.contentHtml.includes('data:image/png;base64,') };
    } finally {
      window.chrome.webview.postMessage = origPost;
    }
  });
  assert.deepEqual(captureCalls, {
    calls: [
      { kind: 'bundle', cacheAssets: true },
      { kind: 'bundle', cacheAssets: false }
    ],
    fullHasImg: true,
    fastSkippedImg: true
  });
  await verifyPlatformEvolutionR139(page);
  await verifyRefinementsAndSyncProR140(page);
  console.log('PASS presentation deck, 4-tab adaptive settings center and single-process fast web capture');
}
