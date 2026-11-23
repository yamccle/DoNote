'use strict';

const MAX_READING_LISTS=200,MAX_READING_LIST_ITEMS=10000;
const libraryNoteType=note=>note.type==='resource'||note.type==='paper';
let readingListProfileId=null,readingListId='',editingReadingListId='',organizationTarget=null;
let filteredReadingListMembers=null,filteredReadingListSet=new Set();

function validReadingLists(lists){
 const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(id);
 return Array.isArray(lists)&&lists.length<=MAX_READING_LISTS&&lists.every(list=>
  list&&validId(list.id)&&typeof list.name==='string'&&!!list.name.trim()&&list.name.length<=60
  &&Array.isArray(list.recordIds)&&list.recordIds.length<=MAX_READING_LIST_ITEMS&&list.recordIds.every(validId)
  &&new Set(list.recordIds).size===list.recordIds.length
 )&&new Set(lists.map(list=>list.id)).size===lists.length;
}
function pruneReadingLists(profile){
 if(!profile.readingLists?.length)return;
 const ids=new Set(profile.records.filter(libraryNoteType).map(note=>note.id));
 for(const list of profile.readingLists)list.recordIds=list.recordIds.filter(id=>ids.has(id));
}
function mergeImportedReadingLists(profile,lists){
 if(!lists?.length)return;
 profile.readingLists??=[];
 const ids=new Set(profile.records.filter(libraryNoteType).map(note=>note.id));
 for(const list of lists){
  const existing=profile.readingLists.find(item=>item.id===list.id);
  const members=list.recordIds.filter(id=>ids.has(id));
  if(existing)existing.recordIds=[...new Set([...existing.recordIds,...members])];
  else profile.readingLists.push({...list,recordIds:members});
 }
 if(!validReadingLists(profile.readingLists))throw new Error('合并后的阅读清单超出数量限制。');
}
function currentReadingList(){
 const profile=activeProfile();
 if(readingListProfileId!==profile?.id){readingListProfileId=profile?.id;readingListId=''}
 const list=profile?.readingLists?.find(item=>item.id===readingListId);
 if(!list)readingListId='';
 return list;
}
function matchesReadingList(id){
 const list=currentReadingList();
 if(!list)return true;
 if(list.recordIds!==filteredReadingListMembers){
  filteredReadingListMembers=list.recordIds;filteredReadingListSet=new Set(list.recordIds);
 }
 return filteredReadingListSet.has(id);
}
function readingListOptions(){
 return (activeProfile()?.readingLists||[]).map(list=>'<option value="'+esc(list.id)+'">'+esc(list.name)+'</option>').join('');
}
function updateLibraryOrganization(){
 const select=$('readingListFilter'),list=currentReadingList();
 const options='<option value="">所有资料</option>'+readingListOptions();
 if(select.dataset.options!==options){select.innerHTML=options;select.dataset.options=options}
 select.value=list?.id||'';
 $('libraryOrganize').disabled=libraryDeleting||!selectedLibraryIds.size;
}
function resetReadingListEditor(){
 editingReadingListId='';$('readingListName').value='';$('readingListSave').textContent='新建清单';$('readingListCancelEdit').hidden=true;
}
function renderReadingListManager(){
 const profile=activeProfile(),ids=new Set(profile.records.filter(libraryNoteType).map(note=>note.id));
 const lists=profile.readingLists||[];
 $('readingListRows').innerHTML=lists.length?lists.map(list=>'<div class="manager-row"><span><span class="profile-name">'+esc(list.name)+'</span><small class="profile-meta">'+list.recordIds.filter(id=>ids.has(id)).length+' 份资料</small></span><button type="button" class="secondary" data-list-open="'+esc(list.id)+'">查看</button><button type="button" class="secondary" data-list-export="'+esc(list.id)+'">导出</button><button type="button" class="secondary" data-list-edit="'+esc(list.id)+'">改名</button><button type="button" class="danger" data-list-delete="'+esc(list.id)+'">删除</button></div>').join(''):'<p class="section-note">创建清单后，在资料库多选卡片并点击「批量整理」即可加入。</p>';
}
function exportReadingList(list){
 const byId=new Map(records.filter(libraryNoteType).map(note=>[note.id,note]));
 const items=list.recordIds.map(id=>byId.get(id)).filter(Boolean);
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>'+esc(list.name)+'</title><style>body{max-width:48rem;margin:4rem auto;padding:0 1.5rem;font:16px/1.65 system-ui,sans-serif;color:#202124}li{margin:0 0 1.25rem;overflow-wrap:anywhere}small{display:block;color:#58595e}a{color:#2556a6}</style><h1>'+esc(list.name)+'</h1><p>Yam\'s ONE · '+items.length+' 份资料</p><ol>'+items.map(note=>{
  const title=esc(note.title),link=note.url&&/^https?:\/\//i.test(note.url)?'<a href="'+esc(note.url)+'" rel="noopener noreferrer">'+title+'</a>':title;
  const details=[note.author,note.status,...note.tags].filter(Boolean).map(esc).join(' · ');
  return '<li>'+link+'<small>'+details+'</small></li>';
 }).join('')+'</ol>';
 downloadBlob(safeFileName(list.name)+'.html',new Blob([html],{type:'text/html;charset=utf-8'}));
}
async function saveReadingList(event){
 event.preventDefault();
 const button=$('readingListSave'),name=$('readingListName').value.trim();
 if(button.disabled||!name)return;
 button.disabled=true;$('readingListMessage').textContent='';
 try{
  const next=structuredClone(appState),p=next.profiles.find(p=>p.id===next.activeId);
  const lists=p.readingLists??=[];
  if(lists.some(list=>list.name.toLowerCase()===name.toLowerCase()&&list.id!==editingReadingListId))throw new Error('这个清单名称已存在。');
  const editing=lists.find(list=>list.id===editingReadingListId);
  if(editing)editing.name=name;
  else{
   if(lists.length>=MAX_READING_LISTS)throw new Error('最多保留 '+MAX_READING_LISTS+' 份阅读清单。');
   lists.push({id:crypto.randomUUID(),name,recordIds:[]});
  }
  await commitState(next);resetReadingListEditor();renderReadingListManager();render();
 }catch(error){$('readingListMessage').textContent=error.message}
 finally{button.disabled=false}
}
async function manageReadingListAction(event){
 const button=event.target.closest('button');if(!button)return;
 const {listOpen,listExport,listEdit,listDelete}=button.dataset;
 const profileId=appState.activeId,id=listOpen||listExport||listEdit||listDelete;
 const list=activeProfile().readingLists?.find(item=>item.id===id);if(!list)return;
 $('readingListMessage').textContent='';
 if(listOpen){
  readingListId=id;$('readingListManager').close();
  topic='';
  for(const filter of ['libraryStatus','libraryKind'])$(filter).value='';
  switchView('resource');return;
 }
 if(listExport){exportReadingList(list);return}
 if(listEdit){
  editingReadingListId=id;$('readingListName').value=list.name;$('readingListSave').textContent='保存名称';$('readingListCancelEdit').hidden=false;$('readingListName').focus();return;
 }
 if(!await confirmWorkspaceDeletion('删除清单「'+list.name+'」？其中的资料仍保留在文献库。')||appState.activeId!==profileId)return;
 try{
  const next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId);
  p.readingLists=(p.readingLists||[]).filter(item=>item.id!==id);
  await commitState(next);
  if(editingReadingListId===id)resetReadingListEditor();
  renderReadingListManager();render();
 }catch(error){$('readingListMessage').textContent=error.message}
}
function openLibraryOrganization(){
 if(!selectedLibraryIds.size||libraryDeleting)return;
 const list=currentReadingList(),dialog=$('libraryOrganizeDialog');
 organizationTarget={profileId:appState.activeId,ids:new Set(selectedLibraryIds),listId:list?.id};
 $('libraryOrganizeForm').reset();
 $('libraryOrganizeIntro').textContent='修改所选的 '+organizationTarget.ids.size+' 份资料。';
 $('libraryOrganizeList').innerHTML='<option value="">不添加</option>'+readingListOptions();
 $('libraryOrganizeFolder').innerHTML='<option value="">保持原位置</option><option value="'+FOLDER_ROOT+'">移到未归档</option>'+recordFolderOptions('resource');
 $('libraryOrganizeList').disabled=!activeProfile().readingLists?.length;
 $('libraryOrganizeRemoveRow').hidden=!list;
 $('libraryOrganizeRemoveLabel').textContent=list?'从「'+list.name+'」移除':'';
 $('libraryOrganizeMessage').textContent='';
 if(!dialog.open)dialog.showModal();
}
const organizationTags=value=>[...new Set(value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean))];
async function saveLibraryOrganization(event){
 event.preventDefault();
 const button=$('libraryOrganizeApply'),message=$('libraryOrganizeMessage'),target=organizationTarget;
 if(button.disabled||!target||libraryDeleting)return;
 button.disabled=true;message.textContent='';
 try{
  const add=organizationTags($('libraryOrganizeAddTags').value),remove=new Set(organizationTags($('libraryOrganizeRemoveTags').value));
  const status=$('libraryOrganizeStatus').value,listId=$('libraryOrganizeList').value;
  const removeFromList=$('libraryOrganizeRemoveList').checked,folder=$('libraryOrganizeFolder').value;
  if(add.some(tag=>tag.length>MAX_TOPIC_LENGTH))throw new Error('每个标签最多 '+MAX_TOPIC_LENGTH+' 个字符。');
  if(add.some(tag=>remove.has(tag)))throw new Error('请分别填写要添加和移除的标签。');
  if(removeFromList&&listId===target.listId)throw new Error('请选择不同的清单来添加和移除。');
  if(!add.length&&!remove.size&&!status&&!listId&&!removeFromList&&!folder){$('libraryOrganizeDialog').close();return}
  await Promise.all([readingSaveQueue,annotationQueue]);
  if(appState.activeId!==target.profileId)throw new Error('用户已切换，请重新选择资料。');
  const next=structuredClone(appState),p=next.profiles.find(p=>p.id===target.profileId);
  const selected=p.records.filter(note=>target.ids.has(note.id)&&libraryNoteType(note));
  if(selected.length!==target.ids.size)throw new Error('部分资料已变化，请重新选择。');
  if(status&&selected.some(note=>!statusOptions[note.type]?.includes(status)))throw new Error('部分资料不支持所选状态，请选择状态一致的资料。');
  if(folder&&folder!==FOLDER_ROOT&&!scopedFolderId('resource',folder,p))throw new Error('目标文件夹已变化。');
  const oldList=p.readingLists?.find(list=>list.id===target.listId),newList=p.readingLists?.find(list=>list.id===listId);
  if(listId&&!newList||removeFromList&&!oldList)throw new Error('清单已变化，请重新选择。');
  if(newList){
   newList.recordIds=[...new Set([...newList.recordIds,...target.ids])];
   if(newList.recordIds.length>MAX_READING_LIST_ITEMS)throw new Error('每份清单最多添加 '+MAX_READING_LIST_ITEMS+' 份资料。');
  }
  if(removeFromList)oldList.recordIds=oldList.recordIds.filter(id=>!target.ids.has(id));
  addNewTopicTags(p,add);
  const now=new Date().toISOString(),checkpoints=[];
  for(const note of selected){
   const tags=[...new Set([...note.tags.filter(tag=>!remove.has(tag)),...add])];
   if(tags.length>30)throw new Error('「'+note.title+'」将超过每条记录 30 个标签的限制。');
   if(folder){if(folder===FOLDER_ROOT)delete note.folderId;else note.folderId=folder}
   if(!folder&&!status&&tags.length===note.tags.length&&tags.every((tag,index)=>tag===note.tags[index]))continue;
   note.tags=tags;note.updatedAt=now;
   if(!status)continue;
   note.status=status;
   const old=p.reading?.[note.id]||note.readerProgress,file=note.attachments?.[0];
   if(old||status==='已读'&&file&&(fileIsPdf(file)||fileIsVideo(file))){
    const progress=sanitizeReadingProgress({...old,kind:old?.kind||(file&&fileIsVideo(file)?'video':'pdf'),finished:status==='已读',lastOpened:now});
    p.reading??={};p.reading[note.id]=progress;note.readerProgress=progress;checkpoints.push([note.id,progress]);
   }
  }
  await commitState(next);
  for(const [id,progress] of checkpoints)storeReadingCheckpoint(target.profileId,id,progress);
  $('libraryOrganizeDialog').close();render();toast('已整理 '+selected.length+' 份资料。');
 }catch(error){message.textContent=error.message}
 finally{button.disabled=false}
}
function initializeLibraryOrganization(){
 $('libraryStatus').insertAdjacentHTML('afterend','<select id="readingListFilter" aria-label="按阅读清单筛选"><option value="">所有资料</option></select><button type="button" class="secondary" id="readingListOpen">阅读清单</button>');
 $('libraryDeleteSelected').insertAdjacentHTML('beforebegin','<button type="button" class="secondary" id="libraryOrganize" disabled>批量整理</button>');
 document.body.insertAdjacentHTML('beforeend',`
 <dialog id="readingListManager" aria-labelledby="readingListTitle">
  <div class="modalhead"><h2 id="readingListTitle">阅读清单</h2><button type="button" class="icon-button" data-close="readingListManager" aria-label="关闭">✕</button></div>
  <div class="modalbody">
   <p class="section-note">把文献、网页和媒体放进同一份清单。分享时可导出 HTML 目录，目录包含标题、标签和原文链接，私有附件与离线快照仍留在工作台。</p>
   <form id="readingListForm" class="field topic-editor"><input id="readingListName" maxlength="60" required placeholder="例如：本周待读" aria-label="清单名称"><button type="submit" class="primary" id="readingListSave">新建清单</button><button type="button" class="secondary" id="readingListCancelEdit" hidden>取消</button></form>
   <div id="readingListRows" class="manager-list"></div><p id="readingListMessage" class="form-message" role="status"></p>
  </div>
 </dialog>
 <dialog id="libraryOrganizeDialog" aria-labelledby="libraryOrganizeTitle">
  <form id="libraryOrganizeForm">
   <div class="modalhead"><h2 id="libraryOrganizeTitle">批量整理</h2><button type="button" class="icon-button" data-close="libraryOrganizeDialog" aria-label="关闭">✕</button></div>
   <div class="modalbody">
    <p class="section-note" id="libraryOrganizeIntro"></p>
    <div class="field"><label for="libraryOrganizeAddTags">添加标签</label><input id="libraryOrganizeAddTags" placeholder="用逗号分隔，例如：ADC，噪声"></div>
    <div class="field"><label for="libraryOrganizeRemoveTags">移除标签</label><input id="libraryOrganizeRemoveTags" placeholder="用逗号分隔"></div>
    <div class="field"><label for="libraryOrganizeStatus">阅读状态</label><select id="libraryOrganizeStatus"><option value="">保持原状态</option><option>待读</option><option>在读</option><option>已读</option></select></div>
    <div class="field"><label for="libraryOrganizeFolder">移动到文件夹</label><select id="libraryOrganizeFolder"></select></div>
    <div class="field"><label for="libraryOrganizeList">加入阅读清单</label><select id="libraryOrganizeList"></select></div>
    <p id="libraryOrganizeRemoveRow"><label><input id="libraryOrganizeRemoveList" type="checkbox"> <span id="libraryOrganizeRemoveLabel"></span></label></p>
    <p id="libraryOrganizeMessage" class="form-message" role="status"></p>
   </div>
   <div class="modalfoot"><button type="button" class="secondary" data-close="libraryOrganizeDialog">取消</button><button type="submit" class="primary" id="libraryOrganizeApply">应用修改</button></div>
  </form>
 </dialog>`);
 $('readingListFilter').onchange=event=>{readingListId=event.target.value;render()};
 $('readingListOpen').onclick=()=>{if(!ensureReady())return;resetReadingListEditor();$('readingListMessage').textContent='';renderReadingListManager();$('readingListManager').showModal()};
 $('readingListForm').onsubmit=saveReadingList;
 $('readingListCancelEdit').onclick=resetReadingListEditor;
 $('readingListRows').onclick=manageReadingListAction;
 $('libraryOrganize').onclick=openLibraryOrganization;
 $('libraryOrganizeForm').onsubmit=saveLibraryOrganization;
}
initializeLibraryOrganization();

function groupLibraryToolbar(){
 const controls=$('libraryControls');
 const groups=[
  {id:'libraryAdd',label:'添加',primary:true,items:['importResources','importResourceFolder','captureWebPage','newReadingNote']},
  {id:'libraryFilters',label:'筛选',items:['libraryKind','libraryStatus','readingListFilter','workspaceTopics']},
  {id:'libraryMore',label:'更多',items:['readingListOpen','openLiteratureMatrix','openTrash']}
 ];
 for(const {id,label,primary,items} of groups){
  const toggle=document.createElement('button'),panel=document.createElement('div');
  toggle.type='button';toggle.className=primary?'primary':'secondary';toggle.textContent=label+' ▾';
  toggle.id=id+'Toggle';toggle.setAttribute('popovertarget',id);
  panel.id=id;panel.className='library-toolbar-popup';panel.setAttribute('popover','');panel.setAttribute('aria-label',label);
  for(const item of items){
   const control=$(item);
   if(control.matches('button')){
    control.classList.remove('primary','secondary');
    control.classList.add('library-toolbar-action');
   }
   panel.append(control);
  }
  controls.insertBefore(toggle,$('librarySelection'));controls.insertBefore(panel,$('librarySelection'));
  panel.addEventListener('beforetoggle',event=>{
   if(event.newState!=='open')return;
   const bounds=toggle.getBoundingClientRect();
   panel.style.left=Math.max(8,Math.min(bounds.left,innerWidth-268))+'px';
   panel.style.top=Math.max(8,Math.min(bounds.bottom+6,innerHeight-215))+'px';
  });
  if(id!=='libraryFilters')panel.addEventListener('click',event=>{if(event.target.closest('button'))panel.hidePopover()});
 }
}
groupLibraryToolbar();
