/**
 * [INPUT]: 接收桌面发布包解压后的 workspace 目录。
 * [OUTPUT]: 验证长 PDF、后台字幕、草稿恢复和附件保存。
 * [POS]: 发布回归入口。浏览器使用临时账户和本地模拟宿主。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, rmdir, unlink } from 'node:fs/promises';
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
      if (message === 'startup-ready') {
        queueMicrotask(() => post({ type: 'yams-one-preferences', splashEnabled: false }));
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

async function testDraft(page) {
  const title = '发布验证：带附件的计划';
  const body = '草稿重新打开后应保留正文和原始附件。';
  const bytes = Buffer.from([0x44, 0x6f, 0x4e, 0x6f, 0x74, 0x65, 0x00, 0xff]);
  await page.evaluate(() => openEditor('plan'));
  await page.locator('#title').fill(title);
  await page.locator('#richBody').fill(body);
  await page.locator('#planStart').fill('2026-11-23');
  await page.locator('#planEnd').fill('2026-12-02');
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
  const saved = await page.evaluate(async name => {
    const note = records.find(entry => entry.title === name);
    return { planEnd: note.planEnd, bytes: Array.from(new Uint8Array(await (await readBlob(note.attachments[0].id)).arrayBuffer())) };
  }, title);
  assert.equal(saved.planEnd, '2026-12-02');
  assert.deepEqual(saved.bytes, Array.from(bytes));
  console.log('PASS draft: reload, plan dates, and saved attachment bytes');
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
    await put({ id: recordId, type: 'resource', title: file.name, date: today(), status: '待读', tags: [], body: '', attachments: [file] },
      [{ key: fileKey(ownerId, file.id), blob }]);
    const otherId = crypto.randomUUID();
    const next = structuredClone(appState);
    next.profiles.push({ ...structuredClone(activeProfile()), id: otherId, name: '发布验证另一账户', records: [] });
    await commitState(next);
    await openAttachment(file);
    const firstBytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    return { recordId, ownerId, otherId, fileId: file.id, prefix: btoa(String.fromCharCode(...firstBytes)) };
  });

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
  await send({ type: 'video-transcribe-segments', segments: [{ start: 0, end: 0.2, en: 'Background result' }] });
  await send({ type: 'video-transcribe-result', count: 1 });
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
  assert.deepEqual(state.cues, [{ start: 0, end: 0.2, en: 'Background result', zh: '' }]);
  console.log('PASS background subtitles: range bytes, reopen progress, correct account and IndexedDB persistence');
}

const { chromium } = playwright();
const browserPath = process.env.DONOTE_BROWSER_EXECUTABLE;
const channel = process.env.DONOTE_BROWSER_CHANNEL ?? 'msedge';
const directory = await mkdtemp(join(tmpdir(), 'donote-release-workspace-'));
const fixture = join(directory, 'long-range-document.pdf');
let browser;
try {
  await writeLargePdf(fixture, PAGE_COUNT, pdfMib * MIB);
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : channel ? { channel } : {}) });
  const { page, errors } = await openWorkspace(browser);
  await testLongPdf(page, fixture);
  await testDraft(page);
  await testBackgroundSubtitles(page);
  assert.deepEqual(errors, []);
} finally {
  try { await browser?.close(); }
  finally {
    await unlink(fixture).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
}
