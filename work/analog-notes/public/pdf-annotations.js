'use strict';

/**
 * [INPUT]: 读取 PDF 会话、选区和标注工具。
 * [OUTPUT]: 提供标注模式、笔迹和标注菜单。
 * [POS]: 在阅读会话中更新标注和页面叠层。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
let annotationQueue=Promise.resolve();
const PDF_MARK_PALETTE=[
 ['#f4d03f','黄色'],['#77cfa0','绿色'],['#7eb6f3','蓝色'],
 ['#e8a0c4','粉色'],['#f3a35c','橙色'],['#bda0ed','紫色']
];
const MARK_COLORS=PDF_MARK_PALETTE.map(([color])=>color);
const TOGGLE_PDF_MARKS=['highlight','underline','strike'];
const PDF_TEXT_FONTS={system:'system-ui, sans-serif',serif:'Georgia, serif',mono:'Consolas, monospace'};
function pdfTextStyle(mark){
 return {fontFamily:Object.hasOwn(PDF_TEXT_FONTS,mark.fontFamily)?mark.fontFamily:'system',fontSize:Number.isFinite(mark.fontSize)?Math.max(8,Math.min(72,mark.fontSize)):12};
}
function annotationKey(profileId,fileId){return 'pdf-marks/'+profileId+'/'+fileId}
const PDF_ANNOTATION_LABELS = {
 highlight: '高亮', underline: '下划线', strike: '删除线', comment: '注释',
 rect: '矩形', pen: '手绘', text: '文字框', bookmark: '书签', translation: '翻译'
};

function validPdfCoordinates(items, dimensions, limit) {
 return Array.isArray(items) && items.length <= limit && items.every(item =>
  Array.isArray(item) && item.length === dimensions &&
  item.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
 );
}

function checkedAnnotations(value) {
 if (!Array.isArray(value) || value.length > 5000) throw new Error('批注数据无效或过多。');
 return value.map(annotation => {
  if (!annotation) throw new Error('批注格式无效。');
  const {id, kind, page, quote, note, color, rects, points, createdAt} = annotation;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id) ||
      typeof kind !== 'string' || !Object.hasOwn(PDF_ANNOTATION_LABELS, kind) ||
      !Number.isInteger(page) || page < 1 || page > 100000 ||
      typeof quote !== 'string' || quote.length > 20000 ||
      typeof note !== 'string' || note.length > 30000 ||
      !MARK_COLORS.includes(color) ||
      !validPdfCoordinates(rects, 4, 500) || !validPdfCoordinates(points, 2, 3000)) {
   throw new Error('批注格式无效。');
  }
  return {
   id, kind, page, quote, note, color, rects, points,
   createdAt: typeof createdAt === 'string' ? createdAt : '',
   ...(kind === 'text' ? pdfTextStyle(annotation) : {})
  };
 });
}
const annotationRecoveryKey=(profile,file)=>'donote-recover/'+annotationKey(profile,file);
async function fileAnnotations(profileId,file){
 const stored=await reqResult(database.transaction('workspace').objectStore('workspace').get(annotationKey(profileId,file.id)));
 let pending;
 try{const raw=localStorage.getItem(annotationRecoveryKey(profileId,file.id));if(raw)pending=checkedAnnotations(JSON.parse(raw));}catch{}
 if(!pending)return checkedAnnotations(stored??file.annotations??[]);
 try{
  if(await putWorkspaceForFile(profileId,file.id,annotationKey(profileId,file.id),pending)){
   localStorage.removeItem(annotationRecoveryKey(profileId,file.id));
   toast('已恢复上次未保存的批注。');
  }
 }catch{}
 return pending;
}
function savePdfMarks(session){
 const snapshot=structuredClone(session.annotations),profile=session.profileId,id=session.file.id;
 const key=annotationRecoveryKey(profile,id),revision=Symbol();
 session.annotationSaveRevision=revision;
 if(readingSession===session&&$('markSaveStatus'))$('markSaveStatus').textContent='正在保存批注…';
 let recovery;
 try{recovery=JSON.stringify(snapshot);localStorage.setItem(key,recovery);}catch{recovery=null;}
 annotationQueue=annotationQueue.catch(()=>{}).then(async()=>{
  if(!await putWorkspaceForFile(profile,id,annotationKey(profile,id),snapshot))throw new Error('原资料已删除。');
  try{if(recovery&&localStorage.getItem(key)===recovery)localStorage.removeItem(key);}catch{}
  if(session.annotationSaveRevision===revision&&readingSession===session&&$('markSaveStatus'))$('markSaveStatus').textContent='批注已保存到本机';
 }).catch(error=>{
  if(session.annotationSaveRevision===revision&&readingSession===session&&$('markSaveStatus'))$('markSaveStatus').textContent=recovery?'保存失败，已暂存批注，可重新打开恢复。':'批注保存失败，请导出批注并保留页面。';
  toast(error.message);
 });
 return annotationQueue;
}
function capturePdfSelection(session){
 const selection=getSelection(),box=session.pageBox,previous=session.picked?.page===session.page?session.picked:null;
 if(!selection?.rangeCount||selection.isCollapsed||!box||session.restoring)return previous;
 const range=selection.getRangeAt(0),layer=box.querySelector('.pdf-text-layer');
 if(!layer?.contains(range.startContainer)||!layer.contains(range.endContainer))return previous;
 const quote=selection.toString().trim().slice(0,20000);if(!quote)return previous;
 const bounds=box.getBoundingClientRect(),rects=[],textRange=document.createRange();
 const walker=document.createTreeWalker(range.commonAncestorContainer,NodeFilter.SHOW_TEXT);
 let node=walker.currentNode.nodeType===Node.TEXT_NODE?walker.currentNode:walker.nextNode();
 // A multi-line range also returns whole span boxes. Use text fragments to avoid doubling the bands.
 for(;node&&rects.length<500;node=walker.nextNode()){
  if(!range.intersectsNode(node)||!node.data.trim())continue;
  textRange.setStart(node,node===range.startContainer?range.startOffset:0);
  textRange.setEnd(node,node===range.endContainer?range.endOffset:node.length);
  for(const r of textRange.getClientRects()){
   const x=Math.max(bounds.left,r.left),y=Math.max(bounds.top,r.top),right=Math.min(bounds.right,r.right),bottom=Math.min(bounds.bottom,r.bottom);
   if(right-x>.25&&bottom-y>.25)rects.push([(x-bounds.left)/bounds.width,(y-bounds.top)/bounds.height,(right-x)/bounds.width,(bottom-y)/bounds.height]);
   if(rects.length===500)break;
  }
 }
 session.picked={page:session.page,quote,rects};return session.picked;
}
function matchingPdfTextMarks(session,kind,picked){
 if(!picked?.rects.length)return [];
 const normalize=text=>text.replace(/\s+/g,' ').trim(),quote=normalize(picked.quote);
 const overlaps=([x,y,w,h],[a,b,c,d])=>{
  const area=Math.max(0,Math.min(x+w,a+c)-Math.max(x,a))*Math.max(0,Math.min(y+h,b+d)-Math.max(y,b));
  return area>0&&area>=.5*Math.min(w*h,c*d);
 };
 return session.annotations.filter(mark=>mark.kind===kind&&mark.page===picked.page&&normalize(mark.quote)===quote&&mark.rects.some(a=>picked.rects.some(b=>overlaps(a,b))));
}
function syncPdfTextMarkButtons(session){
 document.querySelectorAll('.pdf-tools [data-pdf-mark][aria-pressed]').forEach(button=>{
  const marked=matchingPdfTextMarks(session,button.dataset.pdfMark,session.picked).length>0;
  button.setAttribute('aria-pressed',String(marked));
  button.title=(marked?'取消':'添加')+button.textContent;
 });
}
function addPdfMark(session,kind,options={}){
 const picked=capturePdfSelection(session),requires=['highlight','underline','strike','comment','translation'].includes(kind);if(requires&&!picked?.quote&&!options.quote){toast('请先在 PDF 正文中选择文字。');return}
 if(TOGGLE_PDF_MARKS.includes(kind)){
  if(!picked.rects.length){toast('请在 PDF 正文中重新选择文字。');return}
  const existing=new Set(matchingPdfTextMarks(session,kind,picked));
  if(existing.size){
   session.annotations=session.annotations.filter(mark=>!existing.has(mark));
   savePdfMarks(session);renderPdfSidebar(session);renderPdfMarks(session);return;
  }
 }
 if(session.annotations.length>=5000){toast('当前文档批注已达到上限，请先导出整理。');return}
 const a={id:crypto.randomUUID(),kind,page:requires?(picked?.page??session.page):session.page,quote:requires?(picked?.quote??''):'',note:options.note??$('pdfComment').value,color:session.markColor||MARK_COLORS[0],rects:requires?(picked?.rects??[]):[],points:[],createdAt:new Date().toISOString(),...options};
 a.quote=String(a.quote).slice(0,20000);a.note=String(a.note).slice(0,30000);session.annotations.push(a);savePdfMarks(session);renderPdfSidebar(session);renderPdfMarks(session);return a;
}
function renderPdfMarks(session,box=session.pageBox,pageNumber=session.page){
 if(!box?.querySelector('canvas'))return;
 box.querySelectorAll('.pdf-marks,.pdf-highlights,.pdf-draw-pad').forEach(layer=>layer.remove());
 const overlay=document.createElement('div'),highlights=document.createElement('div'),textBoxes=document.createElement('div');
 textBoxes.className='pdf-marks pdf-text-box-layer';
 overlay.className='pdf-marks';highlights.className='pdf-highlights';highlights.setAttribute('aria-hidden','true');
 for(const a of session.annotations.filter(a=>a.page===pageNumber)){
  for(const r of a.rects){const el=document.createElement('span');el.className='pdf-mark mark-'+a.kind;el.style.cssText='left:'+r[0]*100+'%;top:'+r[1]*100+'%;width:'+r[2]*100+'%;height:'+r[3]*100+'%;--mark-color:'+a.color;
   if(a.kind==='text')installPdfTextBox(session,box,a,el);(a.kind==='highlight'?highlights:a.kind==='text'?textBoxes:overlay).append(el)}
  if(a.points.length){const ink=createPdfInk(a.color);ink.svg.dataset.inkId=a.id;ink.update(a.points);overlay.append(ink.svg)}
 }box.querySelector('canvas').after(highlights);box.append(overlay,textBoxes);
 syncPdfTextMarkButtons(session);
 const pad=document.createElement('div');pad.className='pdf-draw-pad';box.append(pad);
 pad.onpointerdown=event=>startPdfDrawing(event,session,pad,pageNumber);
}
function redrawPdfAnnotationPage(session,page){
 const box=$('pdfScroll')?.querySelector('[data-pdf-page="'+page+'"]');
 if(box)renderPdfMarks(session,box,page);
}
function installPdfTextBox(session,box,mark,element){
 const style=pdfTextStyle(mark),handle=document.createElement('span');
 element.textContent=mark.note;handle.className='pdf-text-resize';handle.setAttribute('aria-hidden','true');
 element.dataset.textMark=mark.id;element.style.fontFamily=PDF_TEXT_FONTS[style.fontFamily];
 element.style.fontSize=style.fontSize*(box.pdfScale||1)+'px';
 element.title='拖动移动，拖右下角缩放，双击编辑';
 element.append(handle);
 element.ondblclick=()=>session.editTextMark?.(mark);
 element.onpointerdown=event=>{
  if(session.drawMode!=='select'||event.button!==0||!event.isPrimary)return;
  const resize=event.target===handle,bounds=box.getBoundingClientRect(),[x,y,w,h]=mark.rects[0];
  const controller=new AbortController(),{signal}=controller;
  let rect=mark.rects[0],moved=false;
  const draw=([left,top,width,height])=>Object.assign(element.style,{left:left*100+'%',top:top*100+'%',width:width*100+'%',height:height*100+'%'});
  event.preventDefault();event.stopPropagation();element.setPointerCapture(event.pointerId);
  const move=e=>{
   const dx=e.clientX-event.clientX,dy=e.clientY-event.clientY;
   if(!moved&&Math.hypot(dx,dy)<3)return;
   moved=true;
   rect=resize?[x,y,Math.min(1-x,Math.max(Math.min(w,24/bounds.width),w+dx/bounds.width)),Math.min(1-y,Math.max(Math.min(h,20/bounds.height),h+dy/bounds.height))]
    :[Math.max(0,Math.min(1-w,x+dx/bounds.width)),Math.max(0,Math.min(1-h,y+dy/bounds.height)),w,h];
   draw(rect);
  };
  const cancel=()=>{controller.abort();draw(mark.rects[0])};
  element.addEventListener('pointermove',move,{signal});
  element.addEventListener('pointercancel',cancel,{signal});
  element.addEventListener('lostpointercapture',cancel,{signal});
  element.addEventListener('pointerup',e=>{
   move(e);controller.abort();
   if(moved&&readingSession===session){mark.rects=[rect];savePdfMarks(session)}
  },{signal});
 };
}
function createPdfInk(color){
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('viewBox','0 0 1000 1000');svg.setAttribute('preserveAspectRatio','none');svg.classList.add('pdf-ink');
 const line=document.createElementNS(svg.namespaceURI,'polyline');
 line.setAttribute('stroke',color);line.setAttribute('fill','none');line.setAttribute('stroke-width','3');
 line.setAttribute('stroke-linecap','round');line.setAttribute('stroke-linejoin','round');line.setAttribute('vector-effect','non-scaling-stroke');
 svg.append(line);
 return {svg,update(points){line.setAttribute('points',points.map(([x,y])=>x*1000+','+y*1000).join(' '))}};
}
function hitsPdfInk(point,points,{width,height}){
 const [x,y]=point;
 return points.some(([bx,by],i)=>{
  const [ax,ay]=points[Math.max(0,i-1)],dx=(bx-ax)*width,dy=(by-ay)*height;
  const px=(x-ax)*width,py=(y-ay)*height;
  const t=Math.max(0,Math.min(1,(px*dx+py*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(px-t*dx,py-t*dy)<=10;
 });
}
function setPdfDrawMode(session,mode){
 session.drawMode=mode;
 const toggle=$('pdfMarkToolsToggle'),drawTool=document.querySelector('[data-pdf-draw="'+mode+'"]');
 if(toggle)toggle.textContent=(mode==='select'?'标注':drawTool?.textContent||'标注')+' ▾';
 $('pdfScroll').dataset.drawMode=mode;
 document.querySelectorAll('[data-pdf-draw]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.pdfDraw===mode)));
 $('pdfOcrMode')?.setAttribute('aria-pressed',String(mode==='ocr'));
}
function installPdfAnnotationTools(session, tools) {
 const menu = tools.querySelector('#pdfMarkTools');
 const toggle = tools.querySelector('#pdfMarkToolsToggle');
 const keepSelection = event => {
  capturePdfSelection(session);
  event.preventDefault();
 };
 toggle.onmousedown = keepSelection;
 installPdfToolbarPopover(menu,toggle,session.controller.signal);
 menu.addEventListener('click', event => {
  if (event.target.closest('[data-pdf-mark],[data-pdf-draw]')) menu.hidePopover();
 });

 const swatches = PDF_MARK_PALETTE.map(([color, label]) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pdf-color-swatch';
  button.dataset.pdfColor = color;
  button.style.setProperty('--pdf-swatch', color);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(session.markColor === color));
  button.onmousedown = keepSelection;
  button.onclick = () => {
   session.markColor = color;
   for (const swatch of swatches) swatch.setAttribute('aria-pressed', String(swatch === button));
  };
  return button;
 });
 menu.querySelector('.pdf-mark-colors').replaceChildren(...swatches);

 for (const button of menu.querySelectorAll('[data-pdf-mark]')) {
  button.onmousedown = keepSelection;
  button.onclick = () => {
   setPdfDrawMode(session, 'select');
   const mark = addPdfMark(session, button.dataset.pdfMark);
   if (mark?.kind === 'comment') void session.editTextMark(mark);
  };
 }
 const drawHints = {
  erase: '点击或拖过笔迹可整笔擦除。',
  pen: '可连续手绘，点击「选择文字」退出。'
 };
 for (const button of menu.querySelectorAll('[data-pdf-draw]')) {
  button.onclick = () => {
   const mode = button.dataset.pdfDraw;
   setPdfDrawMode(session, mode);
   if (mode !== 'select') $('markSaveStatus').textContent = drawHints[mode] ?? '在页面上拖动或点击添加标记。';
  };
 }
 setPdfDrawMode(session, 'select');
 tools.querySelector('#pdfOcrMode').onclick = () => {
  const active = session.drawMode === 'ocr';
  setPdfDrawMode(session, active ? 'select' : 'ocr');
  if (!active) {
   getSelection()?.removeAllRanges();
   session.picked = null;
   $('pdfTranslationStatus').textContent = '在 PDF 页面上拖出文字区域，即可离线识别。识别后可翻译和批注。';
  }
 };
 const chart=document.createElement('button');chart.type='button';chart.textContent='框选图表存笔记';
 tools.querySelector('#pdfOcrMode').after(chart);
 const research=document.createElement('button');research.type='button';research.textContent='文献检索';chart.after(research);
 research.onclick=()=>openPdfResearchDialog(session.file.id);
 chart.onclick=()=>{
  setPdfDrawMode(session,session.drawMode==='excerpt'?'select':'excerpt');
  $('markSaveStatus').textContent=session.drawMode==='excerpt'?'拖动框选图表，松开后选择保存或追加。':'已退出框选。';
 };
 bindPdfAnnotationExports(session);
}
function startPdfDrawing(event,session,pad,pageNumber){
 if(event.button!==0||!event.isPrimary||pad.hasPointerCapture(event.pointerId))return;
 const mode=session.drawMode,bounds=pad.getBoundingClientRect(),color=session.markColor||MARK_COLORS[0];
 const point=e=>[Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width)),Math.max(0,Math.min(1,(e.clientY-bounds.top)/bounds.height))];
 const start=point(event),points=[start],erased=new Map(),controller=new AbortController(),{signal}=controller;
 const box=pad.parentElement,ink=mode==='pen'?createPdfInk(color):null;
 const preview=ink?.svg||(['rect','text','ocr','excerpt'].includes(mode)?document.createElement('div'):null);
 if(preview&&!ink)preview.className='draw-preview';
 if(preview)pad.append(preview);
 const erase=at=>{
  for(const mark of session.annotations){
   if(mark.kind!=='pen'||mark.page!==pageNumber||erased.has(mark.id)||!hitsPdfInk(at,mark.points,bounds))continue;
   const stroke=box.querySelector('[data-ink-id="'+mark.id+'"]');
   if(stroke){stroke.style.visibility='hidden';erased.set(mark.id,stroke)}
  }
 };
 const rectangle=end=>[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1])];
 const update=e=>{
  for(const sample of e.getCoalescedEvents?.().length?e.getCoalescedEvents():[e]){
   const at=point(sample);
   if(mode==='erase')erase(at);
   if(ink&&points.length<3000&&(at[0]!==points.at(-1)[0]||at[1]!==points.at(-1)[1]))points.push(at);
  }
  ink?.update(points);
  if(preview&&!ink){const [x,y,w,h]=rectangle(point(e));preview.style.cssText='left:'+x*100+'%;top:'+y*100+'%;width:'+w*100+'%;height:'+h*100+'%;border-color:'+color}
 };
 event.preventDefault();session.activatePage?.(pageNumber);pad.setPointerCapture(event.pointerId);update(event);
 const cleanup=()=>{controller.abort();preview?.remove();for(const stroke of erased.values())stroke.style.visibility=''};
 pad.addEventListener('pointermove',update,{signal});
 pad.addEventListener('pointercancel',cleanup,{signal});
 pad.addEventListener('lostpointercapture',cleanup,{signal});
 pad.addEventListener('pointerup',e=>{
  update(e);cleanup();
  if(readingSession!==session||session.drawMode!==mode)return;
  session.activatePage?.(pageNumber);
  if(mode==='pen'&&points.length>1)addPdfMark(session,'pen',{points,page:pageNumber,color,note:''});
  if(mode==='erase'&&erased.size){
   session.annotations=session.annotations.filter(mark=>!erased.has(mark.id));
   savePdfMarks(session);renderPdfSidebar(session);renderPdfMarks(session,box,pageNumber);
  }
  if(mode==='excerpt'){
   setPdfDrawMode(session,'select');
   const rect=rectangle(point(e));
   void capturePdfChart(session,box,rect,pageNumber).then(picked=>{
    if(!picked||readingSession!==session)return;
    showPdfExcerptMenu(session,picked,e.clientX,e.clientY);
   }).catch(error=>toast(error.message));
  }
  if(mode==='ocr'){
   const rect=rectangle(point(e));
   if(rect[2]>.008&&rect[3]>.008)recognizePdfRegion(session,box,rect,pageNumber);
  }
  if(mode==='text'||mode==='rect'){
   setPdfDrawMode(session,'select');
   const rect=rectangle(point(e));
   if(mode==='text'){
    const x=Math.min(.95,start[0]),y=Math.min(.97,start[1]);
    const position=rect[2]>.012&&rect[3]>.012?rect:[x,y,Math.min(.25,1-x),Math.min(.1,1-y)];
    const mark=addPdfMark(session,'text',{rects:[position],note:$('pdfComment').value||'文字批注'});
    if(mark)session.editTextMark?.(mark);
   }
   else if(rect[2]>.003&&rect[3]>.003)addPdfMark(session,'rect',{rects:[rect],note:''});
  }
 },{signal});
}
function renderPdfSidebar(session){
 const list=$('pdfAnnotationList');
 if(!list||readingSession!==session)return;
 const expanded=(session.expandedAnnotationIds??=new Set());
 const tab=$('showPdfAnnotations');
 if(tab)tab.textContent=session.annotations.length?'批注 '+session.annotations.length:'批注';
 const search=$('pdfAnnotationSearch'),type=$('pdfAnnotationType'),order=$('pdfAnnotationOrder'),currentPageBtn=$('pdfAnnotationCurrentPage');
 if(!search.dataset.bound){
  for(const [kind,label] of Object.entries(PDF_ANNOTATION_LABELS))type.add(new Option(label,kind));
  const update=()=>renderPdfSidebar(session);
  search.addEventListener('input',update);
  type.addEventListener('change',update);
  order.addEventListener('change',update);
  if(currentPageBtn){
   currentPageBtn.onclick=()=>{
    const next=currentPageBtn.getAttribute('aria-pressed')!=='true';
    currentPageBtn.setAttribute('aria-pressed',String(next));
    update();
   };
   document.addEventListener('pdf-page-change',event=>{
    if(event.detail?.session===session&&currentPageBtn.getAttribute('aria-pressed')==='true')update();
   },{signal:session.controller.signal});
  }
  search.dataset.bound='true';
 }
 const onlyCurrentPage=currentPageBtn?.getAttribute('aria-pressed')==='true';
 const query=search.value.trim().toLocaleLowerCase();
 const filtered=[...session.annotations].reverse().filter(mark=>{
  if(onlyCurrentPage&&mark.page!==session.page)return false;
  if(type.value&&mark.kind!==type.value)return false;
  if(!query)return true;
  return [mark.quote,mark.note,PDF_ANNOTATION_LABELS[mark.kind],String(mark.page)]
   .some(value=>value.toLocaleLowerCase().includes(query));
 });
 if(order.value==='page')filtered.sort((a,b)=>a.page-b.page);
 const count=$('pdfAnnotationCount');
 if(count)count.textContent=filtered.length===session.annotations.length?session.annotations.length+' 条':filtered.length+' / '+session.annotations.length+' 条';
 list.replaceChildren();
 for(const a of filtered){
  const card=document.createElement('div');
  card.className='pdf-note';card.dataset.annotationId=a.id;
  card.style.setProperty('--pdf-note-color',a.color||MARK_COLORS[0]);
  const top=document.createElement('div');top.className='pdf-note-top';
  const swatch=document.createElement('button');swatch.type='button';swatch.className='pdf-note-swatch';
  const colorName=PDF_MARK_PALETTE.find(([color])=>color===a.color)?.[1]||'当前颜色';
  swatch.title='切换批注颜色（当前：'+colorName+'）';swatch.setAttribute('aria-label',swatch.title);
  swatch.onclick=()=>{
   const idx=MARK_COLORS.indexOf(a.color);
   a.color=MARK_COLORS[(idx+1)%MARK_COLORS.length];
   savePdfMarks(session);redrawPdfAnnotationPage(session,a.page);renderPdfSidebar(session);
  };
  const head=document.createElement('button');head.type='button';head.className='pdf-note-link';
  head.textContent=PDF_ANNOTATION_LABELS[a.kind]+' · 第 '+a.page+' 页';
  head.onclick=async()=>{
   await session.showPage(a.page);
   if(a.rects?.length&&typeof flashPdfRects==='function')flashPdfRects(a.page,a.rects);
  };
  if(a.kind==='highlight'){
   card.classList.add('pdf-note-highlight');
   if(colorName)head.setAttribute('aria-label',colorName+'高亮 · 第 '+a.page+' 页');
  }
  const tools=document.createElement('div');tools.className='pdf-note-tools';
  const makeTool=(label,title,run,danger=false)=>{
   const btn=document.createElement('button');btn.type='button';
   btn.className='pdf-note-tool'+(danger?' is-danger':'');btn.textContent=label;btn.title=title;btn.onclick=run;return btn;
  };
  if(a.quote){
   tools.append(
    makeTool('译','在翻译面板打开这段摘录',()=>session.translateMark?.(a)),
    makeTool('存笔记','将这条批注与出处保存为研究笔记',async()=>{
     try{await savePdfExcerpt(session,{page:a.page,rects:a.rects,quote:[a.quote,a.note].filter(Boolean).join('\n\n')})}
     catch(e){toast(e.message)}
    })
   );
  }
  tools.append(makeTool('删除','删除这条批注',()=>{
   expanded.delete(a.id);
   session.annotations=session.annotations.filter(n=>n.id!==a.id);
   savePdfMarks(session);redrawPdfAnnotationPage(session,a.page);renderPdfSidebar(session);
  },true));
  top.append(swatch,head,tools);card.append(top);
  if(a.quote){const q=document.createElement('blockquote');q.textContent=a.quote;card.append(q);}
  const showEditor=Boolean(a.note)||expanded.has(a.id)||['comment','bookmark','text'].includes(a.kind);
  if(showEditor){
   const body=document.createElement('textarea');
   body.value=a.note;body.rows=2;body.placeholder='记录思考、推导批注或待核对问题…';body.setAttribute('aria-label','编辑批注');
   let saveTimer=0;
   const commit=()=>{
    clearTimeout(saveTimer);saveTimer=0;
    const nextNote=body.value.slice(0,30000);
    if(a.note===nextNote)return;
    a.note=nextNote;savePdfMarks(session);redrawPdfAnnotationPage(session,a.page);
   };
   body.oninput=()=>{clearTimeout(saveTimer);saveTimer=setTimeout(commit,450)};
   body.onchange=commit;
   card.append(body);
  }else{
   const addNote=document.createElement('button');addNote.type='button';addNote.className='pdf-note-add-body';
   addNote.textContent='+ 添加批注思考…';
   addNote.onclick=()=>{
    expanded.add(a.id);renderPdfSidebar(session);
    list.querySelector('[data-annotation-id="'+a.id+'"] textarea')?.focus();
   };
   card.append(addNote);
  }
  if(a.kind==='text'){
   const settings=document.createElement('div');settings.className='pdf-text-settings';
   const font=document.createElement('select'),size=document.createElement('input'),style=pdfTextStyle(a);
   font.setAttribute('aria-label','文字框字体');
   for(const [value,label] of Object.entries({system:'无衬线',serif:'衬线',mono:'等宽'}))font.add(new Option(label,value));
   font.value=style.fontFamily;size.type='number';size.min='8';size.max='72';size.value=style.fontSize;size.setAttribute('aria-label','文字框字号');
   font.onchange=size.onchange=()=>{
    const next=pdfTextStyle({fontFamily:font.value,fontSize:size.valueAsNumber});Object.assign(a,next);size.value=next.fontSize;
    savePdfMarks(session);redrawPdfAnnotationPage(session,a.page);
   };
   settings.append('字体 ',font,' 字号 ',size);card.append(settings);
  }
  list.append(card);
 }
 if(!list.children.length){
  const empty=document.createElement('p');empty.className='pdf-empty-state';
  empty.textContent=onlyCurrentPage&&session.annotations.length
   ?'当前第 '+session.page+' 页暂无批注，取消右上角「仅当前页」可查看全文 '+session.annotations.length+' 条批注。'
   :session.annotations.length?'没有匹配的批注。':'在 PDF 正文中选中文字，可添加六色高亮、划线或记录推导思考。';
  list.append(empty);
 }
 const bookmarks=$('pdfBookmarkList');if(bookmarks){bookmarks.replaceChildren();for(const a of session.annotations.filter(a=>a.kind==='bookmark')){const button=document.createElement('button');button.textContent=a.note||'第 '+a.page+' 页';button.onclick=()=>session.showPage(a.page);bookmarks.append(button)}if(!bookmarks.children.length)bookmarks.textContent='暂无书签。'}
}
