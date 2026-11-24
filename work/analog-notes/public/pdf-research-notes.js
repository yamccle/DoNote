/**
 * [INPUT]: 依赖阅读会话 readingSession、记录库 records/put/validate 与 openAttachment。
 * [OUTPUT]: 提供 PDF 摘录的出处校验、保存、追加、摘录菜单、选区高亮 flashPdfRects 与详情「引用资料」。
 * [POS]: 「阅读 → 摘录 → 记录」链的写入端。pdf-backlinks.js 读取这里写入的出处，从 PDF 一侧列出引用。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const PDF_EXCERPT_QUOTE_LIMIT=2000;

function validPdfNoteSource(source){
 return source===undefined||(
  source && /^[a-zA-Z0-9-]{1,80}$/.test(source.recordId) &&
  /^[a-zA-Z0-9-]{1,80}$/.test(source.fileId) &&
  Number.isInteger(source.page) && source.page>0 && source.page<=100000 &&
  typeof source.recordId==='string'&&typeof source.fileId==='string'&&typeof source.fileName==='string' && source.fileName.length<=500 &&
  (source.quote===undefined||typeof source.quote==='string'&&source.quote.length<=PDF_EXCERPT_QUOTE_LIMIT) &&
  validPdfCoordinates(source.rects,4,500)
 );
}

// 出处只保留原文片段，正文仍由笔记自身保存。空片段不写字段，旧版本读取时保持兼容。
function pdfExcerptQuote(picked){
 const quote=String(picked?.quote||'').trim().slice(0,PDF_EXCERPT_QUOTE_LIMIT);
 return quote?{quote}:{};
}

// 阅读器打开时，详情弹窗若已在底层打开需重入顶层，避免被阅读器遮挡。
function showDetailFromReader(id){
 if($('reader').open&&$('detail').open)$('detail').close();
 showDetail(id);
}

async function openPdfEvidence(file,page,rects=[]){
 if($('reader').open&&readingSession?.file.id===file.id){
  if($('detail').open)$('detail').close();
  await readingSession.showPage(page);
  flashPdfRects(page,rects);
  return;
 }
 if($('reader').open){
  const closed=new Promise(resolve=>$('reader').addEventListener('close',resolve,{once:true}));
  $('reader').close();await closed;
 }
 await openAttachment(file);
 if(readingSession?.file.id!==file.id)return;
 await readingSession.showPage(page);
 flashPdfRects(page,rects);
}

function flashPdfRects(page,rects=[]){
 const box=$('pdfScroll')?.querySelector('[data-pdf-page="'+page+'"]');
 if(!box||!rects.length)return;
 box.querySelector('.pdf-note-source-focus')?.remove();
 const layer=document.createElement('div');layer.className='pdf-note-source-focus';
 layer.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:5';
 for(const [x,y,w,h] of rects){
  const mark=document.createElement('span');
  mark.style.cssText='position:absolute;border:2px solid #087c79;background:#48c0ab30;left:'+x*100+'%;top:'+y*100+'%;width:'+w*100+'%;height:'+h*100+'%';
  layer.append(mark);
 }
 box.append(layer);
 layer.firstElementChild?.scrollIntoView({block:'center',inline:'nearest'});
 setTimeout(()=>layer.remove(),6000);
}

async function savePdfExcerpt(session,picked){
 const owner=records.find(note=>note.attachments?.some(file=>file.id===session.file.id));
 if(!owner)throw new Error('请先把 PDF 保存到当前工作台。');
 if(!picked?.quote&&!picked?.image)throw new Error('请先选中文字或框选图表。');
 const profileId=session.profileId;
 const note={
  id:crypto.randomUUID(),type:'paper',title:(owner.title+' · 第 '+picked.page+' 页摘录').slice(0,240),
  body:['出处：'+owner.title+' · '+session.file.name+' · 第 '+picked.page+' 页',picked.quote].filter(Boolean).join('\n\n'),
  tags:['PDF 摘录'],date:today(),status:statusOptions.paper[0],pinned:false,
  relatedResources:owner.type==='resource'?[owner.id]:[],
  pdfSource:{recordId:owner.id,fileId:session.file.id,fileName:session.file.name,page:picked.page,rects:picked.rects??[],...pdfExcerptQuote(picked)},
  attachments:[]
 };
 const writes=[];
 if(picked.image){
  const id=crypto.randomUUID();
  note.attachments.push({id,name:'第 '+picked.page+' 页图表.png',mime:'image/png',size:picked.image.size,addedAt:new Date().toISOString()});
  writes.push({key:fileKey(profileId,id),blob:picked.image});
  note.bodyHtml='<p>'+esc(note.body)+'</p><span class="inline-media" data-image-id="'+id+'" data-width="85" data-align="center"></span>';
 }
 if(profileId!==appState.activeId)throw new Error('工作台已切换。');
 await put(note,writes);
 const notice=()=>showDetailFromReader(note.id);
 toast('摘录已保存为研究笔记',{label:'打开笔记',run:notice});
}

 async function savePdfChartRegion(session,box,[x,y,w,h],page){
 const picked=await capturePdfChart(session,box,[x,y,w,h],page);
 if(!picked||readingSession!==session)return;
 await savePdfExcerpt(session,picked);
}

async function capturePdfChart(session,box,[x,y,w,h],page){
 const source=box.querySelector('canvas');
 if(!source||w<.008||h<.008)return null;
 const width=source.width*w,height=source.height*h,scale=Math.min(1,2200/Math.max(width,height));
 const crop=document.createElement('canvas');
 crop.width=Math.max(1,Math.round(width*scale));crop.height=Math.max(1,Math.round(height*scale));
 crop.getContext('2d').drawImage(source,source.width*x,source.height*y,width,height,0,0,crop.width,crop.height);
 const image=await new Promise(resolve=>crop.toBlob(resolve,'image/png'));
 if(!image)throw new Error('无法截取图表。');
 return {page,rects:[[x,y,w,h]],image};
}

function pdfExcerptTarget(note){
 if(!note)return false;
 if(note.type==='issue')return true;
 if(!['journal','study'].includes(note.type))return false;
 return /仿真/.test([note.title,...(note.tags||[]),note.body].filter(Boolean).join('\n'));
}

function pdfExcerptTargets(){
 return records.filter(pdfExcerptTarget).slice(0,100);
}

function pdfExcerptSource(session,picked){
 const owner=records.find(note=>note.attachments?.some(file=>file.id===session.file.id));
 if(!owner)throw new Error('请先把 PDF 保存到当前工作台。');
 if(!picked?.quote&&!picked?.image&&!picked?.rects?.length)throw new Error('请先选中文字或框选图表。');
 const source={recordId:owner.id,fileId:session.file.id,fileName:session.file.name,page:picked.page,rects:picked.rects??[],...pdfExcerptQuote(picked)};
 if(!validPdfNoteSource(source))throw new Error('无法定位这段摘录。');
 return source;
}

function askPdfExcerptTarget(){
 const targets=pdfExcerptTargets();
 if(!targets.length)throw new Error('没有可追加的设计问题或仿真记录。');
 const reader=$('reader'),panel=document.createElement('div');
 panel.className='pdf-selection-menu';panel.setAttribute('role','group');panel.setAttribute('aria-label','追加到已有记录');
 const select=document.createElement('select');
 select.setAttribute('aria-label','选择设计问题或仿真记录');
 select.add(new Option('选择设计问题或仿真记录…',''));
 for(const item of targets)select.add(new Option(item.title,item.id));
 const go=document.createElement('button'),cancel=document.createElement('button');
 go.type=cancel.type='button';go.textContent='追加';cancel.textContent='取消';
 panel.append(select,go,cancel);reader.append(panel);
 panel.hidden=false;panel.style.left='16px';panel.style.top='64px';
 select.focus();
 return new Promise(resolve=>{
  const finish=value=>{panel.remove();resolve(value)};
  cancel.onclick=()=>finish(null);
  go.onclick=()=>{if(select.value)finish(select.value)};
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();finish(null)}});
 });
}

async function appendPdfExcerpt(session,picked,targetId){
 const source=pdfExcerptSource(session,picked);
 const profileId=session.profileId??appState.activeId;
 const latest=records.find(item=>item.id===targetId);
 if(!latest||!pdfExcerptTarget(latest))throw new Error('请选择设计问题或仿真记录。');
 const evidence=[...(latest.pdfEvidence||[])];
 if(evidence.length>=240)throw new Error('这条记录的引用已达上限。');
 const same=evidence.some(item=>item.fileId===source.fileId&&item.page===source.page&&JSON.stringify(item.rects)===JSON.stringify(source.rects));
 const next={...latest,pdfEvidence:same?evidence:[...evidence,source]};
 const writes=[];
 if(picked.image&&!same){
  const id=crypto.randomUUID();
  next.attachments=[...(latest.attachments||[]),{id,name:'第 '+picked.page+' 页图表.png',mime:'image/png',size:picked.image.size,addedAt:new Date().toISOString()}];
  const html=typeof latest.bodyHtml==='string'?latest.bodyHtml:esc(latest.body||'').replace(/\n/g,'<br>');
  next.bodyHtml=html+'<span class="inline-media" data-image-id="'+id+'" data-width="85" data-align="center"></span>';
  writes.push({key:fileKey(profileId,id),blob:picked.image});
  validateInlineReferences(next);
 }
 if(profileId!==appState.activeId)throw new Error('工作台已切换。');
 if(!validate(next))throw new Error('无法追加到这条记录。');
 await put(next,writes);
 toast('已追加到「'+latest.title+'」',{label:'打开记录',run:()=>showDetailFromReader(targetId)});
}

function showPdfExcerptMenu(session,picked,clientX,clientY){
 const reader=$('reader'),menu=document.createElement('div'),dismiss=new AbortController(),{signal}=dismiss;
 const close=()=>{dismiss.abort();menu.remove()};
 session.controller?.signal.addEventListener('abort',close,{once:true});
 menu.className='pdf-selection-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','图表摘录');
 const actions=[
  ['保存为研究笔记',()=>savePdfExcerpt(session,picked)],
  ['追加到已有记录',async()=>{const id=await askPdfExcerptTarget();if(id)await appendPdfExcerpt(session,picked,id)}]
 ];
 for(const [label,run] of actions){
  const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=label;
  button.onclick=async()=>{close();try{await run()}catch(error){toast(error.message)}};
  menu.append(button);
 }
 reader.append(menu);menu.hidden=false;
 menu.style.left=Math.max(8,Math.min(clientX||16,innerWidth-menu.offsetWidth-8))+'px';
 menu.style.top=Math.max(8,Math.min(clientY||64,innerHeight-menu.offsetHeight-8))+'px';
 reader.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))close()},{signal});
 reader.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close()}},{signal});
 menu.firstElementChild.focus();
}

function renderPdfSourceLinks(note){
 const body=$('detailContent');
 const sources=[note.pdfSource,...(note.pdfEvidence||[])].filter(item=>item&&validPdfNoteSource(item));
 if(sources.length){
  const heading=document.createElement('h3');
  heading.textContent='引用资料';
  body.append(heading);
 }
 for(const source of sources){
  const button=document.createElement('button');
  button.type='button';button.className='secondary';
  button.textContent='打开 '+source.fileName+' · 第 '+source.page+' 页';
  button.onclick=async()=>{
   const file=records.find(record=>record.id===source.recordId)?.attachments?.find(item=>item.id===source.fileId);
   if(!file){toast('原 PDF 已移除：'+source.fileName);return;}
   try{await openPdfEvidence(file,source.page,source.rects);}catch(error){toast(error.message);}
  };
  body.append(button);
  if(source!==note.pdfSource&&source.quote){
   const quote=document.createElement('blockquote');
   quote.className='pdf-evidence-quote';
   quote.textContent=source.quote;
   body.append(quote);
  }
 }
 if(!sources.length&&note.researchLinks===undefined)return;
 const select=document.createElement('select'),label=document.createElement('label');
 label.textContent='关联设计问题或仿真记录 ';
 select.add(new Option('选择记录…',''));
 const linked=new Set(note.researchLinks||[]);
 for(const item of records.filter(item=>['issue','study','journal'].includes(item.type)&&item.id!==note.id&&!linked.has(item.id))){
  select.add(new Option(item.title,item.id));
 }
 label.append(select);body.append(label);
 for(const id of linked){
  const target=records.find(item=>item.id===id);
  if(!target)continue;
  const jump=document.createElement('button'),remove=document.createElement('button');
  jump.type=remove.type='button';jump.textContent=target.title;remove.textContent='取消关联';
  jump.onclick=()=>showDetail(id);remove.onclick=()=>save([...linked].filter(value=>value!==id));
  body.append(jump,remove);
 }
 const save=async links=>{
  const latest=records.find(item=>item.id===note.id);
  if(!latest)return;
  try{await put({...latest,researchLinks:links});showDetail(note.id);}
  catch(error){toast(error.message);}
 };
 select.onchange=()=>{if(select.value)void save([...linked,select.value]);};
}
