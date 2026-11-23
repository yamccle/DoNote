/**
 * [INPUT]: 读取浮窗状态、当前账户和阅读位置。
 * [OUTPUT]: 收起或恢复浮窗，并保留滚动位置与键盘焦点。
 * [POS]: 工作台浮窗控制层，复用原生对话框生命周期。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const minimizedWorkspaceDialogs=new Map();
const minimizationCloseEvents=new WeakSet();
const workspaceMinimizeAnimations=new WeakMap();
const workspaceModalOrder=[];

document.addEventListener('beforetoggle',event=>{
 const dialog=event.target;
 if(!(dialog instanceof HTMLDialogElement))return;
 const index=workspaceModalOrder.indexOf(dialog);
 if(index!==-1)workspaceModalOrder.splice(index,1);
 if(event.newState==='open')workspaceModalOrder.push(dialog);
},true);

function topWorkspaceModal(){
 // Opening order can differ from DOM order when dialogs are stacked.
 return workspaceModalOrder.findLast(dialog=>dialog.matches(':modal'))||
  [...document.querySelectorAll('dialog:modal')].at(-1);
}

const resumeWorkspaceButton=document.createElement('button');
resumeWorkspaceButton.id='resumeWorkspaceDialog';resumeWorkspaceButton.type='button';
resumeWorkspaceButton.className='secondary';resumeWorkspaceButton.textContent='↗';resumeWorkspaceButton.hidden=true;
document.body.append(resumeWorkspaceButton);

function refreshWorkspaceLauncher(){
 const entry=[...minimizedWorkspaceDialogs.entries()].at(-1);
 resumeWorkspaceButton.hidden=!entry;
 if(!entry)return;
 const parent=topWorkspaceModal()||document.body;
 if(resumeWorkspaceButton.parentElement!==parent)parent.append(resumeWorkspaceButton);
 const label='返回 '+entry[1].title;
 resumeWorkspaceButton.setAttribute('aria-label',label);resumeWorkspaceButton.title=label;
}

function discardMinimizedWorkspaceDialog(id){
 const dialog=$(id);
 if(!minimizedWorkspaceDialogs.delete(dialog))return;
 // Run the regular teardown for content being replaced, even though it is already out of the top layer.
 dialog.dispatchEvent(new Event('close'));
 refreshWorkspaceLauncher();
}

function discardWorkspaceDialogsForProfile(profileId){
 for(const [dialog,state] of minimizedWorkspaceDialogs)if(state.profileId!==profileId)discardMinimizedWorkspaceDialog(dialog.id);
}

function workspaceEditorActive(){return $('editor').open||minimizedWorkspaceDialogs.has($('editor'))}

function animateWorkspaceMinimize(dialog){
 return dialog.animate([
  {translate:'0 0',opacity:1},
  {translate:'0 7px',opacity:0}
 ],{duration:120,easing:'ease-out',fill:'forwards'});
}

async function minimizeWorkspaceDialog(dialog){
 if(!dialog.open||busy||workspaceMinimizeAnimations.has(dialog)||dialog.classList.contains('document-page'))return;
 if(dialog.id==='detail'&&!$('detailDeleteConfirm').hidden)$('detailDeleteCancel').click();
 if(dialog.id==='editor')void flushEditorDraft();
 if(dialog.id==='reader'){
  dialog.querySelector('audio')?.pause();
  if(readingSession){
   if(readingSession.video&&!readingSession.video.paused)readingSession.video.pause();
   else persistReading(readingSession);
  }
 }
 const title=dialog.querySelector('#readerTitle,#detailTitle,#editorTitle')?.textContent||'浮窗';
 const scrolls=[dialog,...dialog.querySelectorAll('.modalbody,.pdf-scroll,.pdf-outline,.pdf-side,.presentation-stage,.web-reader-scroll')].map(node=>[node,node.scrollTop,node.scrollLeft]);
 const state={
  title,scrolls,profileId:appState.activeId,
  recordId:dialog.id==='detail'?current:dialog.id==='editor'?editing:null,
  fileId:dialog.id==='reader'?readerFile?.id:null
 };
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&typeof dialog.animate==='function'){
  const animation=animateWorkspaceMinimize(dialog);
  workspaceMinimizeAnimations.set(dialog,animation);dialog.classList.add('workspace-minimizing');
  try{await animation.finished}catch{return}
  finally{
   workspaceMinimizeAnimations.delete(dialog);dialog.classList.remove('workspace-minimizing');animation.cancel();
  }
  if(!dialog.open)return;
 }
 minimizedWorkspaceDialogs.set(dialog,state);
 minimizationCloseEvents.add(dialog);dialog.close();
 refreshWorkspaceLauncher();resumeWorkspaceButton.focus({preventScroll:true});
}

function resumeWorkspaceDialog(dialog){
 const state=minimizedWorkspaceDialogs.get(dialog);
 if(!state)return false;
 const missingRecord=state.recordId&&!records.some(note=>note.id===state.recordId);
 const missingFile=state.fileId&&!stagedFiles.has(state.fileId)&&!records.some(note=>note.attachments?.some(file=>file.id===state.fileId));
 if(state.profileId!==appState.activeId||missingRecord||missingFile){
  discardMinimizedWorkspaceDialog(dialog.id);toast('这份资料或记录已不可用。');return false;
 }
 minimizedWorkspaceDialogs.delete(dialog);dialog.showModal();refreshWorkspaceLauncher();
 const restoreScroll=()=>{if(dialog.open)for(const [node,top,left] of state.scrolls)node.scrollTo(left,top)};
 restoreScroll();requestAnimationFrame(restoreScroll);
 return true;
}

resumeWorkspaceButton.onclick=()=>{
 const dialog=[...minimizedWorkspaceDialogs.keys()].at(-1);
 if(dialog)resumeWorkspaceDialog(dialog);
};

function fixWorkspaceDialogHeaders(){
 for(const dialog of document.querySelectorAll('dialog')){
  const head=dialog.querySelector('.modalhead');if(!head||head.dataset.fixedWindowHeader)continue;
  head.dataset.fixedWindowHeader='true';
  let close=head.querySelector('[data-close],[data-close-about],[data-close-translation],[aria-label="关闭"]');
  if(!close){close=document.createElement('button');close.type='button';close.className='icon-button';close.textContent='✕';close.setAttribute('aria-label','关闭');close.onclick=()=>dialog.close();head.append(close)}
  close.title='关闭';
  const actions=document.createElement('div');actions.className='dialog-window-actions';actions.setAttribute('aria-label','浮窗操作');
  const minimize=head.querySelector('.workspace-minimize-action');
  if(minimize)actions.append(minimize);
  actions.append(close);head.append(actions);
 }
}

document.addEventListener('close',event=>{
 workspaceMinimizeAnimations.get(event.target)?.cancel();
 if(event.isTrusted&&minimizationCloseEvents.delete(event.target))event.stopPropagation();
 refreshWorkspaceLauncher();
},true);

for(const id of ['detail','reader','editor']){
 const dialog=$(id),close=dialog.querySelector('[data-close="'+id+'"]');
 const button=document.createElement('button');button.type='button';button.className='icon-button workspace-minimize-action';
 button.textContent='−';button.title='收起浮窗';button.setAttribute('aria-label','收起浮窗');
 close.before(button);button.onclick=()=>minimizeWorkspaceDialog(dialog);
 const outside=event=>{
  if(event.target!==dialog)return false;
  const {left,right,top,bottom}=dialog.getBoundingClientRect();
  return event.clientX<left||event.clientX>right||event.clientY<top||event.clientY>bottom;
 };
 let pressedOutside=false;
 dialog.addEventListener('pointerdown',event=>{pressedOutside=event.button===0&&outside(event)});
 dialog.addEventListener('click',event=>{
  if(pressedOutside&&outside(event))minimizeWorkspaceDialog(dialog);
  pressedOutside=false;
 });
}
fixWorkspaceDialogHeaders();
new MutationObserver(changes=>{
 if(changes.some(change=>[...change.addedNodes].some(node=>node instanceof Element&&
  (node.matches('dialog,.modalhead')||node.querySelector('dialog,.modalhead')))))fixWorkspaceDialogHeaders();
}).observe(document.body,{childList:true,subtree:true});
