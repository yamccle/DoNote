/**
 * [INPUT]: 读取 records 的 pdfSource 与 pdfEvidence；依赖 validPdfNoteSource、flashPdfRects、recordTypeName、showDetailFromReader。
 * [OUTPUT]: 提供 pdfBacklinksFor(fileId) 与 installPdfBacklinks(session, side)。
 * [POS]: PDF 阅读器的反向引用层。pdf-research-notes.js 从选区写入出处，本文件从 PDF 一侧列出引用它的记录。
 *        页面挂载后由 pdf-viewer.js 派发 pdf-page-rendered，记录提交后由 notebook-v2.js 派发 workspace-records-changed。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

// ---------------------------------------------------------------- 引用索引
// 一条记录可在同一页留下多处选区。按页分组后，页面角标统计记录数，侧栏逐条列出选区。
function pdfBacklinksFor(fileId){
 const links=[];
 for(const note of records){
  for(const source of [note.pdfSource,...(note.pdfEvidence||[])]){
   if(source?.fileId!==fileId||!validPdfNoteSource(source))continue;
   links.push({note,page:source.page,rects:source.rects||[],quote:source.quote||''});
  }
 }
 return links.sort((a,b)=>a.page-b.page||a.note.title.localeCompare(b.note.title,'zh'));
}

function groupPdfBacklinks(links){
 const pages=new Map();
 for(const link of links){
  if(!pages.has(link.page))pages.set(link.page,[]);
  pages.get(link.page).push(link);
 }
 return pages;
}

const pdfBacklinkNoteCount=entries=>new Set(entries.map(entry=>entry.note.id)).size;

// ---------------------------------------------------------------- 页面角标
function renderPdfBacklinkBadge(session,slot,page){
 slot.querySelector('.pdf-backlink-badge')?.remove();
 const entries=session.backlinks?.pages.get(page);
 if(!entries?.length)return;
 const count=pdfBacklinkNoteCount(entries);
 const badge=document.createElement('button');
 badge.type='button';badge.className='pdf-backlink-badge';
 badge.textContent='被引用 '+count;
 badge.title='本页被 '+count+' 条记录引用，点击查看';
 badge.setAttribute('aria-label',badge.title);
 badge.onpointerdown=event=>event.stopPropagation();
 badge.onclick=event=>{event.stopPropagation();void session.showPdfBacklinks(page)};
 slot.append(badge);
}

// ---------------------------------------------------------------- 侧栏列表
function renderPdfBacklinkPanel(session,zone,focusPage){
 const list=zone.querySelector('#pdfBacklinkList'),count=zone.querySelector('#pdfBacklinkCount');
 const {links,pages}=session.backlinks;
 const notes=pdfBacklinkNoteCount(links);
 count.textContent=links.length?notes+' 条记录 · '+pages.size+' 页':'';
 list.replaceChildren();
 if(!links.length){
  const empty=document.createElement('p');empty.className='pdf-panel-help';
  empty.textContent='还没有记录引用这份资料。选中文字或框选图表后，可保存为研究笔记或追加到问题课题与实验/调研记录。';
  list.append(empty);return;
 }
 for(const [page,entries] of pages){
  const group=document.createElement('section');
  group.className='pdf-backlink-group';group.dataset.backlinkPage=page;
  if(page===focusPage)group.classList.add('is-focused');
  const head=document.createElement('button');
  head.type='button';head.className='pdf-note-link';
  head.textContent='第 '+page+' 页 · '+pdfBacklinkNoteCount(entries)+' 条记录';
  head.onclick=()=>session.showPage(page);
  group.append(head);
  for(const entry of entries){
   const card=document.createElement('div');card.className='pdf-backlink-entry';
   const kind=document.createElement('span');kind.className='pdf-backlink-kind';
   kind.textContent=recordTypeName(entry.note.type)||'记录';
   const open=document.createElement('button');
   open.type='button';open.className='pdf-backlink-title';open.textContent=entry.note.title;
   open.title='打开记录';
   open.onclick=()=>showDetailFromReader(entry.note.id);
   card.append(kind,open);
   if(entry.quote){
    const quote=document.createElement('blockquote');quote.textContent=entry.quote;card.append(quote);
   }
   if(entry.rects.length){
    const locate=document.createElement('button');
    locate.type='button';locate.className='secondary';locate.textContent='定位选区';
    locate.onclick=async()=>{if(await session.showPage(page))flashPdfRects(page,entry.rects)};
    card.append(locate);
   }
   group.append(card);
  }
  list.append(group);
 }
}

// ---------------------------------------------------------------- 安装
function installPdfBacklinks(session,side){
 const zone=side.querySelector('#pdfBacklinksZone'),tab=side.querySelector('#showPdfBacklinks');
 if(!zone||!tab)return;
 const {signal}=session.controller;
 let focusPage=0;
 function refresh(){
  if(readingSession!==session)return;
  const links=pdfBacklinksFor(session.file.id);
  session.backlinks={links,pages:groupPdfBacklinks(links)};
  const notes=pdfBacklinkNoteCount(links);
  tab.textContent=notes?'引用 '+notes:'引用';
  renderPdfBacklinkPanel(session,zone,focusPage);
  for(const slot of $('pdfScroll')?.querySelectorAll('.pdf-page')||[]){
   if(slot.querySelector('canvas'))renderPdfBacklinkBadge(session,slot,Number(slot.dataset.pdfPage));
  }
 }
 session.showPdfBacklinks=async page=>{
  focusPage=page||0;
  await session.showPdfPanel('backlinks');
  if(signal.aborted)return;
  renderPdfBacklinkPanel(session,zone,focusPage);
  zone.querySelector('[data-backlink-page="'+focusPage+'"]')?.scrollIntoView({block:'start'});
 };
 document.addEventListener('pdf-page-rendered',event=>{
  const {session:owner,slot,page}=event.detail||{};
  if(owner===session)renderPdfBacklinkBadge(session,slot,page);
 },{signal});
 document.addEventListener('workspace-records-changed',refresh,{signal});
 refresh();
}
