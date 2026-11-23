'use strict';
let draftTimer,draftSnapshot=null,draftQueue=Promise.resolve(),draftGeneration=0,draftDirty=false,draftBaseline='',restoringDraft=false;
function safeFileName(name){const ext=String(name).match(/\.[A-Za-z0-9]{1,12}$/)?.[0]||'';return safeSegment(ext?String(name).slice(0,-ext.length):name).slice(0,76)+ext}
async function fileDigest(blob,onProgress){
 if(typeof sha256==='undefined'){
  if(blob.size>16*1024**2)throw new Error('分块校验组件未加载。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
 }
 const digest=sha256.create(),chunk=4*1024**2;
 for(let offset=0;offset<blob.size;offset+=chunk){
  const part=await blob.slice(offset,offset+chunk).arrayBuffer();
  digest.update(new Uint8Array(part));onProgress?.(Math.min(blob.size,offset+part.byteLength),blob.size);
 }
 return digest.hex();
}
function draftStorageKey(profileId){return 'draft/'+profileId}
function captureEditorDraft(){
 const fields={};
 for(const id of ['type','date','status','title','reference','url','tagsInput','author','journalKind','issueTrack',
  'recordFolder','planTrack','planPeriod','planStart','planEnd'])fields[id]=$(id).value;
 return {profileId:appState.activeId,editing,baseUpdatedAt:records.find(n=>n.id===editing)?.updatedAt||null,fields,bodyHtml:getRichHtml(),pinned:$('pinned').checked,attachments:structuredClone(draftAttachments),files:[...stagedFiles].map(([id,blob])=>({id,blob})),relatedResources:[...selectedResourceLinks],savedAt:new Date().toISOString()};
}
function draftSignature(d){return JSON.stringify({editing:d.editing,fields:d.fields,bodyHtml:d.bodyHtml,pinned:d.pinned,attachments:d.attachments,relatedResources:d.relatedResources})}
function beginDraftSession(){clearTimeout(draftTimer);draftSnapshot=null;draftDirty=false;draftGeneration++;draftBaseline=draftSignature(captureEditorDraft());$('saveHint').textContent='草稿自动暂存'}
function queueDraft(){
 if(!ready||!database||!$('editor').open||busy||restoringDraft)return;
 const snapshot=captureEditorDraft();if(draftSignature(snapshot)===draftBaseline)return;
 draftSnapshot=snapshot;draftDirty=true;$('saveHint').textContent='正在暂存草稿…';clearTimeout(draftTimer);draftTimer=setTimeout(()=>saveDraftNow(),350);
}
function saveDraftNow(){
 clearTimeout(draftTimer);if(!draftSnapshot||!database)return draftQueue;
 const snapshot=draftSnapshot,generation=draftGeneration;draftSnapshot=null;
 draftQueue=draftQueue.catch(()=>{}).then(async()=>{
  if(generation!==draftGeneration)return;
  const tx=database.transaction('workspace','readwrite'),done=transactionDone(tx),store=tx.objectStore('workspace');
  const state=store.get('state');let exists=false;
  state.onsuccess=()=>{
   exists=state.result?.profiles.some(profile=>profile.id===snapshot.profileId);
   if(exists)store.put(snapshot,draftStorageKey(snapshot.profileId));
  };
  await done;
  if(!exists)throw new Error('当前用户已删除，草稿未写入。');
  if(generation===draftGeneration&&!draftSnapshot){draftDirty=false;$('saveHint').textContent='草稿已暂存 '+new Date(snapshot.savedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});}
 }).catch(error=>{if(generation!==draftGeneration)return;draftDirty=true;if(!draftSnapshot)draftSnapshot=snapshot;$('saveHint').textContent='草稿暂存失败，请保存记录或保留页面';toast(storageError(error).message)});
 return draftQueue;
}
async function clearSavedDraft(){
 draftGeneration++;clearTimeout(draftTimer);draftSnapshot=null;draftDirty=false;await draftQueue;
 try{const tx=database.transaction('workspace','readwrite'),done=transactionDone(tx);tx.objectStore('workspace').delete(draftStorageKey(appState.activeId));await done}catch(e){toast('记录已保存；旧草稿清理失败，可忽略旧草稿')}
}
async function restoreLatestDraft(){
 if(!ensureReady())return;
 try{
  const d=await reqResult(database.transaction('workspace').objectStore('workspace').get(draftStorageKey(appState.activeId)));if(!d){toast('当前用户没有可恢复的草稿。');return}
  const existing=records.find(n=>n.id===d.editing),conflict=!!d.editing&&(!existing||existing.updatedAt!==d.baseUpdatedAt);
  if(!confirm('恢复 '+new Date(d.savedAt).toLocaleString('zh-CN')+' 的最近草稿？'+(conflict?'原记录已变化，将恢复成新记录，保留现有内容。':'')))return;
  $('backup').close();restoringDraft=true;
  const note={id:conflict?null:d.editing,type:statusOptions[d.fields.type]?d.fields.type:defaultRecordType(),date:d.fields.date,status:d.fields.status,title:d.fields.title,body:'',bodyHtml:d.bodyHtml,reference:d.fields.reference,url:d.fields.url,author:d.fields.author,journalKind:d.fields.journalKind,issueTrack:d.fields.issueTrack,tags:d.fields.tagsInput.split(/[,，]/).map(t=>t.trim()).filter(Boolean),pinned:d.pinned,attachments:d.attachments,relatedResources:d.relatedResources};
  note.folderId=d.fields.recordFolder??existing?.folderId;
  if(note.type==='plan'){
   note.planTrack=d.fields.planTrack??existing?.planTrack;
   note.planStart=d.fields.planStart??existing?.planStart;
   note.planEnd=d.fields.planEnd??existing?.planEnd;
  }
  const restoredFiles=new Map(d.files.map(f=>[f.id,f.blob]));
  if(conflict){const ids=new Map(),files=new Map();for(const a of note.attachments){const blob=restoredFiles.get(a.id)||await readBlob(a.id);const id=crypto.randomUUID();ids.set(a.id,id);a.id=id;files.set(id,blob)}restoredFiles.clear();for(const pair of files)restoredFiles.set(...pair);const body=document.createElement('template');body.innerHTML=note.bodyHtml;for(const n of body.content.querySelectorAll('[data-image-id]'))if(ids.has(n.dataset.imageId))n.dataset.imageId=ids.get(n.dataset.imageId);note.bodyHtml=body.innerHTML}
  openEditor(note.type,note);
  if(note.type==='plan'&&['week','month','custom'].includes(d.fields.planPeriod))$('planPeriod').value=d.fields.planPeriod;
  stagedFiles=restoredFiles;renderDraftAttachments();await hydrateDocumentImages(richEditor,note,true);syncRichBody();setEditorMode(true);restoringDraft=false;beginDraftSession();$('saveHint').textContent='草稿已恢复，保存后写入记录';
 }catch(error){restoringDraft=false;toast('草稿恢复失败：'+error.message)}
}
function markBackupExport(){try{localStorage.setItem('analog-last-export/'+appState.activeId,new Date().toISOString())}catch{}}
async function refreshStorageSummary(){
 const p=activeProfile(),last=localStorage.getItem('analog-last-export/'+p.id);let text='当前用户 '+p.records.length+' 条记录；上次导出：'+(last?new Date(last).toLocaleString('zh-CN'):'尚未导出');
 try{const usage=await navigator.storage?.estimate();if(usage?.usage!==undefined)text+='。本机存储使用约 '+sizeLabel(usage.usage)}catch{}
 text+='。草稿自动暂存在本浏览器，不等同于外部备份。';$('reliabilityStatus').textContent=text;
}
function initializeReliability(){
 if(!ready)return;
 const originalOpen=openEditor;openEditor=function(...args){originalOpen(...args);if($('editor').open)beginDraftSession()};
 const originalSync=syncRichBody;syncRichBody=function(){originalSync();queueDraft()};
 $('noteForm').addEventListener('input',queueDraft);$('noteForm').addEventListener('change',queueDraft);
 document.querySelectorAll('[data-close="editor"]').forEach(button=>button.onclick=async()=>{if(busy)return;queueDraft();await saveDraftNow();if(draftDirty){toast('草稿尚未保存，请先保存记录。');return}$('editor').close()});
 // Esc 不再关闭记录编辑器：只安静保存草稿，避免误按丢失编辑状态。
 $('editor').addEventListener('cancel',e=>{e.preventDefault();if(!busy){queueDraft();saveDraftNow()}});
 window.addEventListener('beforeunload',e=>{if(draftDirty){saveDraftNow();e.preventDefault();e.returnValue=''}});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')saveDraftNow()});
 $('restoreDraft').onclick=restoreLatestDraft;
 const backupOpen=$('backupBtn').onclick;$('backupBtn').onclick=()=>{backupOpen();refreshStorageSummary()};
 const originalDownloadBlob=downloadBlob;downloadBlob=function(name,blob){originalDownloadBlob(name,blob);if(/^analog-notes-|^AnalogNotes-/.test(name)&&/\.(json|zip)$/.test(name)){markBackupExport();refreshStorageSummary()}};
 if(navigator.storage?.persisted)navigator.storage.persisted().then(persisted=>{if(!persisted&&navigator.storage.persist)navigator.storage.persist().catch(()=>{})}).catch(()=>{});
}
