/**
 * [INPUT]: 可选的真实长 PDF 路径与第二份双栏论文路径。默认使用本机 ISSCC 2024 会刊与电路论文。
 * [OUTPUT]: 打印首次可阅读、目录树节点数、双栏页摘录反向引用、多标签切换、跳末页、浏览器进程树峰值内存与索引续跑结果。
 * [POS]: 发布回归之外的真实工程文献压测。文件不在时记为待验证，退出码仍为 0。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const pdfPath = process.argv[2] || 'C:\\Users\\PuJun\\Downloads\\ISSCC2024 - Digest.pdf';
const secondPdfPath = process.argv[3] || 'C:\\Users\\PuJun\\Downloads\\eetop.cn_ESD power clamp.pdf';
const workspace = resolve('work/analog-notes/public');
const ORIGIN = 'https://yams-one.example';
try {
  await access(pdfPath);
} catch {
  console.log('PENDING real PDF: ' + pdfPath);
  process.exit(0);
}
let hasSecondPdf = false;
try {
  await access(secondPdfPath);
  hasSecondPdf = true;
} catch {}

const require = createRequire(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'));
const { chromium } = require('playwright');

function headlessEdgeWorkingSetBytes() {
  try {
    const script = [
      "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '--headless' }",
      "if (-not $procs) { 0; exit }",
      "$ids = $procs.ProcessId",
      "(Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

let peak = 0;
const timer = setInterval(() => {
  peak = Math.max(peak, headlessEdgeWorkingSetBytes());
}, 1500);

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
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
    picker.multiple = true;
    picker.hidden = true;
    document.body.append(picker);
  });
  await page.locator('#realPdf').setInputFiles(hasSecondPdf ? [pdfPath, secondPdfPath] : [pdfPath]);

  const opened = Date.now();
  const seeded = await page.evaluate(async () => {
    const picker = document.getElementById('realPdf');
    const [primaryBlob, secondaryBlob] = [...picker.files];
    picker.remove();
    const primaryFile = { id: crypto.randomUUID(), name: primaryBlob.name, mime: 'application/pdf', size: primaryBlob.size, addedAt: new Date().toISOString() };
    const stub = new Blob(['%PDF-1.1\n%%EOF'], { type: 'application/pdf' });
    const ownerId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    await put({
      id: ownerId, type: 'resource', title: primaryFile.name, author: '', reference: '', url: '',
      body: '', date: today(), tags: ['ISSCC'], status: '待读', pinned: false,
      attachments: [primaryFile]
    }, [{ key: fileKey(appState.activeId, primaryFile.id), blob: stub }]);
    await put({
      id: issueId, type: 'issue', title: 'ISSCC 关键电路指标核查', author: '', reference: '', url: '',
      body: '压测摘录与反向引用', date: today(), tags: ['ADC'], status: '待排查', pinned: false, attachments: []
    });
    window.__qaSecondary = secondaryBlob ? {
      file: { id: crypto.randomUUID(), name: secondaryBlob.name, mime: 'application/pdf', size: secondaryBlob.size },
      blob: secondaryBlob
    } : null;
    await openReadableAttachment(primaryFile, primaryBlob);
    return { primaryFileId: primaryFile.id, issueId };
  });

  await page.waitForFunction(() => Number(document.getElementById('pdfPageNumber')?.max) > 1 && document.querySelector('.pdf-text-layer'));
  const firstReadableMs = Date.now() - opened;
  const pageCount = Number(await page.locator('#pdfPageNumber').getAttribute('max'));

  // 1. 检查内嵌目录树加载
  await page.waitForFunction(() => {
    const host = document.getElementById('pdfOutlineList');
    return host && host.textContent !== '正在读取目录…';
  });
  const outlineEntries = await page.locator('#pdfOutlineList .pdf-outline-entry').count();

  // 2. 跳到中段双栏正文中页，验证真实文字层提取 + 追加到设计问题 + 页面反向引用角标与回跳
  const midPage = Math.min(pageCount, Math.max(2, Math.floor(pageCount * 0.25)));
  const midStart = Date.now();
  await page.locator('#pdfPageNumber').fill(String(midPage));
  await page.locator('#pdfPageNumber').press('Enter');
  await page.waitForFunction(target =>
    readingSession?.page === target &&
    document.querySelector(`[data-pdf-page="${target}"] .pdf-text-layer`)?.textContent.trim().length > 0,
  midPage);
  const midPageMs = Date.now() - midStart;
  const dualColumnExcerpt = await page.evaluate(async ({ midPage, issueId }) => {
    const layer = document.querySelector(`[data-pdf-page="${midPage}"] .pdf-text-layer`);
    const spans = [...layer.querySelectorAll('span')].filter(node => node.textContent.trim().length > 12);
    const sample = spans[0]?.textContent.trim().slice(0, 160) || layer.textContent.trim().slice(0, 160);
    await appendPdfExcerpt(readingSession, {
      page: midPage, rects: [[0.08, 0.16, 0.38, 0.06]], quote: sample
    }, issueId);
    return { spanCount: spans.length, sampleLength: sample.length };
  }, { midPage, issueId: seeded.issueId });
  await page.locator(`[data-pdf-page="${midPage}"] .pdf-backlink-badge`).waitFor();
  assert.equal(await page.locator(`[data-pdf-page="${midPage}"] .pdf-backlink-badge`).innerText(), '被引用 1');

  // 3. 跳末页性能
  const jump = Date.now();
  await page.locator('#pdfPageNumber').fill(String(pageCount));
  await page.locator('#pdfPageNumber').press('Enter');
  await page.waitForFunction(count => readingSession?.page === count && document.querySelector(`[data-pdf-page="${count}"] .pdf-text-layer`), pageCount);
  const lastPageMs = Date.now() - jump;

  // 4. 多标签并发打开第二篇双栏论文并关闭标签回收
  let multiTab = null;
  if (hasSecondPdf) {
    const tabStart = Date.now();
    const secondInfo = await page.evaluate(async () => {
      const { file, blob } = window.__qaSecondary;
      await openReadableAttachment(file, blob);
      return { id: file.id, name: file.name };
    });
    await page.waitForFunction(id => readingSession?.file.id === id && document.querySelector('.pdf-text-layer'), secondInfo.id);
    const secondPages = Number(await page.locator('#pdfPageNumber').getAttribute('max'));
    const tabOpenMs = Date.now() - tabStart;
    assert.equal(await page.locator('#readerTabs .reader-tab').count(), 2);
    await page.locator(`#readerTabs [data-reader-tab-close="${secondInfo.id}"]`).click();
    await page.waitForFunction(primaryId => readingSession?.file.id === primaryId && document.querySelector('.pdf-text-layer'), seeded.primaryFileId);
    multiTab = { file: secondInfo.name, pages: secondPages, tabOpenMs, activeRestored: true };
  }

  peak = Math.max(peak, headlessEdgeWorkingSetBytes());

  // 5. 分段索引中断续跑与关键词命中
  const index = await page.evaluate(async () => {
    const file = readingSession.file;
    const pdf = readingSession.pdf;
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
    pages: pageCount,
    outlineEntries,
    firstReadableMs,
    midPage,
    midPageMs,
    lastPageMs,
    dualColumnExcerpt,
    multiTab,
    headlessEdgeWorkingSetBytes: peak,
    index
  }, null, 2));
} finally {
  clearInterval(timer);
  await browser.close();
}
