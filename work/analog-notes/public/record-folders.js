/**
 * [INPUT]: 读取当前工作台的文件夹、记录类型和筛选值。
 * [OUTPUT]: 验证层级，提供路径、目录树与栏目的文件夹筛选。
 * [POS]: 文件夹状态层，供文件夹管理、编辑器和导入流程使用。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const MAX_RECORD_FOLDERS=300,MAX_FOLDER_DEPTH=12,FOLDER_ROOT='@root',FOLDER_ALL='@all';
const folderScope=type=>type==='paper'?'resource':type;
let folderFilterProfile;
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
function folderTreeRows(scope,profile=activeProfile()){
 const children=new Map();
 for(const folder of recordFolders(scope,profile)){
  if(!children.has(folder.parentId))children.set(folder.parentId,[]);
  children.get(folder.parentId).push(folder);
 }
 const rows=[];
 function walk(parentId,ancestors){
  if(ancestors.length>=MAX_FOLDER_DEPTH)return;
  const siblings=children.get(parentId)||[];
  siblings.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  for(const folder of siblings){
   const path=[...ancestors,folder.name];
   rows.push({folder,path});
   walk(folder.id,path);
  }
 }
 walk('',[]);
 return rows;
}
function recordFolderOptions(scope){
 return folderTreeRows(scope).map(({folder,path})=>'<option value="'+esc(folder.id)+'">'+esc(path.join(' › '))+'</option>').join('');
}
function folderDescendants(scope,id,profile=activeProfile()){
 const children=new Map();
 for(const item of recordFolders(scope,profile)){
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
 const ids=folderDescendants(scope,filter);
 return note=>ids.has(note.folderId);
}
function revealFolderLocation(scope,id){
 if(id&&id!==FOLDER_ROOT&&id!==FOLDER_ALL&&!scopedFolderId(scope,id))return false;
 activeFolderFilter(scope);
 folderFilters.set(scope,id);
 libraryPage=1;
 if(folderScope(view)===scope)render();
 else switchView(scope);
 if(scope==='resource')$('libraryFolders').querySelector('.library-folder-toolbar')?.scrollIntoView({block:'nearest'});
 return true;
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
 $('currentRecordFolderActions').hidden=!scopedFolderId(scope,filter);
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
$('recordFolderFilter').onchange=event=>revealFolderLocation(folderScope(view),event.target.value);
