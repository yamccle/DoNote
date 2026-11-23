'use strict';

const MAX_RECORD_FOLDERS=300,MAX_FOLDER_DEPTH=12,FOLDER_ROOT='@root',FOLDER_ALL='@all';
const folderScope=type=>type==='paper'?'resource':type;
let folderFilterProfile,folderEditor=null;
const folderFilters=new Map();

function validRecordFolders(value){
 if(!Array.isArray(value)||value.length>MAX_RECORD_FOLDERS)return false;
 const byId=new Map(),names=new Set();
 for(const item of value){
  if(!item||typeof item.id!=='string'||!/^[a-z0-9-]{1,80}$/i.test(item.id)||byId.has(item.id)
   ||typeof item.scope!=='string'||!/^(resource|issue|journal|study|plan|custom-[a-z0-9-]{1,64})$/i.test(item.scope)
   ||typeof item.parentId!=='string'||typeof item.name!=='string'||!item.name.trim()||item.name.length>60)return false;
  const sibling=JSON.stringify([item.scope,item.parentId,item.name.trim().toLocaleLowerCase()]);
  if(names.has(sibling))return false;
  names.add(sibling);byId.set(item.id,item);
 }
 return value.every(item=>{
  let parent=item.parentId,depth=1;
  while(parent){
   const folder=byId.get(parent);
   if(!folder||folder.scope!==item.scope||++depth>MAX_FOLDER_DEPTH)return false;
   parent=folder.parentId;
  }
  return true;
 });
}
function recordFolders(scope,profile=activeProfile()){
 return (profile?.folders||[]).filter(folder=>folder.scope===scope);
}
function folderPathParts(id,scope,profile=activeProfile()){
 const folders=recordFolders(scope,profile),parts=[];
 for(let depth=0;id&&depth<MAX_FOLDER_DEPTH;depth++){
  const folder=folders.find(item=>item.id===id);if(!folder)break;
  parts.unshift(folder.name);id=folder.parentId;
 }
 return parts;
}
function folderPath(id,scope,profile=activeProfile()){return folderPathParts(id,scope,profile).join(' › ')}
function recordFolderOptions(scope){
 return recordFolders(scope).map(item=>[item.id,folderPath(item.id,scope)])
  .sort((a,b)=>a[1].localeCompare(b[1],'zh-CN')).map(([id,name])=>'<option value="'+esc(id)+'">'+esc(name)+'</option>').join('');
}
function folderDescendants(scope,id){
 const children=new Map();
 for(const item of recordFolders(scope)){
  if(!children.has(item.parentId))children.set(item.parentId,[]);
  children.get(item.parentId).push(item.id);
 }
 const ids=new Set([id]);
 for(const current of ids)for(const child of children.get(current)||[])ids.add(child);
 return ids;
}
function scopedFolderId(type,id,profile=activeProfile()){
 return recordFolders(folderScope(type),profile).some(folder=>folder.id===id)?id:'';
}
function activeFolderFilter(scope){
 const profileId=appState?.activeId;
 if(folderFilterProfile!==profileId){folderFilterProfile=profileId;folderFilters.clear()}
 const filter=folderFilters.get(scope)||'';
 return filter===FOLDER_ROOT||filter===FOLDER_ALL?filter:scopedFolderId(scope,filter);
}
function recordFolderMatcher(scope,filter){
 if(!filter)return ()=>true;
 if(filter===FOLDER_ALL)return ()=>true;
 if(filter===FOLDER_ROOT)return note=>!note.folderId;
 const children=new Map();
 for(const folder of recordFolders(scope)){
  if(!children.has(folder.parentId))children.set(folder.parentId,[]);
  children.get(folder.parentId).push(folder.id);
 }
 const ids=new Set([filter]);
 for(const id of ids)for(const child of children.get(id)||[])ids.add(child);
 return note=>ids.has(note.folderId);
}
function assignDefaultFolder(note){
 const scope=folderScope(note.type);
 if(scope===folderScope(view)){
  const id=scopedFolderId(scope,activeFolderFilter(scope));
  if(id)note.folderId=id;
 }
 return note;
}
function folderFromImportPath(profile,scope,path,parentId=''){
 const folders=profile.folders??=[];
 for(const part of path){
  // 目录名来自文件系统，可能超长或带系统不允许的字符；清洗后仍保留层级，不因为一个怪名字中断整批导入。
  let name=String(part??'').trim().replace(/[\u0000-\u001f]/g,' ').replace(/[\\/:*?"<>|]/g,'·').replace(/\s+/g,' ').trim();
  if(!name)continue;
  if(name.length>60)name=name.slice(0,60).trim();
  if(!name)continue;
  let folder=folders.find(item=>item.scope===scope&&item.parentId===parentId&&item.name.toLocaleLowerCase()===name.toLocaleLowerCase());
  if(!folder){
   if(folders.length>=MAX_RECORD_FOLDERS)return parentId;
   folder={id:crypto.randomUUID(),name,scope,parentId};folders.push(folder);
  }
  parentId=folder.id;
 }
 return parentId;
}
function setEditorFolder(type,id){
 const select=$('recordFolder');
 select.innerHTML='<option value="">未归档</option>'+recordFolderOptions(folderScope(type));
 select.value=scopedFolderId(type,id);
}
function renderRecordFolderBar(){
 const scope=folderScope(view),bar=$('recordFolderBar'),select=$('recordFolderFilter');
 // 资料库视图用文件夹卡片导航，不再显示下拉筛选。
 bar.hidden=view==='resource'||!activeProfile()||!scope||scope==='all'||scope==='pinned';
 if(bar.hidden)return '';
 const filter=activeFolderFilter(scope);
 select.innerHTML='<option value="">全部文件夹</option><option value="'+FOLDER_ROOT+'">未归档</option>'+recordFolderOptions(scope);
 select.value=filter;
 return filter;
}
function mergeImportedRecordFolders(profile,source,incoming){
 const byOldId=new Map(),sourceById=new Map((source||[]).map(folder=>[folder.id,folder]));
 const folders=profile.folders??=[];
 function merge(folder){
  if(byOldId.has(folder.id))return byOldId.get(folder.id);
  const parent=sourceById.get(folder.parentId),parentId=parent?merge(parent):'';
  let local=folders.find(item=>item.scope===folder.scope&&item.parentId===parentId&&item.name.toLocaleLowerCase()===folder.name.toLocaleLowerCase());
  if(!local){
   const id=folders.some(item=>item.id===folder.id)?crypto.randomUUID():folder.id;
   local={...folder,id,parentId};folders.push(local);
  }
  byOldId.set(folder.id,local.id);return local.id;
 }
 for(const folder of source||[])merge(folder);
 if(!validRecordFolders(folders))throw new Error('合并后的文件夹超过数量或层级限制。');
 for(const note of incoming){
  if(note.folderId===undefined)continue;
  const id=byOldId.get(note.folderId);
  if(!id||!scopedFolderId(note.type,id,profile))throw new Error('备份中的记录文件夹无效。');
  note.folderId=id;
 }
}
function renderFolderManager(){
 const {scope,id}=folderEditor,folder=recordFolders(scope).find(item=>item.id===id);
 $('folderManagerTitle').textContent=(names[scope]||'栏目')+' · 文件夹';
 const excluded=folder?folderDescendants(scope,folder.id):new Set();
 $('folderParent').innerHTML='<option value="">根目录</option>'+recordFolders(scope).filter(item=>!excluded.has(item.id))
  .map(item=>[item.id,folderPath(item.id,scope)]).sort((a,b)=>a[1].localeCompare(b[1],'zh-CN'))
  .map(([folderId,path])=>'<option value="'+esc(folderId)+'">'+esc(path)+'</option>').join('');
 $('folderParent').value=folder?.parentId||'';
 $('folderName').value=folder?.name||'';
 $('folderSave').textContent=folder?'保存修改':'新建文件夹';
 $('folderCancelEdit').hidden=!folder;
 const rows=recordFolders(scope).map(item=>[item,folderPath(item.id,scope)]).sort((a,b)=>a[1].localeCompare(b[1],'zh-CN'));
 $('folderRows').innerHTML=rows.map(([item,path])=>'<div class="manager-row"><span>'+esc(path)+'</span><button type="button" class="secondary" data-edit-folder="'+esc(item.id)+'">重命名 / 移动</button><button type="button" class="danger" data-delete-folder="'+esc(item.id)+'">删除</button></div>').join('')||'<p class="section-note">还没有文件夹。</p>';
}
function openFolderManager(options={}){
 if(!ensureReady())return;
 const scope=options.scope||folderScope(view);
 folderEditor={profileId:appState.activeId,scope,id:options.id||''};
 $('folderMessage').textContent='';renderFolderManager();
 if(!folderEditor.id){const selected=activeFolderFilter(scope);$('folderParent').value=scopedFolderId(scope,selected)}
 $('folderManager').showModal();$('folderName').focus();
}
function currentFolderProfile(next){
 if(folderEditor?.profileId!==next.activeId)throw new Error('工作台已切换，请重新打开文件夹管理。');
 return next.profiles.find(profile=>profile.id===next.activeId);
}
let folderSaving=false;
async function editFolders(change){
 if(folderSaving)return;
 folderSaving=true;$('folderMessage').textContent='';
 try{
  const next=structuredClone(appState),profile=currentFolderProfile(next);
  profile.folders??=[];change(profile);
  if(!validRecordFolders(profile.folders))throw new Error('同一级目录不能重名，也不能移到自身或子文件夹。每个工作台最多 300 个文件夹、12 层。');
  await commitState(next);
  if($('folderManager').open){folderEditor.id='';renderFolderManager()}
  render();
 }catch(error){$('folderMessage').textContent=error.message}
 finally{folderSaving=false}
}
$('recordFolderFilter').onchange=event=>{folderFilters.set(folderScope(view),event.target.value);render()};
$('openFolderManager').onclick=openFolderManager;
$('folderCancelEdit').onclick=()=>{folderEditor.id='';renderFolderManager()};
$('folderForm').onsubmit=event=>{
 event.preventDefault();
 const name=$('folderName').value.trim(),parentId=$('folderParent').value,{id,scope}=folderEditor;
 if(!name)return;
 editFolders(profile=>{
  const folder=profile.folders.find(item=>item.id===id&&item.scope===scope);
  if(id&&!folder)throw new Error('文件夹已变化，请重新选择。');
  if(folder)Object.assign(folder,{name,parentId});
  else profile.folders.push({id:crypto.randomUUID(),name,parentId,scope});
 });
};
$('folderRows').onclick=async event=>{
 const button=event.target.closest('button');if(!button||folderSaving)return;
 if(button.dataset.editFolder){folderEditor.id=button.dataset.editFolder;renderFolderManager();$('folderName').focus();return}
 const id=button.dataset.deleteFolder;if(!id)return;
 const folder=recordFolders(folderEditor.scope).find(item=>item.id===id);if(!folder)return;
 // 与右键菜单一致：递归删除子文件夹，里面的记录进回收站。
 if(typeof deleteRecordFolder==='function'){await deleteRecordFolder(folder,folder.scope);renderFolderManager();return}
};
