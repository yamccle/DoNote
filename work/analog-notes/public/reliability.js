/**
 * [INPUT]: 读取编辑器提供的记录字段、附件和当前用户。
 * [OUTPUT]: 暂存、恢复和清理草稿，实时更新备份中心健康指标、容量预警与进度横幅。
 * [POS]: 供记录编辑器与备份恢复中心调用的可靠性与状态层。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
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
async function flushEditorDraft(){
 queueDraft();
 await saveDraftNow();
 return !draftDirty;
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
 const p=activeProfile();
 if(!p)return;
 const last=localStorage.getItem('analog-last-export/'+p.id);
 const visibleRecords=p.records.filter(r=>!r.flashcardKind);
 let attCount=0,attBytes=0;
 for(const note of p.records)for(const a of note.attachments||[]){attCount++;attBytes+=Number(a.size)||0;}
 let estBytes=attBytes;
 try{const usage=await navigator.storage?.estimate();if(usage?.usage!==undefined)estBytes=Math.max(attBytes,usage.usage)}catch{}

 let text='当前用户 '+visibleRecords.length+' 条记录；上次导出：'+(last?new Date(last).toLocaleString('zh-CN'):'尚未导出');
 if(estBytes>0)text+='。本机存储使用约 '+sizeLabel(estBytes);
 text+='。草稿自动暂存在本浏览器，不等同于外部备份。';
 $('reliabilityStatus').textContent=text;

 const statRec=$('backupStatRecords'),statSize=$('backupStatSize'),statLast=$('backupStatLast'),lightHint=$('backupLightHint');
 if(statRec)statRec.textContent=(p.name||'当前用户')+' · '+visibleRecords.length+' 条记录'+(attCount?'（'+attCount+' 个附件）':'');
 if(statSize)statSize.textContent=estBytes>0?'约 '+sizeLabel(estBytes):'小于 1 MB';
 if(statLast){
  if(!last){
   statLast.textContent='尚未外部备份 · 建议备份';
   statLast.dataset.backupHealth='warn';
  }else{
   const dt=new Date(last),ageDays=Math.floor((Date.now()-dt.getTime())/86400000);
   const shortTime=dt.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})+' '+dt.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
   statLast.textContent=ageDays>14?shortTime+'（'+ageDays+' 天前）':shortTime;
   statLast.dataset.backupHealth=ageDays>14?'warn':'ok';
  }
 }
 const overLimit=attBytes>MAX_BACKUP;
 if(lightHint){
  lightHint.textContent=overLimit
   ?'当前附件约 '+sizeLabel(attBytes)+'（超过 500 MB 单文件上限），完整备份请用上方「流式备份」或「云端备份」'
   :'总附件 500 MB 以内可打包为单文件，或仅导出纯文本 Markdown 大纲';
  lightHint.classList.toggle('is-over-limit',overLimit);
 }
 for(const id of ['exportFolder','exportJson']){
  const btn=$(id);if(btn)btn.classList.toggle('is-muted-limit',overLimit);
 }
 const draftHint=$('draftStatusHint');
 if(draftHint&&database){
  try{
   const d=await reqResult(database.transaction('workspace').objectStore('workspace').get(draftStorageKey(p.id)));
   draftHint.textContent=d
    ?'检测到暂存草稿（'+new Date(d.savedAt).toLocaleString('zh-CN')+(d.fields?.title?' · '+d.fields.title.slice(0,22):'')+'）'
    :'当前没有未提交的暂存草稿（草稿仅暂存在应用内，不等同于外部备份）';
  }catch{}
 }
}
function syncBackupLiveBanner(){
 const banner=$('backupStatusBanner'),msg=$('importMessage'),bar=$('backupProgressBar');
 if(!banner||!msg)return;
 const text=msg.textContent.trim();
 banner.hidden=!text;
 if(!text){if(bar)bar.hidden=true;return}
 const isOk=/^(已保存|大文件备份已完成|导入完成)/.test(text);
 const isErr=/(未完成|失败|不足|无效|超出|过大|缺少|异常|已变化)/.test(text);
 banner.dataset.tone=isErr?'error':isOk?'ok':'running';
 if(bar){
  const m=text.match(/(\d+)\s*\/\s*(\d+)/);
  if(!isOk&&!isErr&&m&&Number(m[2])>0){
   bar.hidden=false;bar.max=Number(m[2]);bar.value=Math.min(Number(m[1]),Number(m[2]));
  }else bar.hidden=true;
 }
}
function initializeReliability(){
 if(!ready)return;
 window.addEventListener('beforeunload',e=>{if(draftDirty){saveDraftNow();e.preventDefault();e.returnValue=''}});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')saveDraftNow()});
 $('restoreDraft').onclick=restoreLatestDraft;
 const dataDirBtn=$('backupOpenDataDir'),hostWeb=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
 if(dataDirBtn&&hostWeb){
  dataDirBtn.hidden=false;
  dataDirBtn.onclick=()=>hostWeb.postMessage('view-data-folder');
 }
 const msg=$('importMessage');
 if(msg){new MutationObserver(syncBackupLiveBanner).observe(msg,{childList:true,characterData:true,subtree:true});syncBackupLiveBanner()}
 const backupDialog=$('backup');
 if(backupDialog){
  new MutationObserver(()=>{if(backupDialog.open){if(msg&&!/正在/.test(msg.textContent))msg.textContent='';void refreshStorageSummary();}}).observe(backupDialog,{attributes:true,attributeFilter:['open']});
 }
 const backupOpen=$('backupBtn').onclick;$('backupBtn').onclick=()=>{backupOpen();void refreshStorageSummary()};
 const originalDownloadBlob=downloadBlob;downloadBlob=function(name,blob){originalDownloadBlob(name,blob);if(/^analog-notes-|^AnalogNotes-/.test(name)&&/\.(json|zip)$/.test(name)){markBackupExport();void refreshStorageSummary()}};
 if(navigator.storage?.persisted)navigator.storage.persisted().then(persisted=>{if(!persisted&&navigator.storage.persist)navigator.storage.persist().catch(()=>{})}).catch(()=>{});
}
