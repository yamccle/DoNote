/**
 * [INPUT]: 读取已打开的 PDF / PPT 附件列表与资料库。新增标签时按需读取所选文档。
 * [OUTPUT]: 提供 registerReaderTab、activateReaderTab、closeReaderTab 与多标签选择器。
 * [POS]: 阅读器顶部多开文档标签栏，支持在论文 PDF 与讲义 PPT 之间原地快速切换。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
// 多开文档：阅读器顶部的标签栏，允许同时保留多份文献并快速切换。
const readerTabs=[];
let activeReaderTab=null;
const readerTabNav=$('readerTabs');
const readerTabList=readerTabNav.querySelector('.reader-tab-scroll');
readerTabNav.addEventListener('click',event=>{
  const closeButton=event.target.closest('[data-reader-tab-close]');
  if(closeButton){event.stopPropagation();closeReaderTab(closeButton.dataset.readerTabClose);return}
  if(event.target.closest('#readerTabAdd')){openReaderTabPicker();return}
  const tab=event.target.closest('[data-reader-tab]');
  if(tab)activateReaderTab(tab.dataset.readerTab);
});
function renderReaderTabStrip(){
 readerTabNav.hidden=readerTabs.length===0;
 readerTabList.innerHTML=readerTabs.map(tab=>'<span class="reader-tab'+(tab.id===activeReaderTab?' active':'')+'" data-reader-tab="'+esc(tab.id)+'" role="tab" tabindex="0" aria-selected="'+(tab.id===activeReaderTab)+'" title="'+esc(tab.name)+'"><span class="reader-tab-name">'+esc(tab.name)+'</span><span class="reader-tab-close" data-reader-tab-close="'+esc(tab.id)+'" role="button" aria-label="关闭 '+esc(tab.name)+'" title="关闭">×</span></span>').join('');
}
function registerReaderTab(file,blob){
 if(!file||!file.id)return;
 const existing=readerTabs.find(tab=>tab.id===file.id);
 if(existing){existing.blob=blob||existing.blob;activeReaderTab=existing.id}
 else{readerTabs.push({id:file.id,name:file.name,file,blob,page:1});activeReaderTab=file.id}
 renderReaderTabStrip();
}
async function openReaderTab(tab){
 if(!tab)return;
 if(typeof fileIsPresentation==='function'&&fileIsPresentation(tab.file))await openPresentationAttachment(tab.file,tab.blob);
 else await openReadableAttachment(tab.file,tab.blob);
}
function activateReaderTab(id){
 const tab=readerTabs.find(item=>item.id===id);
 if(!tab)return;
 if(tab.id===activeReaderTab&&readingSession){renderReaderTabStrip();return}
 openReaderTab(tab);
}
async function closeReaderTab(id){
 const index=readerTabs.findIndex(tab=>tab.id===id);
 if(index<0)return;
 const wasActive=readerTabs[index].id===activeReaderTab;
 readerTabs.splice(index,1);
 if(!readerTabs.length){
  activeReaderTab=null;renderReaderTabStrip();
  // 关闭最后一个标签页等同于关闭这次阅读，避免留下没有标签的阅读窗口。
  if($('reader').open)$('reader').close();
  return;
 }
 if(wasActive){
  const next=readerTabs[Math.min(index,readerTabs.length-1)];
  activeReaderTab=next.id;
  await openReaderTab(next);
 }else renderReaderTabStrip();
}
function openReaderTabPicker(){
 let dialog=$('readerTabPicker');
 if(!dialog){
  dialog=document.createElement('dialog');dialog.id='readerTabPicker';dialog.setAttribute('aria-label','再打开一份文档');
  dialog.innerHTML='<div class="modalhead"><h2>再打开一份文档</h2><button type="button" class="icon-button" data-close="readerTabPicker" aria-label="关闭">✕</button></div><div class="modalbody"><label class="searchbox" style="margin-bottom:10px"><i data-icon="search"></i><input id="readerTabSearch" placeholder="搜索标题或文件名…" aria-label="搜索文档"></label><div id="readerTabList" class="reader-tab-list"></div></div>';
  document.body.append(dialog);
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  $('readerTabSearch').oninput=()=>renderReaderTabPicker();
 }
 $('readerTabSearch').value='';
 renderReaderTabPicker();
 dialog.showModal();$('readerTabSearch').focus();
}
function renderReaderTabPicker(){
 const q=($('readerTabSearch').value||'').trim().toLowerCase(),host=$('readerTabList'),rows=[];
 for(const note of records)for(const file of note.attachments||[]){
  if((!fileIsPdf(file)&&!(typeof fileIsPresentation==='function'&&fileIsPresentation(file)))||requiresExternalReader(file))continue;
  if(q&&!(note.title+' '+file.name).toLowerCase().includes(q))continue;
  rows.push({note,file});
 }
 host.innerHTML=rows.length?rows.slice(0,100).map(({note,file})=>'<button type="button" class="reader-tab-row" data-tab-open="'+esc(file.id)+'"><span>'+esc(note.title)+'</span><small>'+esc(file.name)+'</small></button>').join(''):'<p class="section-note">没有可多开的 PDF 或 PPT 文档。</p>';
 host.onclick=async event=>{
  const row=event.target.closest('[data-tab-open]');if(!row)return;
  const entry=rows.find(item=>item.file.id===row.dataset.tabOpen);if(!entry)return;
  $('readerTabPicker').close();
  const profile=appState.activeId,session=readingSession;
  try{
   const blob=await readBlob(entry.file.id,profile,{fromSync:true});
   if($('reader').open&&readingSession===session&&appState.activeId===profile){
    if(typeof fileIsPresentation==='function'&&fileIsPresentation(entry.file))await openPresentationAttachment(entry.file,blob);
    else await openReadableAttachment(entry.file,blob);
   }
  }catch(error){toast(error.message)}
 };
}
document.addEventListener('pdf-page-change',event=>{
 const tab=readerTabs.find(item=>item.id===activeReaderTab);
 if(tab&&event.detail?.session===readingSession)tab.page=event.detail.page;
});
$('reader').addEventListener('close',()=>{
 setTimeout(()=>{
  if($('reader').open)return;
  readerTabs.length=0;activeReaderTab=null;renderReaderTabStrip();
 },0);
});
