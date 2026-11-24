/**
 * [INPUT]: 可选的真实 PDF 路径。默认使用本机 ISSCC 2024 会刊。
 * [OUTPUT]: 打印首次可阅读、跳末页、峰值工作集，并检查索引中断后能继续。
 * [POS]: 发布回归之外的真实资料测量。文件不在时记为待验证，退出码仍为 0。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const pdfPath = process.argv[2] || 'C:\\Users\\PuJun\\Downloads\\ISSCC2024 - Digest.pdf';
const workspace = resolve('work/analog-notes/public');
const ORIGIN = 'https://yams-one.example';
try {
  await access(pdfPath);
} catch {
  console.log('PENDING real PDF: ' + pdfPath);
  process.exit(0);
}

const require = createRequire(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'));
const { chromium } = require('playwright');
let peak = 0;
const timer = setInterval(() => {
  try {
    const sum = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum'], { encoding: 'utf8' });
    peak = Math.max(peak, Number(sum.trim()) || 0);
  } catch {}
}, 2000);

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1170, height: 840 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const name = decodeURIComponent(url.pathname);
    const requested = resolve(workspace, name === '/' ? 'notebook.html' : '.' + name);
    const fromWorkspace = relative(workspace, requested);
    if (isAbsolute(fromWorkspace) || fromWorkspace.split(/[\\/]/).includes('..')) return route.abort();
    const script = /\.m?js$/i.test(requested);
    await route.fulfill({ path: requested, ...(script ? { contentType: 'text/javascript; charset=utf-8' } : {}) });
  });
  await context.addInitScript(() => {
    window.chrome ??= {};
    const webview = new EventTarget();
    webview.postMessage = () => {};
    window.chrome.webview = webview;
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => typeof ready !== 'undefined' && ready);
  await page.evaluate(() => {
    const picker = document.createElement('input');
    picker.id = 'realPdf';
    picker.type = 'file';
    picker.hidden = true;
    document.body.append(picker);
  });
  await page.locator('#realPdf').setInputFiles(pdfPath);
  const opened = Date.now();
  await page.evaluate(async () => {
    const picker = document.getElementById('realPdf');
    const blob = picker.files[0];
    picker.remove();
    const file = { id: crypto.randomUUID(), name: blob.name, mime: 'application/pdf', size: blob.size };
    await openReadableAttachment(file, blob);
  });
  await page.waitForFunction(() => Number(document.getElementById('pdfPageNumber')?.max) > 1 && document.querySelector('.pdf-text-layer'));
  const firstReadableMs = Date.now() - opened;
  const pageCount = await page.locator('#pdfPageNumber').getAttribute('max');
  const jump = Date.now();
  await page.locator('#pdfPageNumber').fill(pageCount);
  await page.locator('#pdfPageNumber').press('Enter');
  await page.waitForFunction(count => readingSession?.page === Number(count) && document.querySelector('[data-pdf-page="' + count + '"] .pdf-text-layer'), pageCount);
  const lastPageMs = Date.now() - jump;
  console.log(JSON.stringify({ phase: 'reader', pages: Number(pageCount), firstReadableMs, lastPageMs }));
  const index = await page.evaluate(async () => {
    const file = readingSession.file;
    const pdf = readingSession.pdf;
    const stub = new Blob(['%PDF-1.1\n%%EOF'], { type: 'application/pdf' });
    await put({
      id: crypto.randomUUID(), type: 'resource', title: file.name, author: '', reference: '', url: '',
      body: '', date: today(), tags: [], status: '待读', pinned: false,
      attachments: [{ id: file.id, name: file.name, mime: 'application/pdf', size: stub.size, addedAt: new Date().toISOString() }]
    }, [{ key: fileKey(appState.activeId, file.id), blob: stub }]);
    const controller = new AbortController();
    let saw = 0;
    const first = buildPdfSearchIndex(file, {
      pdf,
      signal: controller.signal,
      onProgress(progress) {
        saw = progress.page;
        if (progress.page >= 25) controller.abort();
      }
    });
    await first.catch(error => { if (error.name !== 'AbortError') throw error; });
    const controller2 = new AbortController();
    let resumedAt = 0;
    const second = buildPdfSearchIndex(file, {
      pdf,
      signal: controller2.signal,
      onProgress(progress) {
        if (!resumedAt) resumedAt = progress.page;
        if (progress.page >= 30) controller2.abort();
      }
    });
    await second.catch(error => { if (error.name !== 'AbortError') throw error; });
    const saved = await readPdfIndexSegments(file.id, appState.activeId);
    const pages = saved.flatMap(segment => segment.pages || []);
    const hit = searchPdfIndex({ pages }, 'ADC')[0]?.page || 0;
    return { saw, resumedAt, savedSegments: saved.length, hit };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({
    file: pdfPath,
    pages: Number(pageCount),
    firstReadableMs,
    lastPageMs,
    peakWorkingSetBytes: peak,
    index
  }, null, 2));
} finally {
  clearInterval(timer);
  await browser.close();
}
