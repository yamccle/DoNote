'use strict';
// 回收站：删除的记录在这里保留 30 天，附件原样保留；恢复或彻底删除都在这里完成。
const TRASH_RETENTION_DAYS=30;
const TRASH_CAP=200;
function trashOf(profile){return Array.isArray(profile.trash)?profile.trash:[]}
function validTrashEntry(entry){
 if(!entry||typeof entry.id!=='string'||!entry.id||typeof entry.deletedAt!=='string'||!entry.deletedAt)return false;
 return typeof validate==='function'?validate(entry.record):true;
}
function normalizeTrash(profile){
 profile.trash=trashOf(profile).filter(validTrashEntry);
}
function relativeTrashTime(iso){
 const ms=Date.now()-new Date(iso).getTime();
 if(!Number.isFinite(ms)||ms<0)return '刚刚';
 const minutes=Math.floor(ms/60000);if(minutes<1)return '刚刚';if(minutes<60)return minutes+' 分钟前';
 const hours=Math.floor(minutes/60);if(hours<24)return hours+' 小时前';
 return Math.floor(hours/24)+' 天前';
}
// 删除 → 移入回收站。附件与批注留在本机，恢复时原样找回。
async function removeWorkspaceRecords(targetIds,aiTask){
 const profileId=appState.activeId,next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId),removed=p.records.filter(note=>targetIds.has(note.id));
 if(removed.length!==targetIds.size)throw new Error('部分记录已经变化，请刷新后重试。');
 const now=new Date().toISOString();
 p.records=p.records.filter(note=>!targetIds.has(note.id)).map(note=>note.relatedResources?.some(id=>targetIds.has(id))
  ?{...note,relatedResources:note.relatedResources.filter(id=>!targetIds.has(id)),updatedAt:now}
  :note);
 pruneReadingLists(p);
 p.trash??=[];
 for(const note of removed)p.trash.push({id:note.id,deletedAt:now,record:note});
 if(p.trash.length>TRASH_CAP)p.trash=p.trash.slice(-TRASH_CAP);
 if(aiTask){p.aiApplied??={};p.aiApplied[aiTask]={recordId:removed[0].id,at:now}}
 await commitState(next);
 for(const id of targetIds)try{localStorage.removeItem(checkpointKey(profileId,id))}catch{}
}
// 恢复：回到原栏目；同编号已被占用时换用新编号。文件夹已删除则回到未归档。
async function restoreTrashRecords(ids){
 const profileId=appState.activeId,next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId),wanted=new Set(ids);
 const entries=trashOf(p).filter(t=>wanted.has(t.id));
 if(entries.length!==wanted.size)throw new Error('部分条目已不在回收站，请刷新回收站后重试。');
 for(const entry of entries){
  if(p.records.some(n=>n.id===entry.record.id))entry.record.id=crypto.randomUUID();
  if(entry.record.folderId&&!scopedFolderId(entry.record.type,entry.record.folderId,p))delete entry.record.folderId;
  p.records.push(normalizeRichNote(entry.record));
 }
 p.trash=trashOf(p).filter(t=>!wanted.has(t.id));
 await commitState(next);render();
}
// 彻底删除：清掉仅属于这些条目的附件、批注、缩略图和阅读进度。
async function deleteTrashPermanently(ids){
 const profileId=appState.activeId,next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId),wanted=new Set(ids);
 const entries=trashOf(p).filter(t=>wanted.has(t.id));
 if(entries.length!==wanted.size)throw new Error('部分条目已变化，请刷新回收站后重试。');
 p.trash=trashOf(p).filter(t=>!wanted.has(t.id));
 const kept=new Set([...p.records.flatMap(n=>(n.attachments||[]).map(a=>a.id)),...trashOf(p).flatMap(t=>(t.record.attachments||[]).map(a=>a.id))]);
 const removedFiles=[...new Set(entries.flatMap(t=>(t.record.attachments||[]).map(a=>a.id)))].filter(id=>!kept.has(id));
 const workspaceKeys=[];
 for(const id of removedFiles){
  workspaceKeys.push(annotationKey(profileId,id),videoFrameNotesKey(profileId,id));
  workspaceKeys.push(keyPrefixRange(galleryThumbnailPrefix(profileId,id)));
 }
 const readingIds=new Set([...wanted,...removedFiles]);
 for(const id of readingIds)if(p.reading)delete p.reading[id];
 const fileDeletions=[...removedFiles.map(id=>fileKey(profileId,id)),...removedFiles.map(id=>fileKey(profileId,'search:'+id))];
 await commitState(next,[],fileDeletions,workspaceKeys);
 for(const id of readingIds)try{localStorage.removeItem(checkpointKey(profileId,id))}catch{}
}
async function emptyTrash(){
 const ids=trashOf(activeProfile()).map(t=>t.id);
 if(!ids.length){toast('回收站已经是空的。');return}
 await deleteTrashPermanently(ids);
 renderTrashDialog();toast('回收站已清空');
}
async function purgeExpiredTrash(){
 if(!appState)return;
 const cutoff=Date.now()-TRASH_RETENTION_DAYS*86400000,next=structuredClone(appState),expiredIds=new Set();
 for(const p of next.profiles){
  const gone=trashOf(p).filter(t=>{const d=new Date(t.deletedAt).getTime();return !Number.isFinite(d)||d<cutoff});
  for(const t of gone)expiredIds.add(t.id);
  p.trash=trashOf(p).filter(t=>!expiredIds.has(t.id));
 }
 if(!expiredIds.size)return;
 const deletions=[],workspaceKeys=[];
 for(const p of appState.profiles){
  const after=next.profiles.find(x=>x.id===p.id);
  const kept=new Set([...after.records.flatMap(n=>(n.attachments||[]).map(a=>a.id)),...trashOf(after).flatMap(t=>(t.record.attachments||[]).map(a=>a.id))]);
  for(const id of new Set(trashOf(p).filter(t=>expiredIds.has(t.id)).flatMap(t=>(t.record.attachments||[]).map(a=>a.id)))){
   if(kept.has(id))continue;
   deletions.push(fileKey(p.id,id),fileKey(p.id,'search:'+id));
   workspaceKeys.push(annotationKey(p.id,id),videoFrameNotesKey(p.id,id),keyPrefixRange(galleryThumbnailPrefix(p.id,id)));
  }
 }
 await commitState(next,[],deletions,workspaceKeys);
}
// 删除后的即时撤销。
async function undoLastTrash(){
 if(!lastTrashAction)return;
 const {profileId,ids}=lastTrashAction;lastTrashAction=null;
 if(appState.activeId!==profileId){toast('用户已切换，请到回收站恢复。');return}
 try{await restoreTrashRecords(ids);toast('已撤销删除')}
 catch(e){toast(e.message)}
}
function renderTrashDialog(){
 const p=activeProfile(),items=trashOf(p),list=$('trashList');
 $('trashCount').textContent=items.length?items.length+' 条 · 30 天后自动清理':'回收站是空的';
 list.innerHTML=items.length?items.map(t=>'<div class="manager-row" data-trash-id="'+esc(t.id)+'"><span>'+esc(t.record.title)+'<small class="tiny">'+esc(names[t.record.type]||t.record.type)+' · '+relativeTrashTime(t.deletedAt)+' · '+((t.record.attachments||[]).length||0)+' 个附件</small></span><button type="button" class="secondary" data-trash-action="restore">恢复</button><button type="button" class="danger" data-trash-action="purge">彻底删除</button></div>').join('')
  :'<p class="section-note">还没有删除的记录。删除后会先进入这里，保留 30 天。</p>';
 list.onclick=async e=>{
  const row=e.target.closest('[data-trash-id]'),action=e.target.closest('[data-trash-action]')?.dataset.trashAction;
  if(!row||!action)return;
  try{
   if(action==='restore'){await restoreTrashRecords([row.dataset.trashId]);renderTrashDialog();toast('已恢复')}
   else if(await confirmWorkspaceDeletion('彻底删除「'+row.dataset.trashId+'」？附件会一并清除，无法找回。')){await deleteTrashPermanently([row.dataset.trashId]);renderTrashDialog();toast('已彻底删除')}
  }catch(error){$('trashMessage').textContent=error.message}
 };
}
function openTrashDialog(){if(!ensureReady())return;renderTrashDialog();$('trashMessage').textContent='';$('trashDialog').showModal()}
let lastTrashAction=null;
$('openTrash').onclick=openTrashDialog;
$('trashEmptyAll').onclick=()=>{const items=trashOf(activeProfile());if(!items.length){toast('回收站已经是空的。');return}confirmWorkspaceDeletion('清空回收站？其中 '+items.length+' 条记录及其附件将被彻底删除，无法找回。').then(ok=>{if(ok)return emptyTrash()}).catch(error=>toast(error.message))};
