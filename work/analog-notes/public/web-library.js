/**
 * [INPUT]: 读取收藏网页弹窗输入、极速纯正文选项与宿主抓取结果。
 * [OUTPUT]: 提供 canonicalWebArticleUrl、validWebArticle、openLiveWebPage 与网页入库控制器。
 * [POS]: 文献与媒体库的网页离线收藏入口，衔接单进程并发抓取与阅读器打开。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

function canonicalWebArticleUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) {
    throw new Error('请输入有效的公开网页地址。');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function validWebArticle(note) {
  const value = note.webArticle;
  if (value === undefined) {
    return !note.attachments?.some(file => file.webRole !== undefined) && note.webAnnotations === undefined && note.webReading === undefined;
  }
  try {
    if (note.type !== 'resource' || !value || canonicalWebArticleUrl(value.url) !== value.url ||
        typeof value.excerpt !== 'string' || value.excerpt.length > 1500 ||
        typeof value.searchText !== 'string' || value.searchText.length > 120000 ||
        typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) return false;
    const webFiles = note.attachments.filter(file => file.webRole !== undefined);
    return webFiles.length === 2 &&
      ['article', 'snapshot'].every(role => webFiles.filter(file => file.webRole === role && file.mime === 'text/html' && file.size <= 20 * 1024 ** 2).length === 1) &&
      (note.webAnnotations === undefined || validWebAnnotations(note.webAnnotations)) &&
      (note.webReading === undefined || validWebReading(note.webReading));
  } catch {
    return false;
  }
}

function openLiveWebPage(note) {
  const host = location.origin === 'https://yams-one.example' ? window.chrome?.webview : null;
  if (!host || !note.webArticle) return;
  host.postMessage('open-live-webpage:' + JSON.stringify({ url: note.webArticle.url, recordId: note.id, profileId: appState.activeId }));
}

{
  const host = location.origin === 'https://yams-one.example' ? window.chrome?.webview : null;
  const dialog = $('captureWebDialog'), input = $('captureWebUrl'), submit = $('captureWebSubmit'), message = $('captureWebStatus');
  const fastCheck = $('captureWebFastMode');
  const fastPrefKey = 'donote-web-capture-fast';
  $('captureWebPage').hidden = !host;
  $('captureWebPage').onclick = () => {
    if (!ensureReady()) return;
    $('captureWebForm').reset();
    if (fastCheck) {
      try { fastCheck.checked = localStorage.getItem(fastPrefKey) === '1'; } catch {}
    }
    message.textContent = '';
    dialog.showModal();
    input.focus();
  };
  fastCheck?.addEventListener('change', () => {
    try { localStorage.setItem(fastPrefKey, fastCheck.checked ? '1' : '0'); } catch {}
  });
  $('captureWebForm').onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const profileId = appState.activeId;
    const fastOnly = !!fastCheck?.checked;
    const startedAt = performance.now();
    submit.disabled = true;
    message.textContent = fastOnly ? '正在极速提取网页正文…' : '正在并发抓取网页正文与配图…';
    try {
      const url = canonicalWebArticleUrl(input.value.trim());
      let saved = records.find(note => note.webArticle?.url === url);
      if (!saved) {
        const page = await captureWebArticle(url, { cacheAssets: !fastOnly });
        if (appState.activeId !== profileId || !dialog.open) throw new Error('收藏已取消，请在当前工作台重新操作。');
        const canonical = canonicalWebArticleUrl(page.url || url);
        saved = records.find(note => note.webArticle?.url === canonical);
        if (!saved) {
          const now = new Date().toISOString(), writes = [];
          const attachments = [['article', '网页正文.html', page.contentHtml], ['snapshot', '原网页快照.html', page.snapshotHtml]].map(([webRole, name, html]) => {
            if (typeof html !== 'string' || !html.trim()) throw new Error('网页未能生成离线副本。');
            const blob = new Blob([html], { type: 'text/html' }), id = crypto.randomUUID();
            writes.push({ key: fileKey(profileId, id), blob });
            return { id, name, mime: blob.type, size: blob.size, addedAt: now, webRole };
          });
          const parsed = new DOMParser().parseFromString(page.contentHtml, 'text/html');
          const searchText = parsed.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 120000);
          const title = String(page.title || new URL(canonical).hostname).trim().slice(0, 240) || new URL(canonical).hostname;
          const note = {
            id: crypto.randomUUID(), type: 'resource', title, date: today(),
            author: String(page.byline || '').trim().slice(0, 200),
            url: canonical, reference: '', body: '', bodyHtml: '', tags: [], pinned: false, status: '待读', attachments,
            webArticle: { url: canonical, capturedAt: now, excerpt: String(page.excerpt || '').trim().slice(0, 1500), searchText }
          };
          if (!validWebArticle(note)) throw new Error('网页内容超过可保存范围。');
          saved = await put(assignDefaultFolder(note), writes);
          const sec = ((performance.now() - startedAt) / 1000).toFixed(1);
          toast(
            fastOnly ? '网页正文已极速保存（' + sec + ' 秒）。'
            : page.missingImages ? '网页已保存（' + sec + ' 秒），跳过 ' + page.missingImages + ' 张慢速或外链图片。'
            : '网页正文与快照已完整缓存（' + sec + ' 秒）。'
          );
        }
      }
      dialog.close();
      if (view !== 'resource') switchView('resource'); else render();
      openSavedWebpage(saved);
    } catch (error) {
      if (dialog.open) message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
  host?.addEventListener('message', async event => {
    const data = event.data;
    if (data?.type !== 'yams-one-live-annotation') return;
    if (data.profileId !== appState?.activeId) { toast('请切回打开原网页时的工作台，再保存标注。'); return; }
    try { await addWebArticleAnnotation(data.recordId, { quote: data.quote, note: data.note }); toast('原网页标注已保存到对应收藏。'); }
    catch (error) { toast(error.message); }
  });
}
