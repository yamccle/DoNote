/**
 * [INPUT]: 接收桌面发布包解压后的 workspace 目录。
 * [OUTPUT]: 验证总览、记录、长 PDF、摘录回跳与云备份消息流程。
 * [POS]: 发布回归入口。浏览器使用临时账户和本地模拟宿主。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { FIRST_PAGE_TEXT, LAST_PAGE_TEXT, writeLargePdf } from './large-pdf.mjs';

const MIB = 1024 ** 2;
const PAGE_COUNT = 321;
const ORIGIN = 'https://yams-one.example';
const args = process.argv.slice(2);
const [workspaceArg, sizeArg = '1030'] = args;
const pdfMib = Number(sizeArg);
if (args.length < 1 || args.length > 2 || !Number.isSafeInteger(pdfMib) || pdfMib < 101 || pdfMib > 1800) {
  throw new Error('Usage: node tools/tests/test-workspace.mjs <workspace directory> [PDF MiB, defaults to 1030]');
}
const workspace = resolve(workspaceArg);
await access(join(workspace, 'index.html'));
await access(join(workspace, 'pdfjs', 'pdf.worker.mjs'));

const require = createRequire(import.meta.url);
function playwright() {
  const location = process.env.DONOTE_PLAYWRIGHT_MODULE;
  if (location) return require(resolve(location));
  try {
    return require('playwright');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const runtime = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
    try { return createRequire(runtime)('playwright'); }
    catch {
      throw new Error('Install Playwright or set DONOTE_PLAYWRIGHT_MODULE to an existing Playwright package path.');
    }
  }
}

async function openWorkspace(browser) {
  const context = await browser.newContext({ viewport: { width: 1170, height: 840 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const requested = resolve(workspace, '.' + decodeURIComponent(url.pathname));
    const fromWorkspace = relative(workspace, requested);
    if (isAbsolute(fromWorkspace) || fromWorkspace.split(/[\\/]/).includes('..')) return route.abort();
    try {
      const path = fromWorkspace ? requested : join(workspace, 'index.html');
      const script = /\.m?js$/i.test(path);
      await route.fulfill({ path, ...(script ? { contentType: 'text/javascript; charset=utf-8' } : {}) });
    } catch {
      await route.fulfill({ status: 404, body: 'Missing package file' });
    }
  });
  await context.addInitScript(() => {
    window.chrome ??= {};
    const webview = new EventTarget();
    const post = data => webview.dispatchEvent(new MessageEvent('message', { data }));
    window.qaRelease = { messages: [], post, reads: 0, bytes: 0 };
    webview.postMessage = message => {
      window.qaRelease.messages.push(message);
      const cloud = window.qaRelease.cloud;
      if (cloud && message?.type === 'cloud-backup') {
        let result = {};
        const { id, action } = message;
        if (action === 'status') result = { settings: cloud.settings };
        if (action === 'choose-folder') result = { folder: 'X:/My Drive/DoNote' };
        if (action === 'configure') cloud.settings = { mode: message.mode, folder: message.folder };
        if (action === 'list') result = { snapshots: cloud.names.map(name => ({ name })) };
        if (action === 'upload') {
          if (cloud.failUpload) result = { error: '测试传输失败' };
          else cloud.names.push(message.name);
        }
        if (action === 'download') result = { path: 'X:/DoNote-Restore/' + message.name };
        queueMicrotask(() => post({ type: 'cloud-backup-result', id, ...result }));
        return;
      }
      if (cloud && typeof message?.type === 'string' && message.type.startsWith('native-backup-')) {
        queueMicrotask(() => post({ type: 'native-backup-result', id: message.id }));
        return;
      }
      if (message === 'startup-ready') {
        queueMicrotask(() => post({ type: 'yams-one-preferences', splashEnabled: false }));
      }
      // 模拟本机离线字幕翻译：收到 subtitle-local:<id>:<payload> 后立即逐条返回译文。
      if (typeof message === 'string' && message.startsWith('subtitle-local:')) {
        const rest = message.slice('subtitle-local:'.length);
        const separator = rest.indexOf(':');
        const id = rest.slice(0, separator);
        const payload = JSON.parse(rest.slice(separator + 1));
        const values = payload.map(text => '译：' + text);
        queueMicrotask(() => post({ type: 'subtitle-local-result', id, offset: 0, values, done: true }));
      }
    };
    window.chrome.webview = webview;

    const threshold = 100 * 1024 ** 2;
    const { arrayBuffer, slice } = Blob.prototype;
    Blob.prototype.arrayBuffer = function () {
      if (this.size > threshold) throw new Error('A large PDF was read in a single operation.');
      return arrayBuffer.call(this);
    };
    Blob.prototype.slice = function (...args) {
      const part = slice.apply(this, args);
      if (this.size > threshold) {
        window.qaRelease.reads++;
        window.qaRelease.bytes += part.size;
      }
      return part;
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => typeof ready !== 'undefined' && ready);
  return { page, errors };
}

async function testLongPdf(page, fixture) {
  const workers = [];
  const onWorker = worker => workers.push(worker.url());
  page.on('worker', onWorker);
  try {
    await page.evaluate(() => {
      const picker = document.createElement('input');
      picker.id = 'releasePdfFixture';
      picker.type = 'file';
      picker.hidden = true;
      document.body.append(picker);
    });
    await page.locator('#releasePdfFixture').setInputFiles(fixture);
    await page.evaluate(async () => {
      const picker = document.getElementById('releasePdfFixture');
      const blob = picker.files[0];
      picker.remove();
      const file = { id: crypto.randomUUID(), name: blob.name, mime: 'application/pdf', size: blob.size };
      await openReadableAttachment(file, blob);
    });
    await page.waitForFunction(text => readingSession?.pageBox?.querySelector('.pdf-text-layer')?.textContent.includes(text), FIRST_PAGE_TEXT);
    const field = page.locator('#pdfPageNumber');
    assert.equal(await field.getAttribute('max'), String(PAGE_COUNT));
    await field.fill(String(PAGE_COUNT));
    await field.press('Enter');
    await page.waitForFunction(({ pageCount, text }) =>
      readingSession?.page === pageCount &&
      readingSession.pageBox?.querySelector('.pdf-text-layer')?.textContent.includes(text),
    { pageCount: PAGE_COUNT, text: LAST_PAGE_TEXT });
    const ranges = await page.evaluate(() => ({ reads: qaRelease.reads, bytes: qaRelease.bytes }));
    assert.ok(ranges.reads > 0 && ranges.bytes < 8 * MIB, JSON.stringify(ranges));
    assert.ok(workers.some(url => url === ORIGIN + '/pdfjs/pdf.worker.mjs'),
      'PDF must use the separate packaged browser worker rather than the main-thread fallback.');
    await closeReader(page);
    console.log(`PASS long PDF: page ${PAGE_COUNT}, ${pdfMib} MiB padding, ${ranges.reads} range reads (${ranges.bytes} bytes)`);
  } finally { page.off('worker', onWorker); }
}

async function closeReader(page) {
  await page.locator('#reader [data-close="reader"]').click();
  await page.waitForFunction(() => !document.getElementById('reader').open && !readingSession);
}

async function testWorkspaceNavigation(page, fixture) {
  const pdf = Array.from(await readFile(fixture));
  const seeded = await page.evaluate(async bytes => {
    const date = today();
    const record = { date, body: '', tags: [], attachments: [] };
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
    const files = ['旧的阅读位置.pdf', '继续阅读目标.pdf', '已经读完.pdf'].map(name => ({
      id: crypto.randomUUID(), name, mime: blob.type, size: blob.size, addedAt: new Date().toISOString()
    }));
    const profileId = appState.activeId;
    const article = await put({
      ...record, id: crypto.randomUUID(), type: 'resource', title: '混合附件阅读记录',
      status: '已读', attachments: files
    }, files.map(file => ({ key: fileKey(profileId, file.id), blob })));
    const plan = await put({
      ...record, id: crypto.randomUUID(), type: 'plan', title: '尚待推进的计划',
      planStart: date, planEnd: date, status: '进行中'
    });
    const archived = await put({
      ...record, id: crypto.randomUUID(), type: 'plan', title: '已归档的计划',
      planStart: date, planEnd: date, status: '已完成'
    });
    const daily = await put({
      ...record, id: crypto.randomUUID(), type: 'journal', title: '发布回归日常记录', status: '已记录'
    });
    const weekly = await put({
      ...record, id: crypto.randomUUID(), type: 'journal', title: '发布回归周报记录',
      status: '已记录', journalKind: 'weekly'
    });
    const next = structuredClone(appState);
    const profile = next.profiles.find(entry => entry.id === profileId);
    const openedAt = delta => new Date(Date.now() + delta).toISOString();
    const position = { kind: 'pdf', page: 1, pages: 3, lastOpened: openedAt(-2000) };
    profile.reading[files[0].id] = { ...position, lastOpened: openedAt(-1000) };
    profile.reading[files[1].id] = { ...position, page: 2 };
    profile.reading[files[2].id] = { ...position, page: 3, finished: true, lastOpened: openedAt(500) };
    profile.reading[article.id] = profile.reading[files[2].id];
    await commitState(next);
    storeReadingCheckpoint(profileId, files[1].id, { ...position, page: 3, lastOpened: openedAt(0) });
    return {
      articleId: article.id, fileId: files[1].id, planId: plan.id,
      archivedId: archived.id, dailyId: daily.id, weeklyId: weekly.id
    };
  }, pdf);

  // 刷新工作台，确认总览读取持久化位置，而非当前预览的内存状态。
  await page.reload();
  await page.waitForFunction(() => ready);
  const home = page.locator('#workspaceHome');
  await home.waitFor();
  const resume = home.locator(`#homeResume [data-home-resume="${seeded.articleId}"][data-home-file="${seeded.fileId}"]`);
  const plan = home.locator(`#homePlans [data-home-plan="${seeded.planId}"]`);
  await plan.waitFor();
  assert.equal(await home.locator(`[data-home-plan="${seeded.archivedId}"]`).count(), 0);
  await resume.click();
  await page.waitForFunction(({ fileId, text }) => readingSession?.file.id === fileId && readingSession.page === 3 &&
    readingSession.pageBox?.querySelector('.pdf-text-layer')?.textContent.includes(text), {
    fileId: seeded.fileId, text: LAST_PAGE_TEXT
  });
  assert.equal(await page.evaluate(() => readingSession.progress.finished), false, '完成状态以实际打开的附件为准');
  await closeReader(page);

  const viewport = page.viewportSize();
  const search = page.locator('#search');
  const filters = page.locator('#workspaceFiltersToggle');
  const more = page.locator('#workspaceMoreToggle');
  const insideWindow = selector => page.locator(selector).evaluate(button => {
    const { left, right, width, height } = button.getBoundingClientRect();
    return width > 0 && height > 0 && left >= 0 && right <= innerWidth;
  });
  const recordRow = id => page.locator(`#records .card[data-id="${id}"]`);
  await page.setViewportSize({ width: 400, height: 600 });
  try {
    await page.locator('[data-rail-view="journal"]').click();
    assert.equal(await home.isVisible(), false, '工作日志不应展示总览组件');
    assert.equal(await page.locator('.workspace > aside').isVisible(), false, '普通栏目不应留出通用侧栏');
    for (const selector of ['#search', '#workspaceFiltersToggle', '#workWeeklyBtn', '#workspaceMoreToggle']) {
      assert.equal(await insideWindow(selector), true, selector + ' 应留在窄窗口内');
    }
    await page.keyboard.press('Control+f');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
    await search.fill('日常记录');
    await recordRow(seeded.dailyId).waitFor();
    assert.equal(await recordRow(seeded.weeklyId).count(), 0);
    await search.clear();
    await recordRow(seeded.weeklyId).waitFor();

    await filters.click();
    await page.locator('#workspaceFilters #weeklyOnly').check();
    await recordRow(seeded.dailyId).waitFor({ state: 'hidden' });
    assert.equal(await recordRow(seeded.weeklyId).isVisible(), true);
    assert.match(await filters.innerText(), /1/, '应显示启用的筛选数量');
    await page.keyboard.press('Escape');
    await more.click();
    await page.locator('#workspaceMore #openPdfSearch').waitFor();
    await page.locator('#workspaceMore #openFolderManager').waitFor();
    await page.keyboard.press('Escape');

    await page.locator('[data-rail-view="plan"]').click();
    const archive = page.locator('#planArchiveToggle');
    await archive.click();
    await recordRow(seeded.archivedId).waitFor();
    assert.equal(await recordRow(seeded.planId).count(), 0);
    await archive.click();
    await recordRow(seeded.planId).waitFor();

    await page.locator('[data-rail-view="resource"]').click();
    for (const selector of ['#search', '#libraryAddToggle', '#libraryFiltersToggle', '#libraryMoreToggle', '#librarySelection']) {
      assert.equal(await insideWindow(selector), true, selector + ' 应留在资料库窄窗口内');
    }
    await page.locator('#libraryMoreToggle').click();
    await page.locator('#libraryMore #openPdfSearch').waitFor();
    await page.keyboard.press('Escape');
  } finally {
    await page.setViewportSize(viewport);
  }
  await page.locator('[data-rail-view="all"]').click();
  await home.waitFor();
  console.log('PASS workspace navigation: exact reading resume, active plans, compact controls, scoped filters and keyboard search');
}

async function testRecordEditor(page) {
  const viewport = page.viewportSize();
  const picker = page.locator('#recordTypePicker');
  const editor = page.locator('#editor');
  const type = page.locator('#type');
  const title = page.locator('#title');
  const recordTitle = '发布验证：从总览新建计划';
  // Windows 标题栏通过同一个网页按钮发出新建操作。
  const clickNew = () => page.evaluate(() => document.getElementById('newBtn').click());
  await page.setViewportSize({ width: 400, height: 600 });
  try {
    await page.locator('[data-rail-view="journal"]').click();
    await clickNew();
    await editor.waitFor();
    assert.equal(await type.inputValue(), 'journal');
    assert.equal(await picker.isVisible(), false);
    await editor.getByRole('button', { name: '关闭', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });

    await page.locator('[data-rail-view="all"]').click();
    await clickNew();
    await picker.waitFor();
    assert.equal(await editor.isVisible(), false);
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden' });

    await page.keyboard.press('Control+n');
    await picker.locator('button[data-record-type="plan"]').click();
    await editor.waitFor();
    assert.equal(await picker.isVisible(), false);
    assert.equal(await type.inputValue(), 'plan');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'title');
    assert.equal(await page.locator('#editorMetadata').getAttribute('open'), null);
    assert.equal(await page.locator('#editorResources').getAttribute('open'), null);
    assert.equal(await page.locator('#addAttachments').evaluate(button => {
      const { left, right, top, bottom } = button.getBoundingClientRect();
      const scrollArea = document.querySelector('#editor .editor-body').getBoundingClientRect();
      return left >= 0 && right <= innerWidth && top >= scrollArea.top && bottom <= scrollArea.bottom;
    }), true, '窄窗口初次打开时应显示添加附件按钮');
    assert.equal(await page.locator('#saveBtn').evaluate(button => {
      const { left, right, top, bottom } = button.getBoundingClientRect();
      return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight;
    }), true, '窄窗口初次打开时应显示保存按钮');

    await page.evaluate(() => window.DoNoteAppearance.applyTheme('dark'));
    const pageMode = page.locator('#editorModeBtn');
    await pageMode.click();
    const editorSurfaces = await editor.evaluate(dialog =>
      [...dialog.querySelectorAll('.modalhead,.modalbody,.modalfoot')].map(node => getComputedStyle(node).backgroundColor));
    assert.notEqual(editorSurfaces[1], 'rgb(255, 255, 255)');
    assert.deepEqual(editorSurfaces, Array(3).fill(editorSurfaces[1]), '整页编辑器的页眉和页脚应跟随夜间主题');
    await pageMode.click();
    await page.evaluate(() => window.DoNoteAppearance.applyTheme('system'));

    await title.fill(recordTitle);
    const start = page.locator('#planStart');
    const end = page.locator('#planEnd');
    await start.fill('2026-11-23');
    await end.fill('2026-12-02');
    await editor.getByRole('button', { name: '收起浮窗' }).click();
    await editor.waitFor({ state: 'hidden' });
    await clickNew();
    await editor.waitFor();
    assert.equal(await picker.isVisible(), false);
    assert.equal(await title.inputValue(), recordTitle);

    await type.selectOption('paper');
    await page.locator('#editorMetadata > summary').click();
    await page.locator('#url').fill('invalid-url');
    await page.locator('#tagsInput').fill('发布回归');
    await type.selectOption('plan');
    assert.equal(await start.inputValue(), '2026-11-23');
    assert.equal(await end.inputValue(), '2026-12-02');
    await page.locator('#saveBtn').click();
    await editor.waitFor({ state: 'hidden' });
    const saved = await page.evaluate(name => {
      const note = records.find(record => record.title === name);
      return note && { type: note.type, planEnd: note.planEnd, tags: note.tags, url: note.url || '' };
    }, recordTitle);
    assert.deepEqual(saved, { type: 'plan', planEnd: '2026-12-02', tags: ['发布回归'], url: '' });
  } finally {
    await page.setViewportSize(viewport);
  }
  console.log('PASS record editor: scoped entry, overview picker, narrow window, resume and type switching');
}

async function testDraft(page) {
  const title = '发布验证：带附件的计划';
  const body = '草稿重新打开后应保留正文和原始附件。';
  const bytes = Buffer.from([0x44, 0x6f, 0x4e, 0x6f, 0x74, 0x65, 0x00, 0xff]);
  const resourceId = await page.evaluate(async () => {
    const id = crypto.randomUUID();
    await put({ id, type: 'resource', title: '发布验证：关联资料', date: today(), status: '待读', tags: [], body: '', attachments: [] });
    openEditor('plan');
    return id;
  });
  await page.locator('#title').fill(title);
  await page.locator('#richBody').fill(body);
  await page.locator('#planStart').fill('2026-11-23');
  await page.locator('#planEnd').fill('2026-12-02');
  await page.locator('#editorResources > summary').click();
  await page.locator(`[data-link-resource="${resourceId}"]`).check();
  await page.locator('#editorMetadata > summary').click();
  await page.locator('#tagsInput').fill('附件回归');
  await page.locator('#attachmentInput').setInputFiles({ name: 'qa-draft.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await page.waitForFunction(() => document.querySelector('#saveHint')?.textContent.includes('草稿已暂存'));
  await page.reload();
  await page.waitForFunction(() => ready);
  assert.equal(await page.evaluate(name => records.some(note => note.title === name), title), false);
  await page.evaluate(() => document.getElementById('backupBtn').click());
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restoreDraft').click();
  const editor = page.locator('#editor');
  await editor.waitFor();
  assert.equal(await page.locator('#title').inputValue(), title);
  assert.equal(await page.locator('#richBody').innerText(), body);
  assert.equal(await page.locator('#planStart').inputValue(), '2026-11-23');
  assert.equal(await page.locator('#planEnd').inputValue(), '2026-12-02');
  assert.match(await page.locator('#draftFiles').innerText(), /qa-draft\.bin/);
  await page.locator('#saveBtn').click();
  await editor.waitFor({ state: 'hidden' });
  const savedBytes = await page.evaluate(async name => {
    const note = records.find(entry => entry.title === name);
    return Array.from(new Uint8Array(await (await readBlob(note.attachments[0].id)).arrayBuffer()));
  }, title);
  assert.deepEqual(savedBytes, Array.from(bytes));
  await page.locator('#records .card').filter({ hasText: title }).click();
  await page.locator('#editBtn').click();
  await editor.waitFor();
  assert.equal(await page.locator('#planEnd').inputValue(), '2026-12-02');
  assert.equal(await page.locator('#tagsInput').inputValue(), '附件回归');
  await page.locator('#editorResources > summary').click();
  const linkedResource = page.locator(`[data-link-resource="${resourceId}"]`);
  await linkedResource.waitFor();
  assert.equal(await linkedResource.isChecked(), true);
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  console.log('PASS draft: reload, saved attachment bytes, and reopening plan dates, tags and resources');
}

async function testFolderManagement(page) {
  const ids = {
    source: 'qa-folder-source', child: 'qa-folder-child',
    archive: 'qa-folder-archive', destination: 'qa-folder-destination', journal: 'qa-folder-journal',
    deep: 'qa-folder-deep'
  };
  const labels = {
    source: '回归来源文件夹', child: '来源子目录', archive: '回归归档目录',
    destination: '项目归档目标', journal: '日志专用目录', created: '新建资料子目录', renamed: '已整理资料来源',
    deep: '深层路径末端'
  };
  const bytes = [0x44, 0x6f, 0x00, 0xff];
  const recordTitle = '文件夹回归附件';
  const seeded = await page.evaluate(async ({ ids, labels, bytes, recordTitle }) => {
    const next = structuredClone(appState);
    const profile = next.profiles.find(entry => entry.id === next.activeId);
    const folder = (key, parentId = '', scope = 'resource') => ({
      id: ids[key], name: labels[key], parentId, scope
    });
    profile.folders = [...(profile.folders || []), folder('source'), folder('child', ids.source),
      folder('archive'), folder('destination', ids.archive), folder('journal', '', 'journal')];
    let parentId = ids.archive;
    for (let depth = 1; depth <= 9; depth++) {
      const id = depth === 9 ? ids.deep : ids.deep + '-' + depth;
      const name = depth === 9 ? labels.deep : ('用于发布验证的长文件夹名称' + depth).repeat(4);
      profile.folders.push({ id, scope: 'resource', parentId, name });
      parentId = id;
    }
    await commitState(next);
    const recordId = crypto.randomUUID();
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
    const file = { id: crypto.randomUUID(), name: 'folder-test.bin', mime: blob.type, size: blob.size, addedAt: new Date().toISOString() };
    await put({
      id: recordId, type: 'resource', title: recordTitle, body: '', status: '待读', date: today(),
      folderId: ids.child, tags: [], attachments: [file]
    }, [{ key: fileKey(next.activeId, file.id), blob }]);
    const directIds = [];
    for (const label of ['文件夹回归直存资料甲', '文件夹回归直存资料乙']) {
      const id = crypto.randomUUID();
      await put({ id, type: 'resource', title: label, body: '', status: '待读', date: today(), folderId: ids.source, tags: [], attachments: [] });
      directIds.push(id);
    }
    render();
    return { recordId, fileId: file.id, directIds };
  }, { ids, labels, bytes, recordTitle });

  const library = page.locator('#libraryFolders');
  const manager = page.locator('#folderManager');
  const dialog = page.locator('#folderActionDialog');
  const menu = page.locator('#workspaceContextMenu');
  const submit = dialog.locator('#folderActionSubmit');
  const name = dialog.locator('#folderActionName');
  const path = dialog.locator('#folderDestinationPath');
  const search = dialog.locator('#folderDestinationSearch');
  const managerSearch = manager.locator('#folderManagerSearch');
  const folderRow = id => manager.locator(`[data-folder-item="${id}"]`);
  const target = id => dialog.locator(`[data-folder-destination="${id}"]`);
  const chooseAction = async (button, label) => {
    await button.click();
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
    await dialog.waitFor();
  };
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 400, height: 600 });
  try {
    await page.locator('[data-rail-view="resource"]').click();
    await library.locator(`[data-folder-open="${ids.source}"]`).click();
    await library.locator('[data-folder-create]').click();
    await dialog.waitFor();
    assert.match(await dialog.locator('#folderActionLocation').innerText(), new RegExp(labels.source));
    await name.fill(labels.created);
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    const createdId = await page.evaluate(label => recordFolders('resource').find(folder => folder.name === label)?.id, labels.created);
    assert.ok(createdId, '文件夹名称应保存');
    await library.locator(`[data-folder-open="${createdId}"]`).waitFor();

    await library.locator('[data-folder-crumb=""]').click();
    await library.locator(`[data-folder-more="${ids.source}"]`).press('Enter');
    await menu.getByRole('menuitem', { name: '重命名…', exact: true }).click();
    await dialog.waitFor();
    assert.equal(await name.inputValue(), labels.source);
    await name.fill(labels.archive);
    await submit.click();
    await page.waitForFunction(() => /同名|重名/.test(document.getElementById('folderActionMessage').textContent));
    assert.equal(await dialog.isVisible(), true, '同级重名时应保留表单');
    assert.equal(await name.inputValue(), labels.archive, '重名后应保留已填写的名称');
    await name.fill(labels.renamed);
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    const sourceCard = library.locator(`[data-folder-open="${ids.source}"]`);
    assert.match(await sourceCard.innerText(), new RegExp(labels.renamed));

    await library.locator('[data-folder-manage]').click();
    await folderRow(ids.source).waitFor();
    assert.equal(await folderRow(ids.child).count(), 0, '子文件夹默认折叠');
    await folderRow(ids.source).locator('[data-folder-toggle]').click();
    await folderRow(ids.child).waitFor();
    await managerSearch.fill(labels.renamed);
    await folderRow(ids.archive).waitFor({ state: 'hidden' });
    await chooseAction(folderRow(ids.source).locator('[data-folder-more]'), '移动到…');
    for (const [id, label] of [[ids.source, labels.renamed], [ids.child, labels.child], [ids.journal, labels.journal]]) {
      await search.fill(label);
      assert.equal(await target(id).count() > 0 && await target(id).isEnabled(), false, '禁止选择自身、子目录或其他栏目');
    }
    await search.fill(labels.deep);
    await target(ids.deep).click();
    assert.match(await path.innerText(), new RegExp(labels.deep));
    assert.equal(await submit.evaluate(button => {
      const box = button.getBoundingClientRect();
      const bounds = button.closest('dialog').getBoundingClientRect();
      return box.bottom <= bounds.bottom && box.bottom <= innerHeight;
    }), true, '超长目标路径不能把移动按钮推出窗口');
    await search.fill(labels.destination);
    await target(ids.destination).click();
    for (const label of [labels.archive, labels.destination]) assert.match(await path.innerText(), new RegExp(label));
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    await manager.getByRole('button', { name: '撤销', exact: true }).click();
    await page.waitForFunction(id => recordFolders('resource').find(folder => folder.id === id)?.parentId === '', ids.source);
    await chooseAction(folderRow(ids.source).locator('[data-folder-more]'), '移动到…');
    await search.fill(labels.destination);
    await target(ids.destination).click();
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    await page.reload();
    await page.waitForFunction(() => ready);
    const stored = await page.evaluate(async ({ ids, createdId, recordId, fileId }) => {
      const note = records.find(entry => entry.id === recordId);
      const parents = [ids.source, ids.child, createdId].map(id =>
        recordFolders('resource').find(folder => folder.id === id)?.parentId);
      return {
        parents, title: note?.title, folderId: note?.folderId,
        bytes: Array.from(new Uint8Array(await (await readBlob(fileId)).arrayBuffer()))
      };
    }, { ids, createdId, ...seeded });
    assert.deepEqual(stored, { parents: [ids.destination, ids.source, ids.source], title: recordTitle, folderId: ids.child, bytes });

    await page.locator('[data-rail-view="journal"]').click();
    await page.locator('#workspaceMoreToggle').click();
    await page.locator('#openFolderManager').click();
    await folderRow(ids.journal).waitFor();
    assert.equal(await folderRow(ids.source).count(), 0, '日志栏目应只管理自己的文件夹');
    await manager.locator('[data-close="folderManager"]').click();

    await page.locator('[data-rail-view="resource"]').click();
    await library.locator('[data-folder-manage]').click();
    await managerSearch.fill(labels.renamed);
    await chooseAction(folderRow(ids.source).locator('[data-folder-more]'), '删除文件夹…');
    const removeContents = dialog.locator('#folderRemoveContents');
    assert.equal(await removeContents.isChecked(), false, '删除文件夹默认应保留内容');
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    const retained = await page.evaluate(({ ids, createdId, directIds, recordId }) => {
      const folders = new Map(recordFolders('resource').map(folder => [folder.id, folder.parentId]));
      return {
        original: folders.has(ids.source),
        children: [ids.child, createdId].map(id => folders.get(id)),
        records: [...directIds, recordId].map(id => records.find(note => note.id === id)?.folderId)
      };
    }, { ids, createdId, ...seeded });
    assert.deepEqual(retained, {
      original: false, children: [ids.destination, ids.destination],
      records: [ids.destination, ids.destination, ids.child]
    });

    await managerSearch.fill(labels.destination);
    await folderRow(ids.destination).locator('[data-folder-browse]').click();
    await manager.waitFor({ state: 'hidden' });
    await page.locator('#librarySelection').click();
    await page.locator('#librarySelectAll').click();
    assert.match(await page.locator('#librarySelectedCount').innerText(), /2/);
    await page.locator('#libraryMoveSelected').click();
    await dialog.waitFor();
    await search.fill(labels.child);
    await target(ids.child).click();
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(directIds => directIds.map(id => records.find(note => note.id === id)?.folderId), seeded.directIds),
      [ids.child, ids.child], '批量移动应归档两个选中的资料');

    await chooseAction(library.locator(`[data-folder-more="${ids.child}"]`), '删除文件夹…');
    await removeContents.check();
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    const trashed = await page.evaluate(async ({ recordId, directIds, fileId }) => {
      const ids = [recordId, ...directIds];
      return {
        live: records.some(note => ids.includes(note.id)),
        deleted: trashOf(activeProfile()).filter(entry => ids.includes(entry.id)).length,
        bytes: Array.from(new Uint8Array(await (await readBlob(fileId)).arrayBuffer()))
      };
    }, seeded);
    assert.deepEqual(trashed, { live: false, deleted: 3, bytes });
  } finally {
    await page.setViewportSize(viewport);
  }
  console.log('PASS folders: nested creation, duplicate names, scoped management, move targets, bulk move, safe deletion, and attachment bytes');
}

async function testBackgroundSubtitles(page) {
  const { fileId, recordId, ownerId, otherId, prefix } = await page.evaluate(async () => {
    const frame = document.createElement('canvas');
    frame.width = 96;
    frame.height = 64;
    const graphics = frame.getContext('2d');
    const stream = frame.captureStream(24);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const parts = [];
    recorder.ondataavailable = event => parts.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (const color of ['#123456', '#654321', '#000000']) {
      graphics.fillStyle = color;
      graphics.fillRect(0, 0, frame.width, frame.height);
      await new Promise(resolve => setTimeout(resolve, 65));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(parts, { type: 'video/webm' });
    const file = { id: crypto.randomUUID(), name: 'QA background.webm', mime: blob.type, size: blob.size, addedAt: new Date().toISOString() };
    const recordId = crypto.randomUUID();
    const ownerId = appState.activeId;
    // 预置旧字幕，验证“重新识别”时第一批新字幕也会从第一条开始同步翻译。
    const seeded = [{ start: 0, end: 0.1, en: 'Old line', zh: '旧译' }];
    await put({ id: recordId, type: 'resource', title: file.name, date: today(), status: '待读', tags: [], body: '', attachments: [file], videoSubtitles: { [file.id]: seeded } },
      [{ key: fileKey(ownerId, file.id), blob }]);
    const otherId = crypto.randomUUID();
    const next = structuredClone(appState);
    next.profiles.push({ ...structuredClone(activeProfile()), id: otherId, name: '发布验证另一账户', records: [] });
    await commitState(next);
    await openAttachment(file);
    const firstBytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    return { recordId, ownerId, otherId, fileId: file.id, prefix: btoa(String.fromCharCode(...firstBytes)) };
  });

  page.once('dialog', dialog => dialog.accept());
  await page.locator('.video-subtitles [data-act="generate"]').click();
  await page.waitForFunction(() => qaRelease.messages.some(message => message.type === 'video-transcribe'));
  const request = await page.evaluate(() => qaRelease.messages.find(message => message.type === 'video-transcribe'));
  assert.equal(request.source, 'range-v1');
  assert.ok(request.size >= 16);
  const send = message => page.evaluate(data => qaRelease.post(data), { id: request.id, ...message });
  await send({ type: 'video-transcribe-ack', seq: -1, source: 'range-v1' });
  await page.waitForFunction(() => qaRelease.messages.some(message => message.type === 'video-transcribe-finish'));
  await closeReader(page);

  await send({ type: 'video-transcribe-range-request', offset: 0, length: 16 });
  await page.waitForFunction(() => qaRelease.messages.some(message => message.type === 'video-transcribe-range'));
  const received = await page.evaluate(() => qaRelease.messages.find(message => message.type === 'video-transcribe-range'));
  assert.equal(received.data, prefix);
  await send({ type: 'video-transcribe-progress', status: '后台识别', percent: 40 });
  await page.evaluate(async id => {
    await openAttachment(records.flatMap(note => note.attachments).find(file => file.id === id));
  }, fileId);
  assert.equal(await page.locator('.video-subtitles progress').getAttribute('value'), '40');
  await closeReader(page);

  await page.evaluate(async id => {
    await waitForReaderSaves();
    const next = structuredClone(appState);
    next.activeId = id;
    await commitState(next);
    updateIdentity();
    render();
  }, otherId);
  // 分两批识别，边识别边翻译：识别尚未结束时，两批英文字幕的中文都应逐条出现。
  await send({ type: 'video-transcribe-segments', segments: [{ start: 0, end: 0.2, en: 'Background result' }] });
  await page.waitForFunction(() => [...videoSubtitleJobs.values()].some(job => job.cues[0]?.en === 'Background result' && job.cues[0]?.zh === '译：Background result'));
  await send({ type: 'video-transcribe-segments', segments: [{ start: 0.25, end: 0.45, en: 'Second line' }] });
  await page.waitForFunction(() => [...videoSubtitleJobs.values()].some(job => job.cues[1]?.en === 'Second line' && job.cues[1]?.zh === '译：Second line'));
  assert.equal(await page.evaluate(() => [...videoSubtitleJobs.values()].some(job => job.id)), true, '识别仍在进行时译文已出现');
  await send({ type: 'video-transcribe-result', count: 2 });
  await page.waitForFunction(() => [...videoSubtitleJobs.values()].every(job => !job.kind));
  await page.reload();
  await page.waitForFunction(() => ready);
  const state = await page.evaluate(({ ownerId, recordId, fileId }) => ({
    activeId: appState.activeId,
    otherRecords: activeProfile().records.length,
    cues: appState.profiles.find(profile => profile.id === ownerId)?.records.find(note => note.id === recordId)?.videoSubtitles?.[fileId]
  }), { ownerId, recordId, fileId });
  assert.equal(state.activeId, otherId);
  assert.equal(state.otherRecords, 0);
  assert.deepEqual(state.cues, [
    { start: 0, end: 0.2, en: 'Background result', zh: '译：Background result' },
    { start: 0.25, end: 0.45, en: 'Second line', zh: '译：Second line' }
  ]);
  console.log('PASS background subtitles: range bytes, reopen progress, correct account, incremental translation from the first cue and IndexedDB persistence');
}

async function testWebExcerpt(page) {
  const quote = '链上要找回的这一句摘录。';
  await page.evaluate(async quoteText => {
    const before = '锚点之前。';
    const after = '锚点之后。';
    const html = '<p>填充段落。</p>'.repeat(40) + '<p>' + before + quoteText + after + '</p>';
    const fileId = crypto.randomUUID();
    const recordId = crypto.randomUUID();
    const blob = new Blob([html], { type: 'text/html' });
    const capturedAt = new Date().toISOString();
    await put({
      id: recordId, type: 'resource', title: '出处网页', author: '', reference: '', url: '',
      body: '', date: today(), tags: [], status: '待读', pinned: false,
      attachments: [{ id: fileId, name: 'article.html', mime: 'text/html', size: blob.size, addedAt: capturedAt, webRole: 'article' }],
      webArticle: { url: 'https://example.com/source', capturedAt },
      updatedAt: capturedAt
    }, [{ key: fileKey(appState.activeId, fileId), blob }]);
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

async function testAppendPdfExcerpt(page) {
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

async function testCloudBackupUi(page) {
  await page.evaluate(() => {
    qaRelease.cloud = { settings: null, names: [], failUpload: true };
    $('backupBtn').click();
  });
  await page.locator('#cloudBackupOpen').click();
  await page.locator('#cloudBackupChoose').click();
  await page.locator('#cloudBackupSave').click();
  await page.waitForFunction(() => !$('cloudBackupRun').disabled);
  await page.locator('#cloudBackupRun').click();
  await page.waitForFunction(() =>
    $('cloudBackupMessage').textContent === '测试传输失败' && !$('cloudBackupRun').disabled);
  assert.equal(await page.locator('#cloudBackupList').locator('option').count(), 1);
  const attempted = await page.evaluate(() => {
    qaRelease.cloud.failUpload = false;
    return qaRelease.messages.filter(message => typeof message === 'object');
  });
  const types = attempted.map(message => message.type === 'cloud-backup' ? message.action : message.type);
  const manifest = attempted.findLastIndex(message =>
    message.type === 'native-backup-file-start' && message.path === 'backup.json');
  const finalFile = types.lastIndexOf('native-backup-file-start');
  assert.ok(manifest >= 0 && manifest === finalFile, '备份清单应最后写入');
  assert.ok(types.indexOf('stage') < types.indexOf('native-backup-start'));
  assert.ok(types.indexOf('native-backup-finish') < types.indexOf('upload'));
  assert.ok(types.indexOf('upload') < types.indexOf('discard'));
  await page.locator('#cloudBackupRun').click();
  await page.waitForFunction(() =>
    /确认上传完成/.test($('cloudBackupMessage').textContent) && !$('cloudBackupDownload').disabled);
  await page.locator('#cloudBackupDownload').click();
  await page.waitForFunction(() => /已下载并通过校验/.test($('cloudBackupMessage').textContent));
  assert.match(await page.locator('#cloudBackupDownloaded').textContent(), /DoNote-Restore/);
  await page.locator('#cloudBackupDialog [data-close]').click();
  await page.locator('#backup [data-close]').first().click();
  await page.evaluate(() => { delete qaRelease.cloud; });
  console.log('PASS 云备份界面：目标设置、清单最后写入、上传失败与重试、下载和恢复入口。');
}

const { chromium } = playwright();
const browserPath = process.env.DONOTE_BROWSER_EXECUTABLE;
const channel = process.env.DONOTE_BROWSER_CHANNEL ?? 'msedge';
const directory = await mkdtemp(join(tmpdir(), 'donote-release-workspace-'));
const fixture = join(directory, 'long-range-document.pdf');
const resumeFixture = join(directory, 'resume-document.pdf');
let browser;
try {
  await Promise.all([writeLargePdf(fixture, PAGE_COUNT, pdfMib * MIB), writeLargePdf(resumeFixture, 3, 0)]);
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : channel ? { channel } : {}) });
  const { page, errors } = await openWorkspace(browser);
  await testWorkspaceNavigation(page, resumeFixture);
  await testCloudBackupUi(page);
  await testLongPdf(page, fixture);
  await testRecordEditor(page);
  await testDraft(page);
  await testFolderManagement(page);
  await testBackgroundSubtitles(page);
  await testWebExcerpt(page);
  await testAppendPdfExcerpt(page);
  // 网页阅读器的快照 iframe 故意沙箱隔离。浏览器会报告其中没有 Service Worker，这不是页面脚本错误。
  const sandboxedWorker = "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.";
  assert.deepEqual(errors.filter(message => message !== sandboxedWorker), []);
} finally {
  try { await browser?.close(); }
  finally {
    await Promise.all([fixture, resumeFixture].map(path =>
      unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    await rmdir(directory);
  }
}
