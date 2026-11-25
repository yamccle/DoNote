/**
 * [INPUT]: 读取 PDF 文档对象、IndexedDB workspace 分段缓存及框选识字文本。
 * [OUTPUT]: 提供 buildPdfSearchIndex、readSearchIndex、savePdfOcrPageText、searchPdfIndex 与 installPdfFind。
 * [POS]: 阅读器内查找、文献指标对比与全库全文检索共用的持久化页面文字索引层。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
// PDF 全文索引与检索：
//  - 按需为每份 PDF 提取文本（页面定位），索引以 JSON blob 存进本机文件库；
//  - 工作台全文检索复用这一份持久化页面文字索引；
//  - 阅读器左侧「查找」在打开的 PDF 内搜索；
//  - 启动后空闲时预先索引最近几份 PDF。
const PDF_INDEX_BATCH = 24;
const SEARCH_BACKGROUND_COUNT = 3;
const pdfIndexPrefix = (profileId, fileId) => 'pdf-index-v3/' + profileId + '/' + fileId + '/';
const pdfOcrIndexKey = (profileId, fileId) => pdfIndexPrefix(profileId, fileId) + 'ocr';

function pdfSearchCandidates() {
 return records.filter(note => note.attachments?.some(f => fileIsPdf(f) || (typeof fileIsPresentation === 'function' && fileIsPresentation(f))));
}

async function readPdfIndexSegments(fileId, profileId) {
 const tx = database.transaction('workspace');
 const items = await reqResult(tx.objectStore('workspace').getAll(keyPrefixRange(pdfIndexPrefix(profileId, fileId))));
 return items.filter(item => Number.isInteger(item?.start));
}

function checkedPdfOcrPages(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('扫描识字索引格式无效。');
 const keys = Object.keys(value);
 if (keys.length > 10000) throw new Error('扫描识字索引页数过多。');
 const clean = {};
 for (const key of keys) {
  const n = Number(key), text = value[key];
  if (!Number.isInteger(n) || n < 1 || n > 100000 || typeof text !== 'string' || text.length > 60000) {
   throw new Error('扫描识字索引格式无效。');
  }
  const trimmed = text.trim();
  if (trimmed) clean[n] = trimmed;
 }
 return clean;
}

async function readPdfOcrPages(fileId, profileId) {
 const tx = database.transaction('workspace');
 const stored = await reqResult(tx.objectStore('workspace').get(pdfOcrIndexKey(profileId, fileId)));
 if (stored && typeof stored === 'object' && stored.pages) return stored;
 const profile = appState?.profiles?.find(item => item.id === profileId);
 const attachment = profile?.records?.flatMap(note => note.attachments || []).find(item => item.id === fileId);
 if (attachment?.ocrPages && Object.keys(attachment.ocrPages).length) {
  const pages = checkedPdfOcrPages(attachment.ocrPages);
  const maxPage = Math.max(1, ...Object.keys(pages).map(Number));
  return { totalPages: maxPage, pages };
 }
 return null;
}

async function savePdfOcrPageText(profileId, fileId, totalPages, pageNumber, quote) {
 const clean = normalizePdfTranslationText(quote || '').replace(/\s+/g, ' ').trim();
 if (!clean || !Number.isInteger(pageNumber) || pageNumber < 1) return false;
 const current = await readPdfOcrPages(fileId, profileId);
 const pages = { ...(current?.pages || {}) };
 const existing = String(pages[pageNumber] || '');
 if (existing.includes(clean)) return true;
 pages[pageNumber] = (existing ? existing + ' ' + clean : clean).slice(0, 40000);
 return putWorkspaceForFile(profileId, fileId, pdfOcrIndexKey(profileId, fileId), {
  totalPages: Math.max(Number(totalPages) || 0, Number(current?.totalPages) || 0, pageNumber),
  pages
 });
}

async function readSearchIndex(fileId, profileId) {
 const [rawSegments, ocr] = await Promise.all([
  readPdfIndexSegments(fileId, profileId),
  readPdfOcrPages(fileId, profileId)
 ]);
 const segments = rawSegments.sort((a,b) => a.start-b.start);
 if (!segments.length && !ocr) return null;
 const totalPages = segments[0]?.totalPages || ocr.totalPages || 0;
 const index = {totalPages, scannedPages:0, failedPages:[], emptyPages:[], pages:[]};
 for (const segment of segments) {
  if (segment.totalPages !== totalPages || segment.start !== index.scannedPages+1) break;
  index.scannedPages = segment.end;
  index.failedPages.push(...segment.failedPages);
  index.emptyPages.push(...segment.emptyPages);
  index.pages.push(...segment.pages.map(page => ({...page})));
 }
 if (ocr?.pages) {
  const byPage = new Map(index.pages.map(page => [page.n, page]));
  for (const [key, text] of Object.entries(ocr.pages)) {
   const n = Number(key);
   if (!Number.isInteger(n) || n < 1 || typeof text !== 'string' || !text.trim()) continue;
   const entry = byPage.get(n);
   if (entry) { if (!entry.text.includes(text)) entry.text = (entry.text + ' ' + text).slice(0, 60000); }
   else { const created = {n, text}; byPage.set(n, created); index.pages.push(created); }
  }
  index.pages.sort((a,b) => a.n-b.n);
  index.emptyPages = index.emptyPages.filter(n => !byPage.has(n));
 }
 return index;
}

async function extractPdfIndexSegment(pdf, start, end, signal, onProgress) {
 const segment = {start,end,totalPages:pdf.numPages,failedPages:[],emptyPages:[],pages:[]};
 for (let n=start; n<=end; n++) {
  signal?.throwIfAborted();
  try {
   const page = await pdf.getPage(n);
   const content = await page.getTextContent();
   const text = normalizePdfTranslationText(content.items.map(item =>
    item.str + (item.hasEOL ? '\n' : '')).join('')).replace(/\s+/g,' ').trim();
   if (text) segment.pages.push({n,text});
   else segment.emptyPages.push(n);
  } catch (error) {
   signal?.throwIfAborted();
   segment.failedPages.push(n);
  }
  onProgress?.({page:n,total:pdf.numPages});
 }
 signal?.throwIfAborted();
 return segment;
}

async function buildPdfSearchIndex(file,{profileId=appState.activeId,pdf,signal,onProgress,retry=false}={}) {
 const prefix = pdfIndexPrefix(profileId,file.id);
 const build = async () => {
  let task,stopping;
  const stop = () => stopping ??= task?.destroy().catch(()=>{});
  try {
   signal?.throwIfAborted();
   const segments = await readPdfIndexSegments(file.id, profileId);
   const existing = new Map(segments.map(segment=>[segment.start,segment]));
   const cached = await readSearchIndex(file.id, profileId);
   if (cached && cached.scannedPages===cached.totalPages && (!retry || !cached.failedPages.length)) return cached;
   if (!pdf) {
    const raw = await readBlob(file.id,profileId);
    task = await localPdfTask(await pdfLibrary(),raw,signal);
    signal?.addEventListener('abort',stop,{once:true});
    signal?.throwIfAborted();
    pdf = await task.promise;
   }
   for (let start=1; start<=pdf.numPages; start+=PDF_INDEX_BATCH) {
    signal?.throwIfAborted();
    if (appState.activeId!==profileId) throw new DOMException('工作台已切换。','AbortError');
    const end = Math.min(pdf.numPages,start+PDF_INDEX_BATCH-1);
    const saved = existing.get(start);
    if (saved?.end===end && saved.totalPages===pdf.numPages && (!retry || !saved.failedPages.length)) continue;
    const segment = await extractPdfIndexSegment(pdf,start,end,signal,onProgress);
    if (!await putWorkspaceForFile(profileId,file.id,prefix+String(start).padStart(8,'0'),segment)) {
     throw new Error('原 PDF 已移除。');
    }
   }
   return readSearchIndex(file.id,profileId);
  } finally {
   signal?.removeEventListener('abort',stop);
   await stop();
  }
 };
 return navigator.locks ? navigator.locks.request(prefix,signal ? {signal} : {},build) : build();
}
function searchPdfIndex(index,query){
 const terms=query.toLowerCase().split(/\s+/).filter(Boolean),hits=[];
 if(!terms.length||!index?.pages)return hits;
 for(const page of index.pages){
  const text=page.text.toLowerCase();
  if(!terms.every(term=>text.includes(term)))continue;
  const positions=terms.map(term=>text.indexOf(term));
  const first=Math.min(...positions),start=Math.max(0,first-46),end=Math.min(page.text.length,first+130);
  hits.push({page:page.n,snippet:page.text.slice(start,end),pre:'…'});
 }
 return hits;
}
function pdfIndexCoverage(index){
 const warnings=[];
 if(index.scannedPages<index.totalPages)warnings.push('已索引前 '+index.scannedPages+'/'+index.totalPages+' 页');
 if(index.failedPages.length)warnings.push(index.failedPages.length+' 页读取失败');
 if(index.emptyPages.length)warnings.push(index.emptyPages.length+' 页没有可搜索文字（可能是扫描页，可在阅读器框选识字）');
 return warnings.join('；');
}
// ── 阅读器内查找 ──
function installPdfFind(session,toc){
 if(!toc)return;
 const zone=document.createElement('section');zone.className='pdf-find';
 zone.innerHTML='<label class="pdf-find-row"><input id="pdfFindInput" placeholder="搜索当前文档…" aria-label="在当前 PDF 中搜索"></label><p class="tiny" id="pdfFindCount" role="status"></p><div class="row"><button type="button" class="secondary" data-pause>暂停</button><button type="button" class="secondary" data-resume>继续 / 重试</button></div><div id="pdfFindResults"></div>';
 toc.querySelector('#pdfFindPane').append(zone);
 const input=zone.querySelector('#pdfFindInput'),count=zone.querySelector('#pdfFindCount'),results=zone.querySelector('#pdfFindResults');
 const {signal}=session.controller;
 let index=null,indexPromise,timer,token=0,indexController=new AbortController();
 zone.querySelector('[data-pause]').onclick=()=>{
  clearTimeout(timer);++token;indexController.abort();indexPromise=null;index=null;
  count.textContent='已暂停。已完成的分段已保存。';
 };
 zone.querySelector('[data-resume]').onclick=()=>{
  indexController.abort();indexPromise=null;index=null;void run(true);
 };
 signal.addEventListener('abort',()=>indexController.abort(),{once:true});
 document.addEventListener('workspace-search-file-updated',({detail})=>{
  if(detail?.profileId===session.profileId&&detail?.fileId===session.file.id){index=null;indexPromise=null}
 },{signal});
 const run=async(retry=false)=>{
  clearTimeout(timer);const current=++token,query=input.value.trim();results.replaceChildren();count.textContent='';
  if(!query){return}
  if(!index){
   count.textContent='正在建立索引…';
   if(indexController.signal.aborted)indexController=new AbortController();
   const taskSignal=indexController.signal;
   indexPromise??=(async()=>{
    const cached=await readSearchIndex(session.file.id,session.profileId);
    return cached && cached.scannedPages===cached.totalPages && (!retry || !cached.failedPages.length) ? cached : buildPdfSearchIndex(session.file,{profileId:session.profileId,pdf:session.pdf,signal:taskSignal,retry,onProgress:({page,total})=>{
     if(!taskSignal.aborted)count.textContent='正在建立索引 '+page+'/'+total+' 页…';
    }});
   })();
   const pending=indexPromise;
   try{const built=await pending;if(indexPromise===pending)index=built}catch(error){
    if(indexPromise===pending)indexPromise=null;
    if(!signal.aborted&&current===token)count.textContent='索引失败：'+error.message;
    return;
   }
  }
  if(signal.aborted||current!==token||query!==input.value.trim())return;
  const allHits=searchPdfIndex(index,query),hits=allHits.slice(0,60),coverage=pdfIndexCoverage(index);
  count.textContent=(allHits.length?allHits.length+' 处命中'+(allHits.length>hits.length?'（显示前 '+hits.length+' 处）':''):'无匹配')+(coverage?'；'+coverage:'');
  for(const hit of hits){
   const row=document.createElement('button');row.type='button';
   row.innerHTML='<strong>'+hit.page+'</strong><span>'+esc(hit.snippet)+'</span>';
   row.onclick=()=>session.showPage(hit.page);
   results.append(row);
  }
 };
 input.oninput=()=>{clearTimeout(timer);timer=setTimeout(run,240)};
 input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(timer);run()}};
 document.addEventListener('keydown',event=>{
  const reader=$('reader');
  if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='f'&&
     readingSession===session&&reader.open&&!toc.closest('[hidden]')&&
     (reader.contains(event.target)||event.target===document.body)){
   event.preventDefault();
   if(toc.closest('.hide-outline,.pdf-focus-mode'))$('togglePdfOutline')?.click();
   session.showPdfNavigation('find');
   input.focus();input.select();
  }
 },{signal});
 signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
}

// ── 空闲时预先索引最近几份 PDF ──
async function preIndexRecentPdfs(){
 if(!ready||preIndexStarted)return;preIndexStarted=true;
 const profileId=appState.activeId;
 try{
  const candidates=pdfSearchCandidates().sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,SEARCH_BACKGROUND_COUNT);
  for(const note of candidates){
   if(appState.activeId!==profileId)break;
   const file=(note.attachments||[]).find(f=>fileIsPdf(f)||(typeof fileIsPresentation==='function'&&fileIsPresentation(f)));if(!file||file.size>MAX_DOCUMENT_PREVIEW)continue;
   const index=await readSearchIndex(file.id,profileId);
   if(index && index.scannedPages===index.totalPages)continue;
   try{
    if(fileIsPdf(file))await buildPdfSearchIndex(file,{profileId});
    else if(typeof buildPresentationSearchIndex==='function')await buildPresentationSearchIndex(file,{profileId});
   }catch{}
   await new Promise(resolve=>setTimeout(resolve,60));
  }
 }catch{}
}
let preIndexStarted=false;
