'use strict';
/**
 * [INPUT]: 读取 pdf-reflow-layout.js 分栏与排版函数、MinerU 结构服务、BilingualBook 翻译桥与阅读工具栏。
 * [OUTPUT]: 提供 installPdfReflow，维护智能排版与双语对照视图、向上/向下懒加载及跳页器。
 * [POS]: PDF 智能排版交互与双语流式翻译控制器，与整页对照视图协同切换。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
function installPdfReflow(session,originalBar,tools,layout){
 const bar=document.createElement('div'),view=document.createElement('section');
 bar.className='pdf-reflow-controls';view.className='pdf-reflow-view';view.hidden=true;
 bar.innerHTML=`<button type="button" class="pdf-view-menu-toggle" id="pdfViewMenuToggle" popovertarget="pdfViewMenu" aria-label="阅读模式" title="阅读模式">阅读模式 <span aria-hidden="true">⌄</span></button>
  <div id="pdfViewMenu" class="pdf-view-menu" popover aria-label="阅读模式">
   <button type="button" id="pdfPageCompare"><strong>整页对照翻译</strong><small>PDFMathTranslate · 保留版面</small></button>
   <button type="button" id="pdfReflowSmart" aria-pressed="false"><strong>智能排版</strong><small>MinerU · 重排段落、图表和公式</small></button>
   <button type="button" id="pdfReflowTranslate" aria-pressed="false"><strong>排版翻译</strong><small>逐段对照原文与译文</small></button>
  </div>
  <button type="button" id="pdfReflowOriginal" class="secondary" hidden>返回 PDF</button>
  <div id="pdfReflowPager" class="pdf-toolbar-group" role="group" aria-label="排版翻页" hidden>
   <button type="button" class="secondary" id="pdfReflowPrev" aria-label="排版上一页">‹</button>
   <input id="pdfReflowPageInput" type="number" min="1" step="1" aria-label="排版页码"><span id="pdfReflowTotal"></span>
   <button type="button" class="secondary" id="pdfReflowNext" aria-label="排版下一页">›</button>
  </div>
  <select id="pdfReflowZoom" aria-label="智能排版缩放" hidden></select>
  <div id="pdfBilingualControls" class="pdf-bilingual-controls" hidden>
   <select id="pdfBilingualView" aria-label="排版翻译显示方式"><option value="both">双语对照</option><option value="source">仅原文</option><option value="target">仅译文</option></select>
   <select id="pdfBilingualEngine" aria-label="排版翻译服务" hidden><option value="configured">使用设置的服务</option><option value="offline">快速离线（英译中）</option></select>
  </div>
  <button type="button" id="pdfReaderMoreToggle" popovertarget="pdfReaderMore" aria-label="更多阅读操作" title="更多阅读操作">⋯</button>
  <div id="pdfReaderMore" class="pdf-view-menu" popover aria-label="更多阅读操作">
   <button type="button" id="exportBilingualHtml" hidden>导出双语 HTML</button>
  </div>`;
 view.innerHTML=`<div class="pdf-reflow-statusbar"><span id="pdfReflowStatus" role="status"></span><button type="button" class="secondary" id="pdfReflowRetry" hidden>重试</button></div>
  <div class="pdf-reflow-scroll" tabindex="0" aria-label="排版文档"><div class="pdf-reflow-document"></div></div>`;
 tools.after(bar);layout.after(view);
 const menu=bar.querySelector('#pdfViewMenu'),menuToggle=bar.querySelector('#pdfViewMenuToggle');
 const more=bar.querySelector('#pdfReaderMore'),moreToggle=bar.querySelector('#pdfReaderMoreToggle');
 more.append(originalBar.querySelector('#markReadingDone'));
 for(const [popup,toggle] of [[menu,menuToggle],[more,moreToggle]]){
  installPdfToolbarPopover(popup,toggle,session.controller.signal);
  popup.addEventListener('click',event=>{if(event.target.closest('button'))popup.hidePopover()});
 }

 const smart=bar.querySelector('#pdfReflowSmart'),translate=bar.querySelector('#pdfReflowTranslate');
 const original=bar.querySelector('#pdfReflowOriginal'),status=view.querySelector('#pdfReflowStatus');
 const reflowPager=bar.querySelector('#pdfReflowPager'),reflowPrev=bar.querySelector('#pdfReflowPrev');
 const reflowNext=bar.querySelector('#pdfReflowNext'),reflowPageInput=bar.querySelector('#pdfReflowPageInput');
 reflowPageInput.max=String(session.pdf.numPages);
 bar.querySelector('#pdfReflowTotal').textContent='/ '+session.pdf.numPages+' 页';
 const retry=view.querySelector('#pdfReflowRetry'),scroller=view.querySelector('.pdf-reflow-scroll');
 const documentPane=view.querySelector('.pdf-reflow-document');
 const zoom=bar.querySelector('#pdfReflowZoom');
 addPdfZoomOptions(zoom,[50,67,75,90,100,110,125,150,175,200]);
 const zoomKey='pdf-reflow-zoom/'+session.profileId;
 try{
  const saved=localStorage.getItem(zoomKey);
  if([...zoom.options].some(option=>option.value===saved))zoom.value=saved;
 }catch{}
 documentPane.style.zoom=Number(zoom.value)||1;
 function applyZoom(){
  const anchor=documentPane.querySelector('[data-reflow-page="'+visiblePage()+'"]');
  const top=scroller.getBoundingClientRect().top;
  const offset=anchor&&anchor.getBoundingClientRect();
  const fraction=offset?Math.max(0,(top-offset.top)/Math.max(1,offset.height)):0;
  documentPane.style.zoom=Number(zoom.value)||1;
  if(anchor&&run){
   const bounds=anchor.getBoundingClientRect();
   scroller.scrollTop+=bounds.top-top+fraction*bounds.height;
  }
  try{localStorage.setItem(zoomKey,zoom.value)}catch{}
 }
 zoom.onchange=applyZoom;
 const bilingualControls=bar.querySelector('#pdfBilingualControls'),bilingualView=bar.querySelector('#pdfBilingualView');
 const bilingualEngine=bar.querySelector('#pdfBilingualEngine');
 const exportBilingual=bar.querySelector('#exportBilingualHtml');
 const pageLayouts=new Map(),mineruPageImages=new Map(),imageUrls=new Set(),translatedText=new Map();
 const sessionSignal=session.controller.signal,sourceBlob=session.sourceBlob;
 const fingerprint=pdfPreviewFingerprint(session);
 let run=null,mineruPromise=null,nativeTranslationQueue=Promise.resolve();
 function showMineruProgress(pageNumber,text){
  if(run&&!run.translating&&visiblePage()===pageNumber)setStatus('第 '+pageNumber+' 页 · '+text);
 }
 try{
  const preferred=localStorage.getItem('donote.bilingual.view');
  if(['both','source','target'].includes(preferred))bilingualView.value=preferred;
  if(localStorage.getItem('donote.bilingual.engine')==='offline')bilingualEngine.value='offline';
 }catch{}
 function applyBilingualView(){
  view.dataset.bilingualView=bilingualView.value;
  try{localStorage.setItem('donote.bilingual.view',bilingualView.value)}catch{}
 }
 bilingualView.onchange=applyBilingualView;
 applyBilingualView();

 function updateButtons(){
  menuToggle.setAttribute('aria-pressed',String(!!run));
  smart.setAttribute('aria-pressed',String(!!run&&!run.bilingual));
  translate.setAttribute('aria-pressed',String(!!run?.bilingual));
  bilingualControls.hidden=exportBilingual.hidden=!run?.bilingual;
  bilingualEngine.hidden=!run?.bilingual||!window.BilingualBook?.available||run.source!=='en'||run.target!=='zh';
  original.hidden=!run;
  reflowPager.hidden=!run;
  zoom.hidden=!run;
  view.dataset.bilingual=String(!!run?.bilingual);
 }

 function visiblePage(offset=42){
  const threshold=scroller.getBoundingClientRect().top+offset;
  const sections=documentPane.children;
  if(!sections.length)return run?.firstPage||session.page;
  let first=0,last=sections.length-1;
  while(first<last){
   const middle=Math.ceil((first+last)/2);
   if(sections[middle].getBoundingClientRect().top<=threshold)first=middle;
   else last=middle-1;
  }
  return Number(sections[first].dataset.reflowPage);
 }

 const translatableBlock=translatableReflowBlock;
 const fillMarkdown=fillReflowMarkdown;
 const renderImagePage=(pageNumber,signal)=>renderReflowImagePage(session.pdf,pageNumber,signal);
 const croppedPdfImage=(pageNumber,bbox,getCanvas,signal)=>croppedReflowPdfImage(pageNumber,bbox,getCanvas,signal,mineruPageImages,imageUrls);
 async function basicPageLayout(pageNumber){
  sessionSignal.throwIfAborted();
  const page=await session.pdf.getPage(pageNumber),text=await page.getTextContent();
  const viewport=page.getViewport({scale:1});
  return buildReflowLayout(text.items,viewport.width,viewport.height).blocks;
 }

 const hasMinerU=window.MinerUReflow?.available&&sourceBlob instanceof Blob;
 function loadPageLayout(pageNumber,getBasic=()=>basicPageLayout(pageNumber)){
  if(pageLayouts.has(pageNumber))return pageLayouts.get(pageNumber);
  const task=(async()=>{
   let warning='';
   if(hasMinerU){
    try{
     mineruPromise??=window.MinerUReflow.create(sourceBlob,{
      signal:sessionSignal,onProgress:text=>showMineruProgress(pageNumber,text)
     })
      .catch(error=>{mineruPromise=null;throw error});
     const mineru=await mineruPromise;
     if(!mineru.pageBlocks(pageNumber))await mineru.parseWindow(pageNumber,pageNumber,'flash',text=>showMineruProgress(pageNumber,text));
     const blocks=mineru.pageBlocks(pageNumber);
     if(blocks&&(blocks.length||mineru.pageIsBlank(pageNumber)))return {blocks,warning,engine:'MinerU'};
     warning='MinerU 未提取到结构，已使用基础重排。';
    }catch(error){
     if(sessionSignal.aborted)throw error;
     warning='MinerU 排版暂不可用，已使用基础重排。';
    }
   }
   return {blocks:await getBasic(),warning,engine:'PDF 文本层'};
  })();
  pageLayouts.set(pageNumber,task);
  task.then(result=>{if(result.warning)pageLayouts.delete(pageNumber)},()=>pageLayouts.delete(pageNumber));
  return task;
 }

 async function buildPage(pageNumber,blocks,state,{provisional=false}={}){
  const section=document.createElement('article'),entries=[],figures=[];
  const viewport=blocks.some(block=>block.type==='image')
   ? (await session.pdf.getPage(pageNumber)).getViewport({scale:1})
   : null;
  section.dataset.reflowPage=pageNumber;
  const pageLabel=document.createElement('p');
  pageLabel.className='pdf-reflow-page-label';pageLabel.textContent='第 '+pageNumber+' / '+session.pdf.numPages+' 页';
  section.append(pageLabel);
  if(!blocks.length){
   const hint=document.createElement('p');
   hint.textContent=provisional?'此页没有可预览的文字，正在等待 MinerU。':'此页没有可提取的文字。可返回 PDF 查看。';
   section.append(hint);
  }
  for(const [index,block] of blocks.entries()){
   state.signal.throwIfAborted();
   let figure,frame;
   const bbox=block.type==='image'&&block.bbox;
   if(Array.isArray(bbox)&&bbox.length===4&&bbox.every(value=>Number.isFinite(value)&&value>=0&&value<=1)){
    const [x0,y0,x1,y1]=bbox;
    const width=(x1-x0)*viewport.width,height=(y1-y0)*viewport.height;
    if(width>0&&height>0){
     figure=document.createElement('figure');figure.className='pdf-reflow-image-block';
     frame=document.createElement('div');frame.className='pdf-reflow-figure-frame';
     frame.style.width='min(100%, '+Math.round(width*1.25)+'px, '+(66*width/height).toFixed(3)+'vh)';
     frame.style.aspectRatio=String(width/height);
     frame.textContent='正在加载图表…';
     figure.append(frame);
     figures.push({frame,bbox});
     section.append(figure);
    }
   }
   if(!block.text.trim())continue;
   const row=document.createElement(figure?'figcaption':'div');
   row.className='pdf-reflow-pair';
   const linkId='a'+pageNumber+'-'+index;
   const isHeading=block.type==='heading';
   const headingLevel=Math.min(6,Math.max(2,Number(block.level)||3));
   const source=document.createElement(isHeading?'h'+headingLevel:'div');
   source.className='pdf-reflow-source pdf-reflow-block-'+block.type;
   if(isHeading)source.dataset.headingLevel=String(block.level||3);
   source.dataset.a=linkId;source.lang=state.source;
   fillMarkdown(source,block.text,block);
   row.append(source);
   if(state.bilingual&&!provisional&&translatableBlock(block)){
    row.dataset.translatable='true';
    const target=document.createElement('div');
    target.className='pdf-reflow-translation';target.dataset.a=linkId;target.lang=state.target;
    target.textContent='等待翻译…';
    row.append(target);
    entries.push({block,target,index});
   }
   if(figure){
    if(block.captionAbove)figure.prepend(row);
    else figure.append(row);
   }else section.append(row);
  }
  return {section,entries,blocks,pageNumber,figures};
 }

 async function loadFigures(page,signal){
  let canvas;
  const getCanvas=()=>canvas??=renderImagePage(page.pageNumber,sessionSignal);
  for(const {frame,bbox} of page.figures){
   signal.throwIfAborted();
   try{
    const url=await croppedPdfImage(page.pageNumber,bbox,getCanvas,sessionSignal);
    signal.throwIfAborted();
    const image=document.createElement('img');
    image.src=url;image.alt='第 '+page.pageNumber+' 页图表';
    frame.replaceChildren(image);
   }catch(error){
    signal.throwIfAborted();
    frame.textContent='图片暂无法显示，可返回 PDF 查看。';
   }
  }
 }

 function translationKey(state,pageNumber,{block}){
  return JSON.stringify([fingerprint,state.provider,state.modelKey,state.glossarySig||'',state.source,state.target,block.type,block.text]);
 }

 async function translatePage(page,state,singleBatch=false){
  const {entries,pageNumber,blocks}=page;
  const {source,target,provider,preference,signal}=state;
  const key=entry=>translationKey(state,pageNumber,entry);
  const display=(entry,text,save=false)=>{
   if(!entry||signal.aborted||entry.target.dataset.ready==='true')return;
   const clean=wellFormedText(text).trim();
   if(!clean)return;
   translatedText.set(key(entry),clean);
   if(translatedText.size>1024)translatedText.delete(translatedText.keys().next().value);
   fillMarkdown(entry.target,clean,entry.block,true);
   entry.target.dataset.ready='true';
   if(save)void PdfPreviewCache.put('paragraph',key(entry),clean);
  };
  await Promise.all(entries.map(async entry=>{
   const cached=translatedText.get(key(entry))||await PdfPreviewCache.get('paragraph',key(entry));
   if(cached){display(entry,cached);return}
   const legacyKey=JSON.stringify([fingerprint,state.provider,state.modelKey,state.source,state.target,
    pageNumber,entry.index,entry.block.text]);
   display(entry,await PdfPreviewCache.get('paragraph',legacyKey),true);
  }));
  signal.throwIfAborted();
  let missing=entries.filter(entry=>entry.target.dataset.ready!=='true');
  if(!missing.length)return '';
  if(singleBatch){
   const viewport=scroller.getBoundingClientRect();
   const distance=entry=>{
    const bounds=entry.target.parentElement.getBoundingClientRect();
    return bounds.bottom<viewport.top?viewport.top-bounds.bottom:
     bounds.top>viewport.bottom?bounds.top-viewport.bottom:0;
   };
   missing.sort((left,right)=>distance(left)-distance(right));
   let chars=0;
   const limit=32,charLimit=9000;
   missing=missing.filter((entry,index)=>{
    chars+=entry.block.text.length;
    return index<limit&&(index===0||chars<=charLimit);
   });
  }
  let failed='';
  if((provider==='localai'||provider==='offline'||provider==='openai'||provider==='baidu'||provider==='azure')&&window.BilingualBook?.available){
   try{
    const task=nativeTranslationQueue.then(()=>{
     signal.throwIfAborted();
     for(const entry of missing)display(entry,translatedText.get(key(entry)));
     const waiting=missing.filter(entry=>entry.target.dataset.ready!=='true');
     if(!waiting.length)return;
     const byIndex=new Map(waiting.map(entry=>[String(entry.index),entry]));
     const onPair=pair=>{
      const matched=byIndex.get(String(pair?.id));
      if(!matched)return;
      let saved=false;
      for(const entry of missing)if(key(entry)===key(matched)){
       display(entry,pair?.translation,!saved);
       saved=true;
      }
     };
     const unique=new Map(waiting.map(entry=>[key(entry),entry]));
     const requested=[...unique.values()].map(({block,index})=>({id:String(index),text:wellFormedText(block.text),type:block.type==='image'?'caption':block.type,level:block.level||3}));
     return window.BilingualBook.pair(requested,{translate:true,source,target,preference,glossary:state.glossary,signal,onPair})
      .then(response=>{for(const pair of response.pairs||[])onPair(pair)});
    });
    nativeTranslationQueue=task.catch(()=>{});
    await task;
    signal.throwIfAborted();
   }catch(error){
    if(signal.aborted)throw error;
    failed=error.message||'本地翻译失败。';
   }
  }else{
   const context=wellFormedText(blocks.map(item=>item.text).join('\n').slice(0,10000));
   for(const entry of missing){
    try{
     if(translatedText.has(key(entry))){display(entry,translatedText.get(key(entry)));continue}
     const text=await translatePdfOnline(entry.block.text,source,target,signal,()=>{},context);
     display(entry,text,true);
    }catch(error){
     if(signal.aborted)throw error;
     failed=error.message||'翻译服务暂不可用。';
     break;
    }
   }
  }
  for(const entry of missing){
   if(entry.target.dataset.ready==='true')continue;
   entry.target.textContent='译文暂不可用。';
   failed||='部分段落未返回有效译文。';
  }
  return failed;
 }

 function setStatus(text){
  status.textContent=text;
  retry.hidden=!run?.failures.has(visiblePage());
 }

 async function leave(page=visiblePage()){
  if(!run)return;
  run.abort();run=null;view.hidden=true;documentPane.replaceChildren();
  layout.hidden=false;tools.hidden=false;originalBar.hidden=false;
  updateButtons();
  if(readingSession===session)await session.showPage(page,page===session.page?session.scroll:0);
 }

 function updateStatus(){
  if(!run)return;
  const number=visiblePage(),page=run.pages.get(number);
  const detail=run.failures.get(number)||
   (page?.translating?'正在翻译…':page?.message)||
   (documentPane.childElementCount&&hasMinerU?'文本预览，MinerU 正在解析…':'正在读取文本…');
  setStatus('第 '+number+' / '+session.pdf.numPages+' 页 · '+detail);
 }

 async function translateNext(state){
  if(state.translating||state.signal.aborted)return;
  const number=visiblePage(),last=visiblePage(scroller.clientHeight)+1;
  let next;
  for(let current=number;current<=last;current++){
   const candidate=state.pages.get(current);
   if(candidate?.entries.length&&!candidate.finished&&!state.failures.has(current)){
    next=candidate;
    break;
   }
  }
  if(!next)return;
  state.translating=next;
  next.translating=true;
  const rTaskId='reflow:doc:'+(session.file?.id||fingerprint);
  window.DoNoteTasks?.upsert?.(rTaskId,{kind:'translate',fileId:session.file?.id||null,profileId:session.profileId||null,page:next.pageNumber,openWhileRunning:true,title:(session.file?.name?session.file.name+' · 排版翻译':'PDF 排版翻译'),detail:'正在并发翻译第 '+next.pageNumber+' 页（共 '+next.entries.length+' 段）…',percent:null,state:'running'});
  updateStatus();
  try{
   const error=await translatePage(next,state,true);
   if(error){
    state.failures.set(next.pageNumber,'翻译未完成。'+error);
    window.DoNoteTasks?.upsert?.(rTaskId,{kind:'translate',fileId:session.file?.id||null,profileId:session.profileId||null,page:next.pageNumber,title:(session.file?.name?session.file.name+' · 排版翻译':'PDF 排版翻译'),detail:'第 '+next.pageNumber+' 页：'+error,percent:null,state:'error'});
   }else{
    next.finished=next.entries.every(entry=>entry.target.dataset.ready==='true');
    const completed=next.entries.filter(entry=>entry.target.dataset.ready==='true').length;
    next.message=next.finished?'翻译完成':'已翻译 '+completed+' / '+next.entries.length+' 段';
    window.DoNoteTasks?.upsert?.(rTaskId,{kind:'translate',fileId:session.file?.id||null,profileId:session.profileId||null,page:next.pageNumber,title:(session.file?.name?session.file.name+' · 排版翻译':'PDF 排版翻译'),detail:'已完成第 '+next.pageNumber+' 页排版翻译',percent:100,state:'done'});
   }
  }catch(error){
   if(!state.signal.aborted)state.failures.set(next.pageNumber,error.message||'翻译失败。');
   else window.DoNoteTasks?.remove?.(rTaskId);
  }finally{
   state.translating=null;
   next.translating=false;
   if(!state.signal.aborted)refresh();
  }
 }

 async function finishLayout(state,pageNumber,placeholder,getBasic){
  try{
   const {blocks,warning,engine}=await loadPageLayout(pageNumber,getBasic);
   state.signal.throwIfAborted();
   const page=await buildPage(pageNumber,blocks,state);
   state.signal.throwIfAborted();
   page.message=warning||engine+'排版完成';
   state.pages.set(pageNumber,page);
   const aboveViewport=placeholder.getBoundingClientRect().bottom<=scroller.getBoundingClientRect().top+8;
   const beforeHeight=aboveViewport?scroller.scrollHeight:0;
   placeholder.replaceWith(page.section);
   if(aboveViewport)scroller.scrollTop+=scroller.scrollHeight-beforeHeight;
   if(page.figures.length)requestAnimationFrame(()=>void loadFigures(page,state.signal).catch(()=>{}));
  }catch(error){
   if(!state.signal.aborted){
    state.failures.set(pageNumber,'读取失败。'+(error.message||''));
    placeholder.textContent='此页无法读取，可重试或继续向下阅读。';
    state.layouts.set(pageNumber,{placeholder,getBasic:()=>basicPageLayout(pageNumber)});
   }
  }finally{
   state.parsing=false;
   if(!state.signal.aborted)refresh();
  }
 }

 async function mountReflowPlaceholder(state,pageNumber,prepend=false){
  const cached=pageLayouts.get(pageNumber);
  let placeholder,basic;
  const getBasic=()=>basic??=basicPageLayout(pageNumber);
  if(hasMinerU&&!cached){
   const blocks=await getBasic().catch(()=>[]);
   state.signal.throwIfAborted();
   placeholder=(await buildPage(pageNumber,blocks,state,{provisional:true})).section;
   state.signal.throwIfAborted();
  }else{
   placeholder=document.createElement('article');
   placeholder.dataset.reflowPage=pageNumber;
  }
  if(prepend){
   const beforeHeight=scroller.scrollHeight;
   documentPane.prepend(placeholder);
   scroller.scrollTop+=scroller.scrollHeight-beforeHeight;
  }else{
   documentPane.append(placeholder);
  }
  state.layouts.set(pageNumber,{placeholder,getBasic});
  return placeholder;
 }

 async function appendPage(state){
  if(state.appending||state.next>session.pdf.numPages)return;
  state.appending=true;
  const pageNumber=state.next++;
  try{
   await mountReflowPlaceholder(state,pageNumber,false);
  }finally{
   state.appending=false;
   if(!state.signal.aborted)requestAnimationFrame(refresh);
  }
 }

 async function prependPage(state){
  if(state.prepending||state.prev<1)return null;
  state.prepending=true;
  const pageNumber=state.prev--;
  try{
   return await mountReflowPlaceholder(state,pageNumber,true);
  }finally{
   state.prepending=false;
   if(!state.signal.aborted)requestAnimationFrame(refresh);
  }
 }

 let frame=0;
 function refresh(){
  const state=run;
  if(!state||state.signal.aborted)return;
  const current=visiblePage();
  if(document.activeElement!==reflowPageInput)reflowPageInput.value=String(current);
  reflowPrev.disabled=current<=1;
  reflowNext.disabled=current>=session.pdf.numPages;
  updateStatus();
  const first=Math.max(1,current-1),last=visiblePage(scroller.clientHeight)+1;
  if(!state.parsing){
   for(let number=current;number<=last;number++){
    const job=state.layouts.get(number);
    if(!job||state.failures.has(number))continue;
    state.layouts.delete(number);
    state.parsing=true;
    void finishLayout(state,number,job.placeholder,job.getBasic);
    break;
   }
   if(!state.parsing&&first<current){
    const prevJob=state.layouts.get(first);
    if(prevJob&&!state.failures.has(first)){
     state.layouts.delete(first);
     state.parsing=true;
     void finishLayout(state,first,prevJob.placeholder,prevJob.getBasic);
    }
   }
  }
  if(!documentPane.childElementCount || scroller.scrollTop+scroller.clientHeight*2>=scroller.scrollHeight){
   void appendPage(state).catch(()=>{});
  }else if(scroller.scrollTop<=260 && state.prev>=1){
   void prependPage(state).catch(()=>{});
  }
  void translateNext(state);
 }

 async function jumpReflowPage(targetPage){
  const state=run;
  if(!state||state.signal.aborted)return;
  const clamped=Math.min(session.pdf.numPages,Math.max(1,Math.round(Number(targetPage))||visiblePage()));
  reflowPageInput.value=String(clamped);
  const existing=documentPane.querySelector('[data-reflow-page="'+clamped+'"]');
  if(existing){
   scroller.scrollTop=existing.offsetTop;
   refresh();
   return;
  }
  if(clamped===state.prev&&!state.prepending){
   const node=await prependPage(state).catch(()=>null);
   if(node&&state===run)scroller.scrollTop=node.offsetTop;
   refresh();
   return;
  }
  start(state.bilingual,true,clamped);
 }
 reflowPrev.onclick=()=>{if(run)void jumpReflowPage(visiblePage()-1)};
 reflowNext.onclick=()=>{if(run)void jumpReflowPage(visiblePage()+1)};
 reflowPageInput.onchange=()=>{if(run)void jumpReflowPage(reflowPageInput.value)};
 reflowPageInput.onkeydown=event=>{if(event.key==='Enter')reflowPageInput.blur()};

 retry.onclick=()=>{
  const state=run,number=visiblePage();
  if(!state?.failures.has(number))return;
  state.failures.delete(number);
  refresh();
 };

 function start(bilingual,restart=false,explicitPage=null){
  if(!restart&&run?.bilingual===bilingual){void leave();return}
  const page=explicitPage||visiblePage(),{source,target}=storedTranslateLanguage();
  run?.abort();
  const controller=new AbortController();
  const offline=bilingual&&bilingualEngine.value==='offline'&&window.BilingualBook?.available&&source==='en'&&target==='zh';
  const configuredProvider=offline?'offline':window.desktopTranslation?.provider()||'mymemory';
  const isDedicatedApi=configuredProvider==='baidu'||configuredProvider==='azure';
  const preference=offline?'offline':(configuredProvider==='openai'?'openai':isDedicatedApi?configuredProvider:window.desktopTranslation?.localModelPreference?.()||'large');
  const glossary=bilingual&&typeof circuitGlossary==='function'?circuitGlossary(session.profileId):null;
  const glossarySig=bilingual&&typeof circuitGlossarySignature==='function'?circuitGlossarySignature(session.profileId):'';
  run={bilingual,source,target,firstPage:page,prev:page-1,next:page,
   provider:configuredProvider,glossary,glossarySig,
   preference,modelKey:offline?'offline-ct2-v2':window.desktopTranslation?.modelCacheKey?.(preference)||preference,
   signal:controller.signal,abort:()=>controller.abort(),pages:new Map(),failures:new Map(),layouts:new Map()};
  layout.hidden=true;tools.hidden=true;originalBar.hidden=true;
  documentPane.replaceChildren();view.hidden=false;scroller.scrollTop=0;
  updateButtons();
  refresh();
 }
 bilingualEngine.onchange=()=>{
  try{localStorage.setItem('donote.bilingual.engine',bilingualEngine.value)}catch{}
  start(true,true);
 };
 window.addEventListener('donote-translation-settings-change',()=>{if(run?.bilingual){bilingualEngine.value='configured';start(true,true)}},{signal:sessionSignal});
 window.addEventListener('donote-glossary-change',()=>{if(run?.bilingual)start(true,true)},{signal:sessionSignal});

 async function exportBilingualDocument(){
  const state=run;
  if(!state?.bilingual)return;
  const startPage=visiblePage(),endPage=Math.min(session.pdf.numPages,startPage+3);
  exportBilingual.disabled=true;
  try{
   const sections=[];
   for(let pageNumber=startPage;pageNumber<=endPage;pageNumber++){
    const {blocks}=await loadPageLayout(pageNumber);
    const page=await buildPage(pageNumber,blocks,state);
    await loadFigures(page,state.signal);
    const error=await translatePage(page,state);
    if(error)throw new Error('第 '+pageNumber+' 页翻译未完成。'+error);
    for(const image of page.section.querySelectorAll('img[src^="blob:"]')){
     const response=await fetch(image.src,{signal:state.signal});
     image.src=await new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
      response.blob().then(blob=>reader.readAsDataURL(blob)).catch(reject);
     });
    }
    sections.push(page.section.outerHTML);
   }
   state.signal.throwIfAborted();
   const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(session.file.name)+' · 双语对照</title><style>'
    +'body{max-width:1100px;margin:32px auto;padding:0 20px;color:#20252a;font:16px/1.75 system-ui,"Microsoft YaHei",sans-serif}article+article{border-top:1px solid #ddd}.pdf-reflow-page-label{color:#59636c}.pdf-reflow-pair{margin:0 0 1.1em;overflow-wrap:anywhere}.pdf-reflow-pair[data-translatable=true]{display:grid;grid-template-columns:1fr 1fr;gap:20px}.pdf-reflow-translation{border-inline-start:1px solid #ddd;padding-inline-start:16px}.pdf-reflow-pair :is(p,h2,h3,h4,ol){margin:0}.pdf-reflow-source{min-width:0}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:5px}figure{margin:1em 0}figcaption{margin:.55em 0}.pdf-reflow-figure-frame{display:grid;place-items:center;margin:auto}.pdf-reflow-figure-frame img{display:block;width:100%;height:100%;object-fit:contain}@media(max-width:650px){.pdf-reflow-pair[data-translatable=true]{display:block}}'
    +'</style><body>'+sections.join('')+'</body></html>';
   downloadBlob(session.file.name.replace(/\.[^.]+$/,'')+'-bilingual-'+startPage+'-'+endPage+'.html',new Blob([html],{type:'text/html;charset=utf-8'}));
   if(!state.signal.aborted)toast('已导出第 '+startPage+'–'+endPage+' 页双语 HTML。');
  }finally{exportBilingual.disabled=false}
 }

 exportBilingual.onclick=()=>exportBilingualDocument().catch(error=>{if(error.name!=='AbortError')toast(error.message)});
 smart.onclick=()=>start(false);
 translate.onclick=()=>start(true);
 original.onclick=()=>leave();
 scroller.onscroll=()=>{
  if(frame)return;
  frame=requestAnimationFrame(()=>{
   frame=0;
   refresh();
   scheduleReadingSave(session);
  });
 };
 session.reflowPosition=()=>run?{page:visiblePage(),scroll:0}:null;
 sessionSignal.addEventListener('abort',()=>{
  run?.abort();
  for(const url of imageUrls)URL.revokeObjectURL(url);
 },{once:true});
 if(typeof installPdfPageComparison==='function'){
  installPdfPageComparison(session,{button:bar.querySelector('#pdfPageCompare'),layout,originalBar,tools,bar,leaveReflow:leave});
 }else bar.querySelector('#pdfPageCompare').hidden=true;
}