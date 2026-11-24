/**
 * [INPUT]: 读取目录树、当前资料位置和记录移动回调。
 * [OUTPUT]: 搜索目录并提交新建、改名、移动与删除操作。子文件夹默认折叠。
 * [POS]: 共用文献库和各栏目的目录操作窗口。每次提交只写一次工作台状态。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const folderManagerDialog=$('folderManager');
const folderActionDialog=$('folderActionDialog');
const folderActionSubmit=$('folderActionSubmit');
const folderActionLabels={
 create:['新建文件夹','创建'],rename:['重命名文件夹','保存名称'],
 move:['移动文件夹','移动'],recordMove:['移动到文件夹','移动'],remove:['删除文件夹','删除文件夹']
};
let folderManagerContext=null,folderActionContext=null,folderSaving=false;

function folderLocation(scope,id,record=false){
 if(id===null)return '多个位置';
 if(id)return (names[scope]||'栏目')+' › '+folderPath(id,scope);
 return record?'未归档':(names[scope]||'栏目')+'根目录';
}

function matchingFolderRows(scope,query){
 const search=query.trim().toLocaleLowerCase();
 return folderTreeRows(scope).filter(({path})=>path.join(' › ').toLocaleLowerCase().includes(search));
}

function folderRowLabel(folder,path,searching,hint=''){
 const parents=path.slice(0,-1).join(' › ');
 return '<span class="folder-row-label"><strong>'+esc(folder.name)+'</strong>'
  +(searching&&parents?'<small>'+esc(parents)+'</small>':'')
  +(hint?'<small>'+esc(hint)+'</small>':'')+'</span>';
}

function folderChildIds(scope){
 const children=new Map();
 for(const folder of recordFolders(scope)){
  if(!children.has(folder.parentId))children.set(folder.parentId,[]);
  children.get(folder.parentId).push(folder.id);
 }
 return children;
}

function visibleFolderRows(scope,query,expanded){
 const rows=matchingFolderRows(scope,query);
 if(query.trim())return rows;
 const byId=new Map(rows.map(row=>[row.folder.id,row]));
 return rows.filter(({folder})=>{
  let parent=folder.parentId,seen=new Set();
  while(parent){
   if(seen.has(parent)||!expanded.has(parent))return false;
   seen.add(parent);
   parent=byId.get(parent)?.folder.parentId||'';
  }
  return true;
 });
}

function folderToggleButton(id,name,childCount,expanded){
 if(!childCount)return '<span class="folder-row-spacer" aria-hidden="true"></span>';
 const open=expanded.has(id);
 return '<button type="button" class="folder-row-toggle" data-folder-toggle="'+esc(id)+'" aria-expanded="'+open+'" aria-label="'+(open?'折叠 ':'展开 ')+esc(name)+'"><span aria-hidden="true">›</span></button>';
}

function toggleFolderBranch(expanded,id){
 if(expanded.has(id))expanded.delete(id);
 else expanded.add(id);
}

function renderFolderManager(){
 const {scope,expanded}=folderManagerContext;
 const query=$('folderManagerSearch').value;
 const children=folderChildIds(scope);
 const rows=visibleFolderRows(scope,query,expanded);
 $('folderRows').innerHTML=rows.map(({folder,path})=>{
  const id=esc(folder.id),label=esc(folder.name+'的操作'),childCount=(children.get(folder.id)||[]).length;
  return '<div class="folder-manager-row" data-folder-item="'+id+'" style="--folder-depth:'+(query.trim()?0:path.length-1)+'">'
   +folderToggleButton(folder.id,folder.name,query.trim()?0:childCount,expanded)
   +'<button type="button" class="folder-row-open" data-folder-browse="'+id+'" title="'+esc(path.join(' › '))+'">'+folderRowLabel(folder,path,query.trim(),childCount&&!query.trim()?childCount+' 个子文件夹':'')+'</button>'
   +'<button type="button" class="icon-button" data-folder-more="'+id+'" aria-label="'+label+'" title="'+label+'" aria-haspopup="menu">…</button></div>';
 }).join('')||'<p class="section-note">'+(query.trim()?'没有匹配的文件夹。':'这里还没有文件夹。')+'</p>';
}

function openFolderManager({scope=folderScope(view)}={}){
 if(!ensureReady()||folderManagerDialog.open)return;
 folderManagerContext={scope,profileId:appState.activeId,expanded:new Set()};
 $('folderManagerTitle').textContent='文件夹管理';
 $('folderManagerSearch').value='';
 $('folderManagerMessage').replaceChildren();
 renderFolderManager();
 folderManagerDialog.showModal();
 $('folderManagerSearch').focus();
}

function renderFolderDestinations(){
 const {scope,folder,currentFolder,destination,mode,expanded}=folderActionContext;
 const query=$('folderDestinationSearch').value;
 const record=mode==='recordMove';
 const excluded=folder?folderDescendants(scope,folder.id):new Set();
 const children=folderChildIds(scope);
 const rows=visibleFolderRows(scope,query,expanded).filter(({folder:item})=>
  item.id!==currentFolder&&!excluded.has(item.id));
 const root=folderLocation(scope,'',record);
 function option(id,label,depth,childCount,name){
  return '<div class="folder-destination-row" style="--folder-depth:'+depth+'">'
   +folderToggleButton(id,name,query.trim()?0:childCount,expanded)
   +'<button class="folder-destination" type="button" data-folder-destination="'+esc(id)+'" aria-pressed="'+
   (id===destination)+'">'+label+'</button></div>';
 }
 const rootChoice=currentFolder!==''&&root.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())?option('',esc(root),0,0,''):'';
 const choices=rows.map(({folder,path})=>
  option(folder.id,folderRowLabel(folder,path,query.trim(),!query.trim()&&(children.get(folder.id)||[]).length?(children.get(folder.id)||[]).length+' 个子文件夹':''),query.trim()?0:path.length-1,(children.get(folder.id)||[]).length,folder.name)).join('');
 $('folderDestinationChoices').innerHTML='<legend class="visually-hidden">目标文件夹</legend>'
  +(rootChoice+choices||'<p class="section-note">'+(query.trim()?'没有匹配的目标文件夹。':'没有其他可用文件夹。')+'</p>');
}

function updateFolderDestination(){
 const {destination,scope,mode}=folderActionContext;
 for(const option of $('folderDestinationChoices').querySelectorAll('[data-folder-destination]')){
  option.setAttribute('aria-pressed',String(option.dataset.folderDestination===destination));
 }
 $('folderDestinationPath').textContent=destination===null?'请选择目标文件夹':'目标位置 · '+folderLocation(scope,destination,mode==='recordMove');
 folderActionSubmit.disabled=folderSaving||destination===null;
}

function updateFolderRemoveEffect(){
 const {folder,scope,recordIds,branchSize}=folderActionContext;
 const path=folderLocation(scope,folder.parentId);
 $('folderRemoveEffect').textContent=$('folderRemoveContents').checked
  ?'将一并删除 '+(branchSize-1)+' 个子文件夹，并把 '+recordIds.size+' 条记录移到回收站。'
  :'直接子文件夹和记录会移到「'+path+'」。';
}

function openFolderAction(mode,{scope=folderScope(view),id='',parentId='',description='',currentFolder=null,apply=null}={}){
 if(!ensureReady()||folderActionDialog.open||folderSaving)return;
 const folder=id?recordFolders(scope).find(item=>item.id===id):null;
 if(id&&!folder||parentId&&!scopedFolderId(scope,parentId)){toast('文件夹已变化，请重新选择。');return}
 const moving=mode==='move'||mode==='recordMove',naming=mode==='create'||mode==='rename';
 const removing=mode==='remove';
 const branch=removing?folderDescendants(scope,id):new Set();
 folderActionContext={
  mode,scope,folder:folder?{...folder}:null,parentId,profileId:appState.activeId,apply,
  currentFolder:folder?.parentId??currentFolder,destination:null,branchSize:branch.size,
  expanded:new Set(),
  recordIds:new Set(removing?records.filter(note=>branch.has(note.folderId)).map(note=>note.id):[])
 };
 const [title,label]=folderActionLabels[mode];
 $('folderActionForm').reset();
 $('folderActionTitle').textContent=title;
 $('folderActionNameField').hidden=!naming;
 $('folderActionName').required=naming;
 $('folderActionName').value=mode==='rename'?folder.name:'';
 $('folderDestination').hidden=!moving;
 $('folderDestinationPath').hidden=!moving;
 $('folderRemoveOptions').hidden=!removing;
 $('folderActionMessage').textContent='';
 folderActionSubmit.textContent=label;
 folderActionSubmit.disabled=moving;
 const location=$('folderActionLocation');
 if(mode==='recordMove')location.textContent=description+' · 当前位置 · '+folderLocation(scope,currentFolder,true);
 else if(mode==='create')location.textContent='位置 · '+folderLocation(scope,parentId);
 else location.textContent=folderLocation(scope,mode==='rename'?folder.parentId:folder.id);
 if(moving){renderFolderDestinations();updateFolderDestination()}
 if(removing)updateFolderRemoveEffect();
 folderActionDialog.showModal();
 if(naming){$('folderActionName').focus();$('folderActionName').select()}
 if(moving)$('folderDestinationSearch').focus();
 if(removing)$('folderRemoveContents').focus();
}

function openRecordFolderMove(options){openFolderAction('recordMove',options)}

function folderActionProfile(state,profileId){
 if(state.activeId!==profileId)throw new Error('工作台已切换，请重新打开文件夹操作。');
 return state.profiles.find(profile=>profile.id===profileId);
}

function setFolderLocation(profile,folder,name,parentId){
 const {scope,id}=folder;
 if(parentId&&!scopedFolderId(scope,parentId,profile))throw new Error('目标文件夹已变化，请重新选择。');
 if(recordFolders(scope,profile).some(item=>item.id!==id&&item.parentId===parentId&&
  item.name.trim().toLocaleLowerCase()===name.trim().toLocaleLowerCase())){
  throw new Error('此位置已有同名文件夹，请更换名称或位置。');
 }
 Object.assign(folder,{name,parentId});
}

function refreshFolderLocations(){
 if(folderManagerDialog.open&&folderManagerContext.profileId===appState.activeId)renderFolderManager();
 render();
}

function showFolderNotice(message,action){
 if(!folderManagerDialog.open){toast(message,action);return}
 const status=$('folderManagerMessage');
 status.replaceChildren(message);
 if(!action)return;
 const button=document.createElement('button');
 button.type='button';button.className='secondary';button.textContent=action.label;
 button.onclick=async()=>{
  button.disabled=true;
  try{await action.run()}catch(error){status.textContent=error.message}
 };
 status.append(button);
}

async function undoFolderMove(context,newParent){
 const next=structuredClone(appState),profile=folderActionProfile(next,context.profileId);
 const previous=context.folder,folder=recordFolders(context.scope,profile).find(item=>item.id===previous.id);
 if(!folder||folder.parentId!==newParent)throw new Error('文件夹位置已变化，无法撤销这次移动。');
 setFolderLocation(profile,folder,folder.name,previous.parentId);
 if(!validRecordFolders(profile.folders))throw new Error('原位置的文件夹层级已变化，无法撤销。');
 await commitState(next);
 refreshFolderLocations();
 showFolderNotice('已撤销移动');
}

function removeFolderFromProfile(profile,folder,context){
 const discardContents=$('folderRemoveContents').checked;
 const ids=discardContents?folderDescendants(folder.scope,folder.id,profile):new Set([folder.id]);
 if(discardContents){
  const targets=new Set(profile.records.filter(note=>ids.has(note.folderId)).map(note=>note.id));
  if(ids.size!==context.branchSize||targets.size!==context.recordIds.size||[...targets].some(id=>!context.recordIds.has(id))){
   throw new Error('文件夹内容已变化，请重新打开确认。');
  }
  if(targets.size&&trashOf(profile).length+targets.size>TRASH_CAP)throw new Error('回收站的剩余空间不足。可以取消勾选，保留文件夹内的内容。');
  if(targets.size)stageTrashRecords(profile,targets);
 }
 profile.folders=profile.folders.filter(item=>!ids.has(item.id));
 if(!discardContents){
  for(const child of recordFolders(folder.scope,profile)){
   if(child.parentId===folder.id)setFolderLocation(profile,child,child.name,folder.parentId);
  }
  const now=new Date().toISOString();
  for(const note of profile.records){
   if(note.folderId!==folder.id)continue;
   if(folder.parentId)note.folderId=folder.parentId;
   else delete note.folderId;
   note.updatedAt=now;
  }
 }
 return {ids,discardContents};
}

async function saveFolderChange(context){
 const {mode,scope,folder:previous,parentId,destination,profileId}=context;
 const next=structuredClone(appState),profile=folderActionProfile(next,profileId);
 const folders=profile.folders??=[];
 const folder=previous?recordFolders(scope,profile).find(item=>item.id===previous.id):null;
 if(previous&&(!folder||folder.name!==previous.name||folder.parentId!==previous.parentId)){
  throw new Error('文件夹已变化，请重新选择。');
 }
 const name=$('folderActionName').value.trim();
 const filter=activeFolderFilter(scope);
 let notice,action,removed;
 if(mode==='create'){
  if(!name)throw new Error('请输入文件夹名称。');
  if(folders.length>=MAX_RECORD_FOLDERS)throw new Error('已达到文件夹数量上限 '+MAX_RECORD_FOLDERS+'。');
  const created={id:crypto.randomUUID(),scope};
  setFolderLocation(profile,created,name,parentId);folders.push(created);
  notice='已创建「'+name+'」';
 }else if(mode==='rename'){
  if(!name)throw new Error('请输入文件夹名称。');
  setFolderLocation(profile,folder,name,folder.parentId);
  notice='已重命名为「'+name+'」';
 }else if(mode==='move'){
  if(destination===null||folderDescendants(scope,folder.id,profile).has(destination))throw new Error('请选择其他目标文件夹。');
  setFolderLocation(profile,folder,folder.name,destination);
  notice='已移动到「'+folderLocation(scope,destination)+'」';
  action={label:'撤销',run:()=>undoFolderMove(context,destination)};
 }else{
  removed=removeFolderFromProfile(profile,folder,context);
  notice=removed.discardContents?'已删除文件夹，记录已移入回收站':'已删除文件夹，原内容已移到上一级';
 }
 if(!validRecordFolders(profile.folders))throw new Error('文件夹最多 '+MAX_FOLDER_DEPTH+' 层。请选择更上一级的位置。');
 await commitState(next);
 if(removed?.discardContents)clearTrashRecordCheckpoints(profileId,context.recordIds);
 if(removed?.ids.has(filter)){folderFilters.set(scope,previous.parentId);libraryPage=1}
 return {notice,action};
}

$('folderActionForm').onsubmit=async event=>{
 event.preventDefault();
 if(folderSaving||folderActionSubmit.disabled)return;
 const context=folderActionContext;
 folderSaving=true;
 folderActionSubmit.disabled=true;
 $('folderActionMessage').textContent='';
 try{
  if(context.apply){
   folderActionProfile(appState,context.profileId);
   await context.apply(context.destination);
   folderActionDialog.close();
  }else{
   const {notice,action}=await saveFolderChange(context);
   if(context.mode==='create'&&context.parentId)folderManagerContext?.expanded?.add(context.parentId);
   if(context.mode==='move'&&context.destination)folderManagerContext?.expanded?.add(context.destination);
   folderActionDialog.close();
   refreshFolderLocations();
   showFolderNotice(notice,action);
  }
 }catch(error){$('folderActionMessage').textContent=error.message}
 finally{folderSaving=false;folderActionSubmit.disabled=false}
};
folderActionDialog.addEventListener('cancel',event=>{if(folderSaving)event.preventDefault()});
folderActionDialog.querySelectorAll('[data-close]').forEach(button=>{button.onclick=()=>{if(!folderSaving)folderActionDialog.close()}});
$('folderRemoveContents').onchange=updateFolderRemoveEffect;
$('folderDestinationSearch').oninput=renderFolderDestinations;
$('folderDestinationChoices').onclick=event=>{
 const toggle=event.target.closest('[data-folder-toggle]');
 if(toggle&&!folderSaving){
  toggleFolderBranch(folderActionContext.expanded,toggle.dataset.folderToggle);
  renderFolderDestinations();
  $('folderDestinationChoices').querySelector('[data-folder-toggle="'+CSS.escape(toggle.dataset.folderToggle)+'"]')?.focus();
  return;
 }
 const option=event.target.closest('[data-folder-destination]');
 if(!option||folderSaving)return;
 folderActionContext.destination=option.dataset.folderDestination;
 $('folderActionMessage').textContent='';
 updateFolderDestination();
};
$('folderDestinationSearch').onkeydown=event=>{
 if(event.key!=='Enter'||event.isComposing)return;
 event.preventDefault();
 $('folderDestinationChoices').querySelector('button')?.focus();
};
$('folderManagerSearch').oninput=renderFolderManager;
function createInCurrentFolder(scope){
 return openFolderAction('create',{scope,parentId:scopedFolderId(scope,activeFolderFilter(scope))});
}
function readFolderManagerScope(){
 if(folderManagerContext.profileId===appState.activeId)return folderManagerContext.scope;
 folderManagerDialog.close();
 toast('工作台已切换，请重新打开文件夹管理。');
 return null;
}
$('folderManagerCreate').onclick=()=>{
 const scope=readFolderManagerScope();
 if(scope)createInCurrentFolder(scope);
};
$('createRecordFolder').onclick=()=>createInCurrentFolder(folderScope(view));
$('openFolderManager').onclick=()=>openFolderManager();
$('folderRows').onclick=event=>{
 const scope=readFolderManagerScope();
 if(!scope)return;
 const toggle=event.target.closest('[data-folder-toggle]');
 if(toggle){
  toggleFolderBranch(folderManagerContext.expanded,toggle.dataset.folderToggle);
  renderFolderManager();
  $('folderRows').querySelector('[data-folder-toggle="'+CSS.escape(toggle.dataset.folderToggle)+'"]')?.focus();
  return;
 }
 const browse=event.target.closest('[data-folder-browse]');
 if(browse&&revealFolderLocation(scope,browse.dataset.folderBrowse)){folderManagerDialog.close();return}
 const more=event.target.closest('[data-folder-more]');
 const folder=more&&recordFolders(scope).find(item=>item.id===more.dataset.folderMore);
 if(folder)showFolderContextMenu(event,folder,scope);
};
$('folderRows').oncontextmenu=event=>{
 const id=event.target.closest('[data-folder-item]')?.dataset.folderItem;
 const scope=readFolderManagerScope();
 if(!scope)return;
 const folder=recordFolders(scope).find(item=>item.id===id);
 if(folder)showFolderContextMenu(event,folder,scope);
};
$('currentRecordFolderActions').onclick=event=>{
 const scope=folderScope(view),id=activeFolderFilter(scope);
 const folder=recordFolders(scope).find(item=>item.id===id);
 if(folder)showFolderContextMenu(event,folder,scope);
};
