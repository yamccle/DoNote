/**
 * [INPUT]: 读取 PDF.js 文本项坐标矩阵、页面几何尺寸以及内置 Marked / KaTeX 渲染器。
 * [OUTPUT]: 提供 buildReflowLayout、pdfReflowLines、translatableReflowBlock、fillReflowMarkdown、renderReflowImagePage 与 croppedReflowPdfImage。
 * [POS]: PDF 智能排版无状态几何分栏算法、公式 Markdown 填充与高分图表裁剪工具层，供 pdf-reflow.js 调用。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const REFLOW_CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

function reflowMedian(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function reflowItems(items) {
  const result = [];
  for (const item of items) {
    const str = item.str; if (typeof str !== 'string' || !str.trim()) continue;
    const t = item.transform || [];
    const x = Number(t[4]), y = Number(t[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const h = Math.max(1, Number(item.height) || Math.abs(Number(t[3])) || 10);
    const w = Number.isFinite(Number(item.width)) ? Number(item.width) : str.length * h * 0.5;
    result.push({ str, x, y, w, h });
  }
  return result;
}

function reflowJoinItems(items) {
  let text = '';
  for (const item of items) {
    if (!text) { text = item.str; continue; }
    const previous = text[text.length - 1], next = item.str[0];
    const space = !/\s$/.test(text) && !/^\s/.test(item.str) && !(REFLOW_CJK.test(previous) && REFLOW_CJK.test(next));
    text += (space ? ' ' : '') + item.str;
  }
  return text.replace(/[ \t\u00a0]+/g, ' ').trim();
}

function reflowJoinParagraph(texts) {
  let text = '';
  for (const raw of texts) {
    const part = raw.trim(); if (!part) continue;
    if (!text) { text = part; continue; }
    if (/-$/.test(text) && /^[a-z]/.test(part)) text = text.slice(0, -1) + part;
    else if (REFLOW_CJK.test(text[text.length - 1]) && REFLOW_CJK.test(part[0])) text += part;
    else text += ' ' + part;
  }
  return text;
}

function reflowLines(items, pageWidth) {
  const normalized = reflowItems(items), rows = [];
  for (const item of normalized) {
    let row = null;
    for (let index = rows.length - 1; index >= 0 && index >= rows.length - 4; index--) {
      const candidate = rows[index];
      if (Math.abs(candidate.y - item.y) <= Math.max(1.6, Math.min(candidate.h, item.h) * 0.45)) { row = candidate; break; }
    }
    if (!row) { row = { y: item.y, h: item.h, items: [] }; rows.push(row); }
    row.items.push(item); row.h = Math.max(row.h, item.h);
  }
  const gapLimit = Math.max(8, (Number(pageWidth) || 0) * 0.045), lines = [];
  const push = segment => {
    if (!segment.length) return;
    const x0 = segment[0].x, x1 = Math.max(...segment.map(item => item.x + item.w));
    const text = reflowJoinItems(segment);
    if (text) lines.push({ y: segment[0].y, h: Math.max(...segment.map(item => item.h)), items: segment, x0, x1, text });
  };
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let segment = [];
    for (const item of row.items) {
      if (segment.length) {
        const previous = segment[segment.length - 1];
        if (item.x - (previous.x + previous.w) > gapLimit) { push(segment); segment = []; }
      }
      segment.push(item);
    }
    push(segment);
  }
  lines.sort((a, b) => b.y - a.y || a.x - b.x);
  return lines;
}

function reflowDropFurniture(lines, pageHeight) {
  if (lines.length < 4) return lines;
  const medianH = reflowMedian(lines.map(line => line.h)) || 10;
  const furniture = line => {
    const nearTop = Number.isFinite(pageHeight) && pageHeight > 0 && line.y > pageHeight * 0.945;
    const nearBottom = Number.isFinite(pageHeight) && pageHeight > 0 && line.y < pageHeight * 0.055;
    const pageNumber = /^(?:[-–—]\s*)?\d{1,4}(?:\s*[-–—])?$/.test(line.text) || /^第?\s*\d{1,4}\s*页?$/.test(line.text);
    const short = (nearTop || nearBottom) && line.text.length < 90 && line.h <= medianH * 1.15;
    return short || pageNumber;
  };
  const kept = lines.filter(line => !furniture(line));
  return kept.length >= 3 ? kept : lines;
}

function reflowOrderLines(lines, pageWidth) {
  const width = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : Math.max(...lines.map(line => line.x1), 1);
  const mid = width / 2;
  const byVertical = (a, b) => b.y - a.y || a.x - b.x;
  const wide = lines.filter(line => line.x0 < mid && line.x1 > mid);
  const rest = lines.filter(line => !(line.x0 < mid && line.x1 > mid));
  const left = rest.filter(line => line.x0 < mid), right = rest.filter(line => line.x0 >= mid);
  const gutter = left.length && right.length ? Math.min(...right.map(line => line.x0)) - Math.max(...left.map(line => line.x1)) : -1;
  const twoColumn = left.length >= 3 && right.length >= 3 && gutter > -width * 0.01;
  if (!twoColumn) { lines.sort(byVertical); return { lines, twoColumn: false }; }
  return { lines: [...wide.sort(byVertical), ...left.sort(byVertical), ...right.sort(byVertical)], twoColumn: true };
}

function reflowBlocks(lines, pageWidth) {
  const medianH = reflowMedian(lines.map(line => line.h)) || 10;
  const blocks = []; let current = null, previous = null;
  const middle = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth / 2 : Infinity;
  for (const line of lines) {
    const heading = line.h >= medianH * 1.22 && line.text.length <= 100 && !/[.。!?！？:：;,，]$/.test(line.text);
    if (heading) {
      const level = line.h >= medianH * 1.55 ? 2 : 3;
      blocks.push({ type: 'heading', level, text: line.text }); current = null; previous = line; continue;
    }
    const gap = previous ? previous.y - line.y : -1;
    const indent = previous ? line.x0 - previous.x0 : 0;
    const columnChange = previous ? ((previous.x0 >= middle) !== (line.x0 >= middle)) : false;
    const sentenceEnd = previous ? /[.。!?！？]["”』)）]?$/.test(previous.text) : false;
    if (!current || columnChange || gap > medianH * 2.1 || gap < 0 || indent > medianH * 1.15 || (sentenceEnd && indent > medianH * 0.35)) {
      current = { type: 'para', lines: [] }; blocks.push(current);
    }
    current.lines.push(line.text); previous = line;
  }
  for (const block of blocks) if (block.type === 'para') block.text = reflowJoinParagraph(block.lines);
  return blocks.filter(block => block.text.trim());
}

function buildReflowLayout(items, pageWidth, pageHeight) {
  const lines = reflowDropFurniture(reflowLines(items, pageWidth), pageHeight);
  const ordered = reflowOrderLines(lines.slice(), pageWidth);
  return { lines: ordered.lines, blocks: reflowBlocks(ordered.lines, pageWidth), twoColumn: ordered.twoColumn };
}

function pdfReflowLines(items) {
  return buildReflowLayout(items).lines.map(line => line.text);
}

function translatableReflowBlock(block) {
  return ['para', 'heading', 'list', 'caption', 'image'].includes(block.type) && !!block.text.trim();
}

function fillReflowMarkdown(node, text, block, renderedTranslation = false) {
  let clean = wellFormedText(text).trim();
  if (block.type === 'heading') clean = clean.replace(/^#{1,6}\s+/, '');
  const listStart = /^\s*(\d{1,6})[.)]\s+/.exec(block.text);
  const oneListItem = listStart && !/\n\s*\d{1,6}[.)]\s+/.test(block.text);
  const inline = block.type === 'heading' || oneListItem;
  if (oneListItem) clean = clean.replace(/^\s*\d{1,6}[.)]\s+/, '');
  if (block.type === 'equation' && !/^(?:\$|\\\[|\\\()/.test(clean)) clean = '$$\n' + clean + '\n$$';
  const html = typeof marked === 'undefined' ? esc(clean) :
    inline ? marked.parseInline(clean) : marked.parse(clean, { gfm: true, breaks: block.type !== 'para' });
  node.innerHTML = safeRichHtml(oneListItem ? '<ol start="' + listStart[1] + '"><li>' + html + '</li></ol>' : html);
  if (!renderedTranslation && block.type === 'heading') node.classList.add('pdf-reflow-heading');
  if (window.renderMathInElement) {
    try {
      renderMathInElement(node, {
        throwOnError: false,
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true }
        ]
      });
    } catch {}
  }
}

async function renderReflowImagePage(pdfDoc, pageNumber, signal) {
  const page = await pdfDoc.getPage(pageNumber), base = page.getViewport({ scale: 1 });
  signal.throwIfAborted();
  const scale = Math.min(2.2, 1800 / Math.max(1, base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
  const render = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
  const cancel = () => render.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try { await render.promise; return canvas; }
  finally { signal.removeEventListener('abort', cancel); }
}

function croppedReflowPdfImage(pageNumber, bbox, getCanvas, signal, pageImagesMap, urlSet) {
  const key = pageNumber + ':' + bbox.join(','), cached = pageImagesMap.get(key);
  if (cached) return cached;
  const task = (async () => {
    const canvas = await getCanvas();
    signal.throwIfAborted();
    const [x0, y0, x1, y1] = bbox;
    const left = Math.floor(x0 * canvas.width), top = Math.floor(y0 * canvas.height);
    const right = Math.ceil(x1 * canvas.width), bottom = Math.ceil(y1 * canvas.height);
    const crop = document.createElement('canvas'); crop.width = Math.max(1, right - left); crop.height = Math.max(1, bottom - top);
    crop.getContext('2d', { alpha: false }).drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const blob = await new Promise(resolve => crop.toBlob(resolve, 'image/png'));
    signal.throwIfAborted();
    if (!blob) throw new Error('无法生成图片。');
    const url = URL.createObjectURL(blob); urlSet.add(url); return url;
  })();
  pageImagesMap.set(key, task);
  task.catch(() => pageImagesMap.delete(key));
  return task;
}
