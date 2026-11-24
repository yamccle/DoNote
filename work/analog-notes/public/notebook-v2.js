'use strict';
// User-owned offline records and attachments are committed together.
const DEFAULT_TOPICS=['运放','ADC','PLL','LDO','带隙基准','噪声','稳定性'];
const MAX_TOPICS=100,MAX_TOPIC_LENGTH=60;
const MAX_FILE=2*1024**3;
const MAX_DOCUMENT_PREVIEW=100*1024**2;
const MAX_PDF_PREVIEW=MAX_FILE;
const MAX_BACKUP=500*1024**2;
const MAX_ATTACHMENTS=999;
let database,appState,profileEditing=null,draftAttachments=[],stagedFiles=new Map(),readerUrl=null,readerFile=null;
const activeProfile=()=>appState?.profiles.find(p=>p.id===appState.activeId);
const sizeLabel=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1024**3?(n/1048576).toFixed(1)+' MB':(n/1024**3).toFixed(1)+' GB';
const fileKey=(profileId,id)=>profileId+'/'+id;
const keyPrefixRange=prefix=>IDBKeyRange.bound(prefix,prefix+'\uffff');
const reqResult=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
const transactionDone=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('保存未完成，请重试。'));tx.onerror=()=>{}});
function storageError(error){return error?.name==='QuotaExceededError'?new Error('本机存储空间不足，未保存本次更改。请先导出备份，再释放空间。'):error}
async function openDatabase(){
 const request=indexedDB.open('analog-notes-offline-v2',1);
 request.onupgradeneeded=()=>{request.result.createObjectStore('workspace');request.result.createObjectStore('files')};
 database=await reqResult(request);database.onversionchange=()=>{database.close();ready=false;toast('存储版本已更新，请重新打开页面。')};
}
async function commitState(next,writes=[],deletions=[],workspaceDeletions=[]){
 const expectedRevision=next.revision||0;
 const tx=database.transaction(['workspace','files'],'readwrite'),done=transactionDone(tx);
 const workspace=tx.objectStore('workspace'),files=tx.objectStore('files');
 let conflict=false;
 const stored=workspace.get('state');
 stored.onsuccess=()=>{
  if((stored.result?.revision||0)!==expectedRevision){conflict=true;tx.abort();return}
  next.revision=expectedRevision+1;
  workspace.put(next,'state');
  for(const {blob,key} of writes)files.put(blob,key);
  for(const id of deletions)files.delete(id);
  for(const key of workspaceDeletions)workspace.delete(key);
 };
 try{await done}catch(error){if(conflict)throw new Error('另一个窗口已修改资料，请刷新后再操作，避免覆盖记录。');throw storageError(error)}
 appState=next;records=activeProfile().records;
}
async function putWorkspaceForFile(profileId,fileId,key,value){
 const tx=database.transaction(['workspace','files'],'readwrite'),done=transactionDone(tx);
 const check=tx.objectStore('files').getKey(fileKey(profileId,fileId));
 check.onsuccess=()=>{if(check.result!==undefined)tx.objectStore('workspace').put(value,key)};
 await done;
 if(check.result===undefined)return false;
 if(key.startsWith('pdf-index-v3/')||key.startsWith('video-frame-notes/')){
  document.dispatchEvent(new CustomEvent('workspace-search-file-updated',{detail:{profileId,fileId,key}}));
 }
 return true;
}
async function readBlob(id,profileId=appState.activeId){const tx=database.transaction('files');const value=await reqResult(tx.objectStore('files').get(fileKey(profileId,id)));if(!(value instanceof Blob))throw new Error('附件文件缺失，请从完整备份恢复。');return value}
function waitForReaderSaves(){
 return Promise.all([readingSaveQueue,annotationQueue,webReaderSaveQueue.catch(()=>{}),videoFrameSaveQueue.catch(()=>{})]);
}
async function load(){
 try{
  await openDatabase();appState=await reqResult(database.transaction('workspace').objectStore('workspace').get('state'));
  if(!appState){
   const old=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(old)||old.some(n=>!validate(n)))throw new Error('旧版记录格式异常，未修改旧数据。请使用旧版导出备份后恢复。');
   const id=crypto.randomUUID(),profile={id,name:'默认用户',role:'',topics:[...new Set([...DEFAULT_TOPICS,...old.flatMap(n=>n.tags)])].filter(t=>t.trim()&&t.length<=60).slice(0,100),records:old.map(n=>({...n,attachments:[]}))};
   await commitState({version:2,revision:0,activeId:id,profiles:[profile]});
  }
  const upgraded=structuredClone(appState);
  if(upgraded.profiles.map(profile=>{const journal=upgradeJournalCategories(profile),plan=upgradePlanCategory(profile);return journal||plan}).some(Boolean))await commitState(upgraded);
  records=activeProfile().records;for(const profile of appState.profiles)normalizeTrash(profile);await purgeExpiredTrash().catch(()=>{});ready=true;updateIdentity();render();
  setTimeout(()=>{if(typeof preIndexRecentPdfs==='function')preIndexRecentPdfs()},1600);
  $('sync').innerHTML='<span class="dot"></span>本机保存 · 附件可离线读取';
  $('storageNote').textContent='备份范围：当前用户。大文件请使用「流式备份到文件夹」，导出前会检查目标磁盘空间，不生成超大 ZIP。恢复时选择备份文件夹；导入前会检查可用空间，并按记录编号和内容特征跳过重复项。';
  if(!window.showDirectoryPicker)$('writeFolder').hidden=true;
 }catch(error){ready=false;$('sync').textContent='存储未就绪';$('banner').classList.add('visible');$('banner').textContent=error.message;render()}
}
function updateIdentity(){
 document.dispatchEvent(new Event('workspace-search-profile'));
 discardWorkspaceDialogsForProfile(appState.activeId);
 if(readingSession&&readingSession.profileId!==appState.activeId&&$('reader').open){
  $('reader').close();
  if($('detail').open)$('detail').close();
 }
 if(bridgeConnection&&bridgeConnection.profileId!==appState.activeId)disconnectBridge('用户已切换，请重新连接。');
 syncCategoryConfig();const p=activeProfile();$('activeUser').textContent=p.name;
 if(typeof requestStoredBridge==='function')requestStoredBridge();
}
function addNewTopicTags(profile,tags){
 const candidates=[...new Set(tags.map(tag=>tag.trim()))].filter(tag=>tag&&tag.length<=MAX_TOPIC_LENGTH&&!profile.topics.includes(tag));
 if(!candidates.length||profile.topics.length>=MAX_TOPICS)return;
 // Existing tags that are absent from the sidebar can stay hidden when an entry is saved again.
 const existing=new Set(profile.records.flatMap(note=>note.tags));
 profile.topics.push(...candidates.filter(tag=>!existing.has(tag)).slice(0,MAX_TOPICS-profile.topics.length));
}
async function put(note,writes=[],deletions=[]){
 if(!ready)throw new Error('记录库尚未就绪，请重新打开页面。');
 const saved=normalizeRichNote({...note,attachments:note.attachments||[],updatedAt:new Date().toISOString()});
 if(saved.attachments.length>MAX_ATTACHMENTS)throw new Error('每条记录最多保存 '+MAX_ATTACHMENTS+' 个附件。');
 if(saved.folderId&&!scopedFolderId(saved.type,saved.folderId))throw new Error('请选择当前栏目的文件夹。');
 const previous=records.find(n=>n.id===saved.id);
 saved.createdAt=previous?.createdAt||note.createdAt||previous?.attachments?.[0]?.addedAt||previous?.date||new Date().toISOString();
 saved.aiSource=saved.aiSource||previous?.aiSource;
 if(saved.literature===undefined&&previous?.literature)saved.literature=previous.literature;
 if(saved.citation===undefined&&previous?.citation)saved.citation=previous.citation;
 if(saved.flashcardKind===undefined&&previous?.flashcardKind)saved.flashcardKind=previous.flashcardKind;
 if(previous?.planSourceId)saved.planSourceId=previous.planSourceId;
 if(saved.pdfSource===undefined&&previous?.pdfSource)saved.pdfSource=previous.pdfSource;
 if(saved.webSource===undefined&&previous?.webSource)saved.webSource=previous.webSource;
 if(saved.researchLinks===undefined&&previous?.researchLinks)saved.researchLinks=previous.researchLinks;
 if(saved.pdfEvidence===undefined&&previous?.pdfEvidence)saved.pdfEvidence=previous.pdfEvidence;
 if(previous?.webArticle){
  saved.webArticle=previous.webArticle;saved.webAnnotations=previous.webAnnotations;saved.webReading=previous.webReading;
 }
 if(saved.type==='resource'&&activeProfile().reading?.[saved.id])saved.readerProgress=activeProfile().reading[saved.id];
 const next=structuredClone(appState),p=next.profiles.find(p=>p.id===next.activeId);
 addNewTopicTags(p,saved.tags);
 p.records=p.records.filter(n=>n.id!==saved.id).concat(saved);
 addCompletedPlanLog(p,saved);
 const unreferenced=deletions.filter(key=>!p.records.some(n=>n.attachments?.some(a=>fileKey(p.id,a.id)===key)));
 const orphanKeys=[...unreferenced,...unreferenced.map(key=>key.slice(0,key.lastIndexOf('/')+1)+'search:'+key.slice(key.lastIndexOf('/')+1))];
 const removedFrameNotes=unreferenced.map(key=>videoFrameNotesKey(p.id,key.slice(key.lastIndexOf('/')+1)));
 await commitState(next,writes,orphanKeys,removedFrameNotes);return saved;
}
function ensureReady(){if(!ready){toast('存储未就绪，请重新打开页面。');return false}return true}

let editingTopic=null,topicSaving=false;
function setTopicEditor(name=null){
 editingTopic=name;$('topicName').value=name||'';$('topicSave').textContent=name?'更新所有记录':'添加';
 $('topicName').setAttribute('aria-label',name?'研究方向的新名称':'新研究方向');$('topicCancel').hidden=!name;
}
function renderTopics(){
 const p=activeProfile(),counts=new Map();
 for(const note of p.records)for(const tag of new Set(note.tags))counts.set(tag,(counts.get(tag)||0)+1);
 $('topicList').innerHTML=p.topics.length?p.topics.map((name,index)=>'<div class="manager-row"><span>'+esc(name)+' <small class="tiny">'+(counts.get(name)||0)+' 条记录</small></span><button type="button" class="secondary" data-topic-rename="'+index+'">改名</button><button type="button" class="danger" data-topic-delete="'+index+'">删除</button></div>').join(''):'<p class="section-note">还没有研究方向，添加一个你正在关注的主题吧。</p>';
 $('topicList').onclick=e=>{
  const button=e.target.closest('button');if(!button||topicSaving)return;
  const name=p.topics[Number(button.dataset.topicRename??button.dataset.topicDelete)];if(!name)return;
  if(button.hasAttribute('data-topic-rename')){
   setTopicEditor(name);$('topicMessage').textContent='将同步更新所有使用「'+name+'」的记录。';$('topicName').focus();$('topicName').select();
  }else removeTopic(name,counts.get(name)||0);
 };
}
async function updateTopic(name,replacement){
 const next=structuredClone(appState),p=next.profiles.find(p=>p.id===next.activeId);
 let changed=0;
 if(name===null){
  if(p.topics.includes(replacement))throw new Error('这个研究方向已存在。');
  if(p.topics.length>=MAX_TOPICS)throw new Error('最多可保留 '+MAX_TOPICS+' 个研究方向。');
  p.topics.push(replacement);
 }else{
  if(!p.topics.includes(name))throw new Error('这个研究方向已变化，请重新选择。');
  const replace=tags=>[...new Set(tags.flatMap(tag=>tag!==name?[tag]:replacement?[replacement]:[]))];
  p.topics=replace(p.topics);
  const updatedAt=new Date().toISOString();
  for(const note of p.records)if(note.tags.includes(name)){
   note.tags=replace(note.tags);note.updatedAt=updatedAt;changed++;
  }
 }
 await commitState(next);
 if(name!==null)writeSidebarTopicHistory(readSidebarTopicHistory().map(tag=>tag===name?replacement:tag).filter(Boolean));
 if(topic===name)topic=replacement||'';
 setTopicEditor();renderTopics();render();
 $('topicMessage').textContent=name===null?'已添加研究方向。':'已'+(replacement?'改名':'删除')+'，同步更新 '+changed+' 条记录。';
}
async function removeTopic(name,count){
 const profileId=appState.activeId;topicSaving=true;
 try{
  if(!await confirmWorkspaceDeletion('删除标签「'+name+'」？将从 '+count+' 条记录中移除该标签，记录和附件会保留。')||appState.activeId!==profileId)return;
  await updateTopic(name,null);
 }catch(error){$('topicMessage').textContent=error.message}
 finally{topicSaving=false}
}
function openTopics(){if(!ensureReady())return;setTopicEditor();$('topicMessage').textContent='';renderTopics();$('topicsDialog').showModal()}
$('topicsBtn').onclick=()=>{$('libraryFilters')?.hidePopover();openTopics()};
$('topicCancel').onclick=()=>{setTopicEditor();$('topicMessage').textContent=''};
$('topicForm').onsubmit=async e=>{
 e.preventDefault();const value=$('topicName').value.trim(),name=editingTopic;if(topicSaving||!value)return;
 if(value===name){setTopicEditor();$('topicMessage').textContent='';return}
 topicSaving=true;
 try{await updateTopic(name,value)}catch(error){$('topicMessage').textContent=error.message}
 finally{topicSaving=false}
};

function resetProfileForm(){profileEditing=null;$('profileForm').reset();$('profileFormTitle').textContent='添加用户';$('saveProfile').textContent='添加用户';$('cancelProfileEdit').hidden=true}
let profileDeletingId=null;
function cancelProfileDeletion(){profileDeletingId=null;$('profileDeleteConfirm').hidden=true;$('profileDeleteError').textContent=''}
function renderUsers(){
 $('userList').innerHTML=appState.profiles.map(p=>'<div class="manager-row '+(p.id===appState.activeId?'active':'')+'"><span><span class="profile-name">'+esc(p.name)+'</span><small class="profile-meta">'+esc(p.role||'本地工作台')+' · '+p.records.length+' 条记录'+(p.id===appState.activeId?' · 当前用户':'')+'</small></span><button class="secondary" data-edit-profile="'+p.id+'">修改资料</button>'+(p.id!==appState.activeId?'<button class="secondary" data-switch-profile="'+p.id+'">切换</button>':'')+'<button type="button" class="danger" data-delete-profile="'+p.id+'"'+(appState.profiles.length===1?' disabled title="至少保留一个用户"':'')+'>删除</button></div>').join('');
 $('userList').querySelectorAll('[data-edit-profile]').forEach(b=>b.onclick=()=>{const p=appState.profiles.find(p=>p.id===b.dataset.editProfile);profileEditing=p.id;$('profileName').value=p.name;$('profileRole').value=p.role;$('profileFormTitle').textContent='修改用户资料';$('saveProfile').textContent='保存修改';$('cancelProfileEdit').hidden=false;$('profileName').focus()});
 $('userList').querySelectorAll('[data-switch-profile]').forEach(b=>b.onclick=async()=>{try{const next=structuredClone(appState);next.activeId=b.dataset.switchProfile;await commitState(next);updateIdentity();switchView('all');resetProfileForm();renderUsers();$('usersDialog').close();toast('已切换到 '+activeProfile().name)}catch(e){$('userMessage').textContent=e.message}});
 $('userList').querySelectorAll('[data-delete-profile]').forEach(button=>button.onclick=()=>{
  const profile=appState.profiles.find(p=>p.id===button.dataset.deleteProfile);if(!profile||appState.profiles.length<=1)return;
  profileDeletingId=profile.id;$('profileDeleteError').textContent='';
  $('profileDeleteText').textContent='删除「'+profile.name+'」及其 '+profile.records.length+' 条记录、附件、草稿和提醒？此操作无法撤销。';
  $('profileDeleteConfirm').hidden=false;$('profileDeleteCancel').focus();
 });
}
$('usersBtn').onclick=()=>{if(!ensureReady())return;cancelProfileDeletion();resetProfileForm();$('userMessage').textContent='';renderUsers();$('usersDialog').showModal()};
$('usersDialog').addEventListener('close',cancelProfileDeletion);
$('profileDeleteCancel').onclick=cancelProfileDeletion;
$('profileDeleteAccept').onclick=async()=>{
 const id=profileDeletingId,button=$('profileDeleteAccept');if(!id||button.disabled)return;
 button.disabled=true;$('profileDeleteError').textContent='';
 try{
  await Promise.all([waitForReaderSaves(),draftQueue]);
  const next=structuredClone(appState),profile=next.profiles.find(p=>p.id===id);
  if(!profile||next.profiles.length<=1)throw new Error('请至少保留一个用户。');
  const active=next.activeId===id;
  next.profiles=next.profiles.filter(p=>p.id!==id);
  if(active)next.activeId=next.profiles[0].id;
  await commitState(next,[],[keyPrefixRange(fileKey(id,''))],[
   draftStorageKey(id),keyPrefixRange(annotationKey(id,'')),keyPrefixRange(videoFrameNotesKey(id,'')),keyPrefixRange('thumbnail/v1/'+id+'/')
  ]);
  try{
   const prefix=checkpointKey(id,'');
   for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith(prefix))localStorage.removeItem(key)}
   localStorage.removeItem('analog-ai-settings/'+id);localStorage.removeItem('analog-last-export/'+id);
  }catch{}
  aiCredentials.delete(id);cancelProfileDeletion();resetProfileForm();
  if(active){updateIdentity();switchView('all');$('reminderInput').value=''}
  renderUsers();$('userMessage').textContent='已删除「'+profile.name+'」。'+(active?' 当前用户为「'+activeProfile().name+'」。':'');
 }catch(error){$('profileDeleteError').textContent=error.message}
 finally{button.disabled=false}
};
$('cancelProfileEdit').onclick=resetProfileForm;
$('profileForm').onsubmit=async e=>{
 e.preventDefault();$('saveProfile').disabled=true;
 try{
  const name=$('profileName').value.trim(),role=$('profileRole').value.trim();if(!name)throw new Error('请输入用户名称。');
  if(appState.profiles.some(p=>p.name===name&&p.id!==profileEditing))throw new Error('已有同名用户，请换一个名称。');
  const next=structuredClone(appState),adding=!profileEditing;
  if(profileEditing){const p=next.profiles.find(p=>p.id===profileEditing);p.name=name;p.role=role}
  else{const id=crypto.randomUUID();next.profiles.push({id,name,role,topics:[...DEFAULT_TOPICS],records:[],categories:categoryDefaults(),journalLayoutVersion:1,planLayoutVersion:1});next.activeId=id}
  await commitState(next);updateIdentity();switchView('all');renderUsers();resetProfileForm();$('userMessage').textContent=adding?'用户已添加，已切换到新用户。':'资料已更新。';
 }catch(error){$('userMessage').textContent=error.message}finally{$('saveProfile').disabled=false}
};

function resetAttachments(note){draftAttachments=structuredClone(note?.attachments||[]);stagedFiles=new Map();$('attachmentInput').value='';renderDraftAttachments()}
function renderDraftAttachments(){
 $('draftFiles').innerHTML=draftAttachments.map(a=>'<div class="file-row"><span class="file-label">📎 '+esc(a.name)+'<small>'+sizeLabel(a.size)+(stagedFiles.has(a.id)?' · 待保存':a.webRole?' · 离线网页缓存':' · 已归档')+'</small></span>'+(a.webRole?'':'<button type="button" class="danger" data-remove-file="'+a.id+'">移除</button>')+'</div>').join('');
 $('draftFiles').querySelectorAll('button').forEach(b=>b.onclick=()=>{draftAttachments=draftAttachments.filter(a=>a.id!==b.dataset.removeFile);stagedFiles.delete(b.dataset.removeFile);removeInlineReference(b.dataset.removeFile);renderDraftAttachments()});
}
$('addAttachments').onclick=()=>$('attachmentInput').click();
$('attachmentInput').onchange=e=>{try{const files=[...e.target.files];if(files.some(f=>f.size>MAX_FILE))throw new Error('单个附件不能超过 2 GB，本次选择未添加。');if(files.length+draftAttachments.length>MAX_ATTACHMENTS)throw new Error('每条记录最多添加 '+MAX_ATTACHMENTS+' 个附件。');for(const f of files){const a=attachmentFromFile(f);draftAttachments.push(a);stagedFiles.set(a.id,f)}$('formMessage').textContent='';renderDraftAttachments()}catch(error){$('formMessage').textContent=error.message}finally{e.target.value=''}};
function fileIsPdf(a){return /\.pdf$/i.test(a.name)||a.mime==='application/pdf'}
function fileIsImage(a){return ['image/png','image/jpeg','image/webp','image/gif','image/bmp'].includes(a.mime)}
function requiresExternalReader(a,size=a.size){
 if(fileIsPdf(a))return size>MAX_PDF_PREVIEW;
 return size>MAX_DOCUMENT_PREVIEW&&(fileIsPresentation(a)||fileIsDocx(a));
}
function renderDetailAttachments(note){
 const attachments=note.attachments||[],details=$('detailContent');
 const legacyPpt=attachments[0]&&/\.pptx$/i.test(attachments[0].name)&&attachments.some(file=>file.inlineImage);
 const inlineIds=legacyPpt?new Set([...details.querySelectorAll('.detail-body [data-image-id]')].map(image=>image.dataset.imageId)):null;
 const files=attachments.filter(file=>!file.inlineImage||!inlineIds?.has(file.id));
 if(!files.length)return;
 const node=document.createElement('section');node.id='detailFiles';
 node.innerHTML='<p class="file-summary">附件资料 · '+files.length+' 个文件</p>'+files.map(a=>{
  const label=requiresExternalReader(a)?'':fileIsPresentation(a)?'预览 PPT':fileIsPdf(a)?'预览 PDF':fileIsDocx(a)?'预览 DOCX':fileIsVideo(a)||fileIsAudio(a)?'播放':fileIsImage(a)?'查看原图':'';
  return '<div class="file-row"><span class="file-label">📎 '+esc(a.name)+'<small>'+sizeLabel(a.size)+' · '+esc(names[note.type])+' / '+esc(note.title)+'</small></span>'+(label?'<button class="secondary" data-open-attachment="'+a.id+'">'+label+'</button>':'')+'<button class="secondary" data-download-attachment="'+a.id+'">下载</button></div>';
 }).join('');
 if(files.some(a=>fileIsPresentation(a)||fileIsPdf(a)||fileIsDocx(a)))details.insertBefore(node,details.querySelector('.detail-body'));
 else details.append(node);
 node.querySelectorAll('[data-open-attachment]').forEach(b=>b.onclick=()=>openAttachment(files.find(a=>a.id===b.dataset.openAttachment)));
 node.querySelectorAll('[data-download-attachment]').forEach(b=>b.onclick=async()=>{try{downloadBlob(b.dataset.downloadAttachment&&files.find(a=>a.id===b.dataset.downloadAttachment).name,await readBlob(b.dataset.downloadAttachment))}catch(e){toast(e.message)}});
}
function downloadBlob(name,blob){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),60000)}
async function openAttachment(a){
 try{
  const profile=appState.activeId,raw=await readBlob(a.id,profile);
  if(appState.activeId!==profile||$('reader').open)return;
  discardMinimizedWorkspaceDialog('reader');
  if(requiresExternalReader(a,raw.size)){downloadBlob(a.name,raw);return}
  if(fileIsImage(a)){await showOriginalBlob(a,raw);return}
  if(fileIsPresentation(a)){
   readerFile={id:a.id,name:a.name,blob:raw};$('readerTitle').textContent=a.name;
   await openPresentationAttachment(a,raw);return;
  }
  if(fileIsPdf(a)||fileIsVideo(a)){
   await openReadableAttachment(a,raw);return;
  }
  if(fileIsAudio(a)||fileIsDocx(a)){
   readerFile={id:a.id,name:a.name,blob:raw};$('readerTitle').textContent=a.name;
   const panel=document.createElement('div');panel.className='modalbody';$('readerContent').replaceChildren(panel);$('reader').showModal();
   if(fileIsAudio(a)){
    const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';
    readerUrl=URL.createObjectURL(new Blob([raw],{type:/\.mp3$/i.test(a.name)?'audio/mpeg':a.mime}));audio.src=readerUrl;
    panel.append(audio);
   }else{
    panel.classList.add('rich-content');panel.textContent='正在读取 DOCX 正文…';
    try{panel.innerHTML=await readDocxHtml(raw)||'<p>文档中没有可显示的正文。</p>'}catch(error){panel.textContent=error.message}
   }
   return;
  }
  downloadBlob(a.name,raw);
 }catch(error){toast(error.message)}
}
$('readerDownload').onclick=()=>{if(readerFile)downloadBlob(readerFile.name,readerFile.blob)};
$('reader').addEventListener('close',()=>{$('readerContent').replaceChildren();if(readerUrl)URL.revokeObjectURL(readerUrl);readerUrl=null;readerFile=null});
function confirmWorkspaceDeletion(message){
 const detail=$('detail');
 if(detail.open){
  const panel=$('detailDeleteConfirm'),actions=$('detailActions'),cancel=$('detailDeleteCancel'),accept=$('detailDeleteAccept');
  const events=new AbortController(),{signal}=events;
  $('detailDeleteText').textContent=message;actions.hidden=true;panel.hidden=false;cancel.focus();
  return new Promise(resolve=>{
   const finish=confirmed=>{events.abort();panel.hidden=true;actions.hidden=false;resolve(confirmed)};
   cancel.addEventListener('click',()=>finish(false),{signal});
   accept.addEventListener('click',()=>finish(true),{signal});
   detail.addEventListener('cancel',event=>{event.preventDefault();finish(false)},{signal});
   detail.addEventListener('close',()=>finish(false),{signal});
  });
 }
 const dialog=$('deleteConfirmDialog');
 if(dialog.open)return Promise.resolve(false);
 $('deleteConfirmText').textContent=message;dialog.returnValue='cancel';dialog.showModal();
 return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='delete'),{once:true}));
}
async function deleteWorkspaceRecords(ids){
 const profileId=appState.activeId,requested=new Set(ids),targets=records.filter(note=>requested.has(note.id));
 if(!targets.length)throw new Error('找不到要删除的记录，请刷新后重试。');
 const targetIds=new Set(targets.map(note=>note.id)),resources=targets.every(note=>note.type==='resource');
 const label=resources?' 份资料':' 条记录',linked=records.filter(note=>!targetIds.has(note.id)&&note.relatedResources?.some(id=>targetIds.has(id))).length;
 const description=targets.length===1?'「'+targets[0].title+'」':targets.length+label;
 if(!await confirmWorkspaceDeletion('删除'+description+'？会先移入回收站，30 天内可恢复。'+(linked?'\n'+linked+' 条关联笔记将保留，所选资料的链接会移除。':'')))return false;
 await waitForReaderSaves();
 if(appState.activeId!==profileId)throw new Error('用户已切换，请重新选择要删除的资料。');
 lastTrashAction={profileId,ids:[...targetIds]};
 await removeWorkspaceRecords(targetIds);
 toast('已移入回收站 · '+targets.length+label,{label:'撤销',run:undoLastTrash});return true;
}
async function removeWorkspaceRecords(targetIds,aiTask){
 // Moved to trash.js: deletion lands in the recycle bin (attachments kept).
 throw new Error('回收站模块未加载，请重新打开页面。');
}
$('deleteBtn').onclick=async()=>{
 $('deleteBtn').disabled=true;$('detailDeleteError').textContent='';
 try{if(await deleteWorkspaceRecords([current])){$('detail').close();render()}}
 catch(e){$('detailDeleteError').textContent=e.message}finally{$('deleteBtn').disabled=false}
};

const safeSegment=s=>String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,90).replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i,'_$1$2')||'未命名';
function attachmentPath(p,n,a){const label=n.type==='resource'?(p.navLabels?.library||'文献与媒体库'):(p.categories?.find(c=>c.id===n.type)?.name||n.type);return '资料/'+safeSegment(p.name)+'-'+p.id.slice(0,8)+'/'+safeSegment(label)+'/'+safeSegment(n.title)+'-'+n.id+'/'+a.id+'-'+safeFileName(a.name)}
const textEncoder=new TextEncoder();
async function blobToBase64(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(r.error);r.readAsDataURL(blob)})}
function decodeBase64(text,mime,expected){if(typeof text!=='string'||text.length>Math.ceil(MAX_FILE/3)*4||text.length%4!==0||/[^A-Za-z0-9+/=]/.test(text)||!/^[^=]*={0,2}$/.test(text))throw new Error('附件编码无效。');const binary=atob(text);if(binary.length!==expected)throw new Error('附件大小与备份不一致。');const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return new Blob([bytes],{type:mime})}
function validateAttachment(a){return a&&typeof a.id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(a.id)&&typeof a.name==='string'&&a.name.length>0&&a.name.length<=500&&typeof a.mime==='string'&&a.mime.length<=150&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size<=MAX_FILE}
async function collectBackup(includeData,{large=false,onProgress}={}){
 const exportingProfileId=appState.activeId;
 await waitForReaderSaves();
 if(exportingProfileId!==appState.activeId)throw new Error('导出期间用户已变化，请在当前用户下重新导出。');
 const p=structuredClone(activeProfile()),files=[];
 let attachmentBytes=0;
 for(const note of p.records)for(const a of note.attachments||[])attachmentBytes+=includeData?Math.ceil(a.size/3)*4:a.size;
 if(!large&&attachmentBytes>MAX_BACKUP)throw new Error('附件超出备份文件容量。桌面版请完全退出软件，再复制「设置」中显示的资料目录进行备份。');
 for(const note of p.records){for(const a of note.attachments||[]){const blob=await readBlob(a.id,p.id);if(blob.size!==a.size)throw new Error('附件大小异常：'+a.name);a.annotations=await fileAnnotations(p.id,a);if(fileIsVideo(a)){const frames=await fileVideoFrameNotes(p.id,a);if(frames.length)a.videoFrameNotes=frames;else delete a.videoFrameNotes}a.sha256=await fileDigest(blob,(done,total)=>onProgress?.(a.name,done,total));a.path=attachmentPath(p,note,a);if(includeData)a.data=await blobToBase64(blob);files.push({path:a.path,blob})}}
 return {backup:{format:'analog-notes',version:2,exportedAt:new Date().toISOString(),profile:{name:p.name,role:p.role,topics:p.topics,categories:p.categories,journalLayoutVersion:p.journalLayoutVersion,planLayoutVersion:p.planLayoutVersion,navLabels:p.navLabels,navDescriptions:p.navDescriptions||{},reading:p.reading,reminders:p.reminders||[],readingLists:p.readingLists||[],folders:p.folders||[],dashboardWidgets:dashboardWidgetsFor(p),dashboardWidgetLayoutVersion:1},records:p.records},files};
}
function markdown(note){return '# '+note.title+'\n\n'+note.date+' · '+names[note.type]+' · '+note.status+'\n\n标签：'+note.tags.join(' / ')+'\n\n'+(note.reference?note.reference+'\n\n':'')+(note.url?note.url+'\n\n':'')+(note.bodyHtml?noteBodyHtml(note):note.body)+'\n\n'+(note.attachments?.length?'附件：\n'+note.attachments.map(a=>'- '+a.name+' ('+sizeLabel(a.size)+')').join('\n'):'')}
function offlineIndex(backup){
 const names=Object.fromEntries([...(backup.profile.categories||categoryDefaults()),{id:'resource',name:backup.profile.navLabels?.library||'文献与媒体库'}].map(c=>[c.id,c.name])),templates=names;
 const link=p=>p.split('/').map(encodeURIComponent).join('/');
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DoNote · 离线阅读 · '+esc(backup.profile.name)+'</title><link rel="icon" href="'+document.querySelector('link[rel=icon]').href+'"><style>body{max-width:1000px;margin:40px auto;padding:0 22px;background:#f6f6f6;color:#202020;font:15px system-ui;line-height:1.9}article{background:white;padding:24px;border:1px solid #dedede;border-radius:8px;margin:18px 0}h1{font-size:28px}h2{font-size:19px}h3{font-size:17px}a{color:#303030;overflow-wrap:anywhere}small,p.meta{color:#626262}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}nav{display:flex;gap:20px;flex-wrap:wrap}.rich-content{display:flow-root;white-space:pre-wrap;overflow-wrap:anywhere;font-size:1rem;line-height:1.75}.rich-content div,.rich-content p{margin:0}</style><h1>DoNote · 离线阅读</h1><p>'+esc(backup.profile.name)+'</p><p class="meta">导出时间：'+esc(backup.exportedAt)+'<br>此文件夹为导出时的快照；可直接打开附件，不依赖浏览器记录库。恢复记录时请导入完整 ZIP 或自包含的 JSON 备份。ZIP 内的 backup.json 必须与原件一起使用。</p><nav>'+Object.entries(names).filter(([k])=>k in templates).map(([k,v])=>'<a href="#'+k+'">'+esc(v)+'</a>').join('')+'</nav>'+Object.keys(templates).map(type=>'<section id="'+type+'"><h2>'+esc(names[type])+'</h2>'+backup.records.filter(n=>n.type===type).map(n=>'<article><small>'+esc(n.date)+' · '+esc(n.status)+'</small><h3>'+esc(n.title)+'</h3><p class="meta">'+esc(n.tags.join(' / '))+'</p>'+(n.reference?'<p>'+esc(n.reference)+'</p>':'')+'<div class="rich-content">'+offlineNoteHtml(n)+'</div>'+(n.attachments||[]).map(a=>'<p>📎 <a href="'+link(a.path)+'" target="_blank" rel="noopener">'+esc(a.name)+'</a> <small>'+sizeLabel(a.size)+'</small></p>').join('')+'</article>').join('')+'</section>').join('')+'</html>';
}
async function folderContents(includeData=true,options){
 // JSON remains fully self-contained when separated from the exported directory.
 const {backup,files}=await collectBackup(includeData,options);
 return [{path:'backup.json',blob:new Blob([JSON.stringify(backup)],{type:'application/json'})},{path:'离线阅读.html',blob:new Blob([offlineIndex(backup)],{type:'text/html;charset=utf-8'})},...files,...backup.records.map(n=>({path:'笔记/'+safeSegment(names[n.type]||n.type)+'/'+safeSegment(n.title)+'-'+n.id+'.md',blob:new Blob([markdown(n)],{type:'text/markdown;charset=utf-8'})}))];
}
async function withExport(button,action){if(!ensureReady())return;const original=button.textContent;button.disabled=true;button.textContent='正在整理…';$('importMessage').textContent='';try{await action()}catch(e){if(e.name!=='AbortError')$('importMessage').textContent=e.message}finally{button.disabled=false;button.textContent=original}}
$('exportJson').onclick=()=>withExport($('exportJson'),async()=>{const {backup}=await collectBackup(true);downloadBlob('analog-notes-'+safeSegment(activeProfile().name)+'-'+today()+'.json',new Blob([JSON.stringify(backup)],{type:'application/json'}));toast('完整备份已导出，包含附件')});
$('exportMd').onclick=()=>{if(!ensureReady())return;download('analog-notes-'+today()+'.md',"# DoNote · "+activeProfile().name+'\n\n'+records.map(markdown).join('\n\n---\n\n'),'text/markdown');toast('Markdown 已导出；完整附件请使用资料夹导出')};
$('exportFolder').onclick=()=>withExport($('exportFolder'),async()=>{const files=await folderContents(false),zip=new JSZip();for(const f of files)zip.file(f.path,f.blob);downloadBlob('AnalogNotes-'+safeSegment(activeProfile().name)+'-'+today()+'.zip',await zip.generateAsync({type:'blob',compression:'STORE'}));toast('离线资料夹已导出，解压后打开「离线阅读.html」')});
$('writeFolder').onclick=()=>withExport($('writeFolder'),async()=>{
 const root=await window.showDirectoryPicker({mode:'readwrite'}),folder=await root.getDirectoryHandle('AnalogNotes-'+safeSegment(activeProfile().name)+'-'+today()+'-'+Date.now(),{create:true});
 const message=$('importMessage');
 const files=await folderContents(false,{large:true,onProgress:(name,done,total)=>{
  message.textContent='正在校验 '+name+' · '+sizeLabel(done)+' / '+sizeLabel(total);
 }});
 files.push(files.shift()); // Publish the restore manifest only once the other files are complete.
 let written=0;
 try{for(const f of files){const parts=f.path.split('/');let dir=folder;for(const s of parts.slice(0,-1))dir=await dir.getDirectoryHandle(s,{create:true});const target=await dir.getFileHandle(parts.at(-1),{create:true}),writer=await target.createWritable();try{for(let offset=0;offset<f.blob.size;offset+=4*1024**2){
 const chunk=f.blob.slice(offset,offset+4*1024**2);
 await writer.write(await chunk.arrayBuffer());
 message.textContent='正在备份 '+(written+1)+' / '+files.length+' · '+f.path+' · '+sizeLabel(offset+chunk.size)+' / '+sizeLabel(f.blob.size);
 }await writer.close()}catch(e){await writer.abort().catch(()=>{});throw e}written++}}catch(e){throw new Error('资料夹未完整保存（已写入 '+written+'/'+files.length+' 个文件）。请重新导出。'+e.message)}
 $('importMessage').textContent='已保存到 '+folder.name+'。打开里面的「离线阅读.html」即可浏览。';toast('资料夹已保存到电脑');
});

async function readBackup(file){
 if(file.size>MAX_BACKUP)throw new Error('备份过大，请选择 500 MB 以内的文件。');
 if(!/\.zip$/i.test(file.name))return {backup:JSON.parse(await file.text()),zip:null};
 const zip=await JSZip.loadAsync(file),entry=zip.file('backup.json');
 if(!entry)throw new Error('ZIP 中没有 backup.json。');
 return {backup:JSON.parse(await entry.async('string')),zip};
}

function validateBackup(backup){
 if(!backup||backup.format!=='analog-notes'||![1,2].includes(backup.version)
  ||!Array.isArray(backup.records)||backup.records.some(note=>!validate(note))
  ||new Set(backup.records.map(note=>note.id)).size!==backup.records.length){
  throw new Error('备份格式无效，请选择本工作台导出的 JSON 或 ZIP。');
 }
 const profile=backup.profile||{};
 if(backup.version===2&&(!Array.isArray(profile.topics)||profile.topics.length>MAX_TOPICS
  ||profile.topics.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>MAX_TOPIC_LENGTH)))throw new Error('研究方向数据无效。');
 if(profile.navLabels&&!validNavLabels(profile.navLabels))throw new Error('导航名称无效。');
 if(profile.categories&&!validCategories(profile.categories))throw new Error('栏目配置无效。');
 if(profile.reminders!==undefined&&!validReminders(profile.reminders))throw new Error('临时提醒格式无效。');
 if(profile.readingLists!==undefined&&!validReadingLists(profile.readingLists))throw new Error('阅读清单格式无效。');
 if((profile.dashboardWidgets!==undefined&&!validDashboardWidgets(profile.dashboardWidgets))
  ||(profile.dashboardWidgetLayoutVersion!==undefined&&profile.dashboardWidgetLayoutVersion!==1))throw new Error('总览组件配置无效。');
 if(profile.navDescriptions!==undefined&&!validNavDescriptions(profile.navDescriptions))throw new Error('栏目说明格式无效。');
 if(profile.folders!==undefined&&!validRecordFolders(profile.folders))throw new Error('文件夹格式无效。');
}

async function readBackupAttachment(attachment,zip,onProgress){
 const {data,mime,size,path,name,sha256}=attachment;
 let blob;
 if(typeof data==='string'){
  blob=decodeBase64(data,mime,size);
 }else if(zip?.directory){
  blob=await openLargeBackupFile(zip.directory,path);
  if(blob.size!==size)throw new Error('附件大小与备份不一致：'+name);
  if(typeof sha256!=='string')throw new Error('大文件备份缺少附件校验值：'+name);
 }else{
  const entry=typeof path==='string'?zip?.file(path):null;
  if(!entry)throw new Error('备份缺少附件：'+name);
  blob=await entry.async('blob');
  if(blob.size!==size)throw new Error('ZIP 附件大小不一致。');
 }
 if(sha256!==undefined&&(!/^[a-f0-9]{64}$/.test(sha256)||await fileDigest(blob,(done,total)=>onProgress?.(name,done,total))!==sha256)){
  throw new Error('附件完整性校验失败：'+name+'，未导入任何更改。');
 }
 return blob;
}

async function stageBackupRecords(sourceRecords,zip,profile,onProgress){
 const existingIds=new Set(profile.records.map(note=>note.id)),seenAttachments=new Set(),entries=[],restoredIds=new Map();
 for(const original of sourceRecords){
  if(existingIds.has(original.id))continue;
  const note=normalizeRichNote(structuredClone(original)),imageIds=new Map(),writes=[];
  note.attachments=note.attachments||[];
  if(!Array.isArray(note.attachments)||note.attachments.length>MAX_ATTACHMENTS||note.attachments.some(a=>!validateAttachment(a)))throw new Error('附件信息无效，或数量超过 '+MAX_ATTACHMENTS+' 个。');
  if(!validWebArticle(note))throw new Error('网页收藏或标注信息无效。');
  for(const attachment of note.attachments){
   if(attachment.annotations!==undefined)attachment.annotations=checkedAnnotations(attachment.annotations);
   if(attachment.videoFrameNotes!==undefined)attachment.videoFrameNotes=checkedVideoFrameNotes(attachment.videoFrameNotes);
   const oldId=attachment.id;
   if(seenAttachments.has(oldId))throw new Error('附件编号重复。');
   seenAttachments.add(oldId);
   const blob=await readBackupAttachment(attachment,zip,onProgress);
   attachment.id=crypto.randomUUID();
   imageIds.set(oldId,attachment.id);restoredIds.set(oldId,attachment.id);
   delete attachment.data;
   delete attachment.path;
   writes.push({key:fileKey(profile.id,attachment.id),blob});
  }
  if(note.videoSubtitles&&typeof note.videoSubtitles==='object'){
   const remapped={};
   for(const [oldId,cues] of Object.entries(note.videoSubtitles)){const id=imageIds.get(oldId);if(id&&Array.isArray(cues))remapped[id]=cues}
   note.videoSubtitles=remapped;
  }
  if(note.bodyHtml){
   const doc=document.createElement('template');
   doc.innerHTML=note.bodyHtml;
   for(const slot of doc.content.querySelectorAll('[data-image-id]')){
    const id=imageIds.get(slot.dataset.imageId);
    if(id)slot.dataset.imageId=id;
   }
   note.bodyHtml=safeRichHtml(doc.innerHTML);
  }
  validateInlineReferences(note);
  entries.push({note,writes,attachmentIds:imageIds});
 }
 for(const {note} of entries){
  for(const source of [note.pdfSource,...(note.pdfEvidence||[])].filter(Boolean)){
   if(restoredIds.has(source.fileId))source.fileId=restoredIds.get(source.fileId);
  }
 }
 return entries;
}

function mergeBackupProfile(profile,source,incoming){
 const wasEmpty=profile.records.length===0;
 mergeImportedRecordFolders(profile,source.folders,incoming);
 profile.records.push(...incoming);
 mergeImportedReadingLists(profile,source.readingLists);
 if(wasEmpty&&source.categories)profile.categories=source.categories;
 if(wasEmpty&&source.navLabels)profile.navLabels=source.navLabels;
 if(wasEmpty&&source.navDescriptions)profile.navDescriptions=source.navDescriptions;
 if(wasEmpty&&source.dashboardWidgets){
  profile.dashboardWidgets=source.dashboardWidgets;
  if(source.dashboardWidgetLayoutVersion===1)profile.dashboardWidgetLayoutVersion=1;
  else delete profile.dashboardWidgetLayoutVersion;
 }
 for(const category of source.categories||[]){
  if(!profile.categories.some(current=>current.id===category.id))profile.categories.push(category);
 }
 for(const note of incoming){
  if(note.type==='resource'||profile.categories.some(category=>category.id===note.type))continue;
  if(note.type==='custom-achievement'&&note.flashcardKind==='analog-v1')continue;
  const fallback=BASE_CATEGORY_DATA.find(category=>category.id===note.type);
  if(!fallback)throw new Error('备份缺少自定义栏目的配置。');
  profile.categories.push(structuredClone(fallback));
 }
 if(profile.categories.length>30)throw new Error('合并后的栏目超过 30 个，请先精简栏目。');
 for(const {id} of incoming){
  if(Object.hasOwn(source.reading||{},id))profile.reading[id]=sanitizeReadingProgress(source.reading[id]);
 }
 profile.topics=[...new Set([...profile.topics,...(source.topics||incoming.flatMap(note=>note.tags))])].slice(0,MAX_TOPICS);
 if(source.reminders?.length){
  profile.reminders??=[];
  profile.reminders.push(...source.reminders.filter(item=>!profile.reminders.some(old=>old.id===item.id)));
  if(profile.reminders.length>MAX_REMINDERS)throw new Error('合并后的提醒超过 '+MAX_REMINDERS+' 项，请先清理已完成的事项。');
 }
}

$('importBtn').onclick=()=>{if(ensureReady())$('importFile').click()};
$('importFile').onchange=async event=>{
 const input=event.target,file=input.files[0];
 if(!file)return;
 await restoreWorkspaceBackup(()=>readBackup(file),$('importBtn'));
 input.value='';
};
function backupContentSignature(note){
 const attachments=(note.attachments||[]).map(a=>[a.name,a.size,a.mime].join('|')).sort().join('\n');
 return [note.type,note.title.trim(),note.date,note.author||'',note.body||'',attachments].join('\u001f');
}
function analyzeBackupDuplicates(sourceRecords,profile){
 const ids=new Set(profile.records.map(note=>note.id)),signatures=new Set(profile.records.map(backupContentSignature));
 const records=[];let existing=0,content=0;
 for(const note of sourceRecords){
  if(ids.has(note.id)){existing++;continue}
  const signature=backupContentSignature(note);
  if(signatures.has(signature)){content++;continue}
  ids.add(note.id);signatures.add(signature);records.push(note);
 }
 return {records,existing,content};
}
async function ensureBackupImportSpace(backup){
 const bytes=backup.records.reduce((sum,note)=>sum+(note.attachments||[]).reduce((part,a)=>part+(Number(a.size)||0),0),0);
 const required=bytes+512*1024**2;
 let quotaFree=Infinity;
 try{
  const estimate=await navigator.storage?.estimate?.();
  if(estimate&&Number.isFinite(estimate.quota)&&Number.isFinite(estimate.usage))quotaFree=estimate.quota-estimate.usage;
 }catch{}
 if(quotaFree<required)throw new Error('本机资料存储空间不足。附件需要约 '+sizeLabel(bytes)+'，当前可用配额约 '+sizeLabel(Math.max(0,quotaFree))+'。');
 let diskFree=-1;
 try{diskFree=Number((await window.desktopLargeBackup?.freeBytes?.())?.freeBytes)}catch{}
 if(Number.isFinite(diskFree)&&diskFree>=0&&diskFree<required)
  throw new Error('资料所在磁盘空间不足。附件需要约 '+sizeLabel(bytes)+'，当前可用 '+sizeLabel(diskFree)+'。');
 return {bytes,quotaFree,diskFree};
}
 async function restoreWorkspaceBackup(read,button){
 const profileId=appState.activeId,message=$('importMessage');
 button.disabled=true;
 try{
  const {backup,zip}=await read();
  validateBackup(backup);
  if(profileId!==appState.activeId)throw new Error('当前用户已变化，请重新导入。');
  const source=structuredClone(backup.profile||{});
  if(source.categories){upgradeJournalCategories(source);upgradePlanCategory(source)}
  const duplicates=analyzeBackupDuplicates(backup.records,activeProfile());
  if(!duplicates.records.length){
   message.textContent='没有需要导入的新记录：'+duplicates.existing+' 条编号重复，'+duplicates.content+' 条内容相同。';
   return;
  }
  const space=await ensureBackupImportSpace({...backup,records:duplicates.records});
  const skipped=duplicates.existing+duplicates.content;
  if(!confirm('将向「'+activeProfile().name+'」导入 '+duplicates.records.length+' 条记录及其附件。\n跳过 '+skipped+' 条重复记录（编号重复 '+duplicates.existing+' 条，内容相同 '+duplicates.content+' 条）。\n附件约 '+sizeLabel(space.bytes)+'，已通过空间检查。是否继续？'))return;
  message.textContent='空间检查通过，正在验证备份文件…';
  const staged=await stageBackupRecords(duplicates.records,zip,activeProfile(),(name,done,total)=>{
   message.textContent='正在验证 '+name+' · '+sizeLabel(done)+' / '+sizeLabel(total);
  });
  if(profileId!==appState.activeId)throw new Error('当前用户已变化，请重新导入。');

  // A record can be saved while attachment decoding is in progress.
  const next=structuredClone(appState),profile=next.profiles.find(entry=>entry.id===profileId);
  const existingIds=new Set(profile.records.map(note=>note.id));
  const entries=staged.filter(({note})=>!existingIds.has(note.id));
  const incoming=entries.map(({note})=>note),finalSkipped=backup.records.length-incoming.length;

  mergeBackupProfile(profile,source,incoming);
  for(const {attachmentIds} of entries){
   for(const [oldId,newId] of attachmentIds){
    if(Object.hasOwn(source.reading||{},oldId))profile.reading[newId]=sanitizeReadingProgress(source.reading[oldId]);
   }
  }
  message.textContent='校验通过，正在保存记录和附件…';
  await commitState(next,entries.flatMap(({writes})=>writes));
  render();
  message.textContent='导入完成：新增 '+incoming.length+' 条，跳过 '+finalSkipped+' 条重复记录；附件已恢复。';
  toast('记录与附件已恢复');
 }catch(error){
  message.textContent='导入未完成，原记录未修改。'+error.message;
 }finally{
  button.disabled=false;
 }
}
// These dialogs are added after the original core controls.
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{if(!busy)$(b.dataset.close).close()});
load().then(()=>initializeReliability());
