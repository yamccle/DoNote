/**
 * [INPUT]: 读取 PDF 页面画布、框选区域与离线 Tesseract worker。
 * [OUTPUT]: 提供 recognizePdfRegion，将离线识别文本交给翻译/摘录侧栏并写入本机检索索引。
 * [POS]: 扫描页与缺失文字层页面的离线识字入口，衔接 pdf-translation.js 与 pdf-search.js。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
// Offline OCR for scanned PDFs and pages with an unusable text layer.
const pdfOcrWorkers = new Map();

function pdfOcrWorker(language) {
 if (pdfOcrWorkers.has(language)) return pdfOcrWorkers.get(language);
 const asset = new URL('ocr/', location.href).href;
 const worker = Tesseract.createWorker(language === 'zh' ? ['chi_sim', 'eng'] : 'eng', 1, {
  workerPath: asset + 'worker.min.js',
  corePath: asset,
  langPath: asset,
  workerBlobURL: false,
 });
 pdfOcrWorkers.set(language, worker);
 worker.catch(() => pdfOcrWorkers.delete(language));
 return worker;
}

async function recognizePdfRegion(session, pageBox, rect, pageNumber) {
 if (session.ocrBusy) return;
 const source = pageBox.querySelector('canvas');
 if (!source || rect[2] < .008 || rect[3] < .008) return;
 const status = document.getElementById('pdfTranslationStatus');
 const button = document.getElementById('pdfOcrMode');
 session.ocrBusy = true;
 if (button) button.disabled = true;
 if (status) status.textContent = '正在离线识别所框选的文字…';
 try {
  const sx = Math.max(0, Math.floor(rect[0] * source.width));
  const sy = Math.max(0, Math.floor(rect[1] * source.height));
  const sw = Math.min(source.width - sx, Math.ceil(rect[2] * source.width));
  const sh = Math.min(source.height - sy, Math.ceil(rect[3] * source.height));
  if (sw < 4 || sh < 4) return;
  const scale = Math.min(2, 3000 / sw, 3000 / sh);
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.round(sw * scale));
  crop.height = Math.max(1, Math.round(sh * scale));
  const context = crop.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
  const language = document.getElementById('pdfSourceLang')?.value === 'zh' ? 'zh' : 'en';
  const worker = await pdfOcrWorker(language);
  const result = await worker.recognize(crop);
  if (readingSession !== session) return;
  const quote = normalizePdfTranslationText(result.data?.text || '').trim();
  if (!quote) {
   if (status) status.textContent = '没有识别到文字。请框选更清晰的文字区域，或放大页面后重试。';
   return;
  }
  const picked = { page: pageNumber, quote, rects: [rect] };
  session.picked = picked;
  session.translationSelection = picked;
  if (typeof savePdfOcrPageText === 'function') {
   void savePdfOcrPageText(session.profileId, session.file.id, session.pdf?.numPages || pageNumber, pageNumber, quote).catch(() => {});
  }
  await session.receiveOcrText?.(picked);
  if (status) status.textContent = '已离线识别文字并加入本机检索。可直接翻译、存为研究笔记或追加到记录；复杂公式请核对识别结果。';
 } catch (error) {
  session.ocrError = String(error?.message || error);
  if (readingSession === session && status) status.textContent = '离线识字失败：' + session.ocrError;
 } finally {
  session.ocrBusy = false;
  if (button) button.disabled = false;
 }
}
