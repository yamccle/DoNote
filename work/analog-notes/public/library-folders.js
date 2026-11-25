/**
 * [INPUT]: 读取资料库文件夹、记录和当前浏览位置。
 * [OUTPUT]: 显示本层文件夹、路径和文件数量。
 * [POS]: 把资料库的创建、导航和卡片菜单转交给文件夹管理。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
const LIBRARY_FOLDER_SCOPE='resource';
const FOLDER_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
function libraryNote(note){return note.type==='resource'||note.type==='paper'}
function libraryFolderSubCount(folderId,folders){return folders.filter(folder=>folder.parentId===folderId).length}
// 文件夹卡片显示“包含子文件夹在内”的文件总数，避免子文件夹里有资料却显示空文件夹。
function libraryFolderTotals(records,folders){
 const children=new Map(),totals=new Map();
 for(const folder of folders){
  if(!children.has(folder.parentId))children.set(folder.parentId,[]);
  children.get(folder.parentId).push(folder.id);
 }
 for(const note of records){
  if(!libraryNote(note)||!note.folderId)continue;
  totals.set(note.folderId,(totals.get(note.folderId)||0)+1);
 }
 const seen=new Set();
 const walk=id=>{
  if(seen.has(id))return 0;
  seen.add(id);
  let total=totals.get(id)||0;
  for(const child of children.get(id)||[])total+=walk(child);
  totals.set(id,total);
  return total;
 };
 for(const folder of folders)if(!folder.parentId)walk(folder.id);
 return totals;
}
// 资料库视图使用“只看本层”的匹配规则，避免进入父文件夹时把所有子文件摊平。
function libraryFolderMatcher(){
 const filter=activeFolderFilter(LIBRARY_FOLDER_SCOPE);
 if(filter===FOLDER_ALL)return ()=>true;
 if(!filter||filter===FOLDER_ROOT)return note=>!note.folderId;
 return note=>note.folderId===filter;
}

function libraryFolderTrail(filter,folders){
 const parts=[];
 let folder=folders.get(filter);
 while(folder&&parts.length<MAX_FOLDER_DEPTH){
  parts.unshift(folder);
  folder=folders.get(folder.parentId);
 }
 return parts;
}

function libraryFolderToolbar(filter,folders){
 const current=folders.get(filter);
 const crumb=(label,target,active)=>'<button type="button" class="library-crumb'+(active?' active':'')+
  '" data-folder-crumb="'+esc(target)+'" title="'+esc(label)+'"'+(active?' aria-current="location"':'')+'>'+esc(label)+'</button>';
 const separator='<span class="library-crumb-sep" aria-hidden="true">›</span>';
 const parts=[crumb(names.resource||'资料库','',!filter),...libraryFolderTrail(filter,folders).map(folder=>crumb(folder.name,folder.id,folder.id===filter))];
 if(filter===FOLDER_ROOT)parts.push(crumb('未归档',FOLDER_ROOT,true));
 if(filter===FOLDER_ALL)parts.push(crumb('全部文件',FOLDER_ALL,true));
 const tools=[
  current||filter===FOLDER_ROOT?'<button type="button" class="library-folder-action" data-folder-up="'+esc(current?.parentId||'')+'">↑ 上一级</button>':'',
  current?'<button type="button" class="icon-button" data-folder-more="'+esc(current.id)+'" title="当前文件夹操作" aria-label="当前文件夹操作" aria-haspopup="menu">…</button>':'',
  '<button type="button" class="library-folder-action" data-folder-create>＋ 新建文件夹</button>',
  '<button type="button" class="library-folder-action" data-folder-manage>管理文件夹</button>',
  filter===FOLDER_ALL?crumb('返回文件夹','',false):crumb('全部文件',FOLDER_ALL,false)
 ];
 return '<div class="library-folder-toolbar"><nav class="library-crumbs" aria-label="文件夹路径">'+parts.join(separator)+
  '</nav><div class="library-folder-tools">'+tools.join('')+'</div></div>';
}

function libraryFolderCard(folder,total,subfolders){
 const label=total?total+' 份文件':(subfolders?'暂无文件':'空文件夹');
 const meta=label+(subfolders?' · '+subfolders+' 个子文件夹':'');
 const title=esc(folder.name),id=esc(folder.id);
 return '<div class="library-folder-item"><button type="button" class="library-folder-card" data-folder-open="'+id+
  '" title="打开 '+title+'（'+esc(meta)+'）"><span class="folder-glyph">'+FOLDER_ICON+'</span><span class="folder-name">'+title+'</span><small>'+
  meta+'</small></button>'+
  '<button type="button" class="icon-button library-folder-more" data-folder-more="'+id+'" aria-haspopup="menu" aria-label="文件夹操作：'+title+
  '" title="文件夹操作">⋯</button></div>';
}

function renderLibraryFolders(){
 const host=$('libraryFolders');if(!host)return;
 const scope=LIBRARY_FOLDER_SCOPE,enabled=view==='resource'&&!!activeProfile();
 host.hidden=!enabled;
 if(!enabled){host.replaceChildren();return}
 const filter=activeFolderFilter(scope),folders=recordFolders(scope),byId=new Map(folders.map(folder=>[folder.id,folder]));
 const cards=[];
 if(filter!==FOLDER_ALL&&filter!==FOLDER_ROOT){
  const totals=libraryFolderTotals(records,folders);
  for(const folder of folders.filter(item=>item.parentId===filter).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))){
   cards.push(libraryFolderCard(folder,totals.get(folder.id)||0,libraryFolderSubCount(folder.id,folders)));
  }
  if(!filter){
   const loose=records.filter(note=>libraryNote(note)&&!note.folderId).length;
   if(loose)cards.push('<div class="library-folder-item"><button type="button" class="library-folder-card loose" data-folder-open="'+FOLDER_ROOT+'" title="查看未归档资料（'+loose+' 份文件）"><span class="folder-glyph">'+FOLDER_ICON+'</span><span class="folder-name">未归档</span><small>'+loose+' 份文件</small></button></div>');
  }
 }
 host.innerHTML=libraryFolderToolbar(filter,byId)+(cards.length?'<div class="library-folder-grid">'+cards.join('')+'</div>':'');
 const path=host.querySelector('.library-crumbs');
 if(filter)path.scrollLeft=path.scrollWidth;
 host.oncontextmenu=event=>{
  const card=event.target.closest('[data-folder-open],[data-folder-more]');
  if(!card)return;
  const folder=byId.get(card.dataset.folderOpen||card.dataset.folderMore);
  if(folder)showFolderContextMenu(event,folder,scope);
 };
 host.onclick=event=>{
  if(event.target.closest('[data-folder-create]')){
   openFolderAction('create',{scope,parentId:byId.get(filter)?.id||''});
   return;
  }
  if(event.target.closest('[data-folder-manage]')){openFolderManager({scope});return}
  const more=event.target.closest('[data-folder-more]');
  if(more){
   const folder=byId.get(more.dataset.folderMore);
   if(folder)showFolderContextMenu(event,folder,scope);
   return;
  }
  const location=event.target.closest('[data-folder-open],[data-folder-crumb],[data-folder-up]');
  if(!location)return;
  if(location.getAttribute('aria-current')==='location')return;
  revealFolderLocation(scope,location.dataset.folderOpen??location.dataset.folderCrumb??location.dataset.folderUp);
  host.querySelector('[aria-current="location"]')?.focus({preventScroll:true});
 };
}
