'use strict';
// 资料库文件夹浏览：根目录先看到文件夹，进入文件夹后才看到里面的文件。
const LIBRARY_FOLDER_SCOPE='resource';
const FOLDER_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
function libraryNote(note){return note.type==='resource'||note.type==='paper'}
function libraryFolderDirectCount(folderId,records){return records.filter(note=>libraryNote(note)&&note.folderId===folderId).length}
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
function renderLibraryFolders(){
 const host=$('libraryFolders');if(!host)return;
 const scope=LIBRARY_FOLDER_SCOPE,enabled=view==='resource'&&!!activeProfile();
 host.hidden=!enabled;
 if(!enabled){host.replaceChildren();return}
 const filter=activeFolderFilter(scope),folders=recordFolders(scope),byId=new Map(folders.map(folder=>[folder.id,folder]));
 const parts=[];let cursor=filter&&filter!==FOLDER_ROOT&&filter!==FOLDER_ALL?filter:'';
 for(let depth=0;cursor&&depth<MAX_FOLDER_DEPTH;depth++){const folder=byId.get(cursor);if(!folder)break;parts.unshift({id:folder.id,name:folder.name});cursor=folder.parentId}
 const crumb=(label,target,active)=>'<button type="button" class="library-crumb'+(active?' active':'')+'" data-folder-crumb="'+esc(target)+'">'+esc(label)+'</button>';
 let crumbs='<div class="library-crumbs">'+crumb('资料库','',!filter||filter===FOLDER_ROOT);
 crumbs+=parts.map((part,index)=>'<span class="library-crumb-sep" aria-hidden="true">›</span>'+crumb(part.name,part.id,index===parts.length-1&&filter!==FOLDER_ALL)).join('');
 if(filter===FOLDER_ROOT)crumbs+='<span class="library-crumb-sep" aria-hidden="true">›</span>'+crumb('未归档',FOLDER_ROOT,true);
 crumbs+='<span class="library-crumb-spacer"></span>'
  +'<button type="button" class="library-folder-action" data-folder-create>＋ 新建文件夹</button>'
  +'<button type="button" class="library-folder-action" data-folder-manage>管理</button>'
  +(filter===FOLDER_ALL?crumb('返回文件夹','',false):crumb('全部文件',FOLDER_ALL,false))+'</div>';
 const cards=[],totals=libraryFolderTotals(records,folders);
 if(filter!==FOLDER_ALL&&filter!==FOLDER_ROOT){
  const parentId=filter&&filter!==FOLDER_ROOT?filter:'';
  for(const folder of folders.filter(item=>item.parentId===parentId).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))){
   const total=totals.get(folder.id)||0,subs=libraryFolderSubCount(folder.id,folders);
   const label=total?total+' 份文件':(subs?'暂无文件':'空文件夹');
   cards.push('<button type="button" class="library-folder-card" data-folder-open="'+esc(folder.id)+'" title="打开 '+esc(folder.name)+'"><span class="folder-glyph">'+FOLDER_ICON+'</span><span class="folder-name">'+esc(folder.name)+'</span><small>'+label+(subs?' · '+subs+' 个子文件夹':'')+'</small></button>');
  }
  if(!filter){
   const loose=records.filter(note=>libraryNote(note)&&!note.folderId).length;
   if(loose)cards.push('<button type="button" class="library-folder-card loose" data-folder-open="'+FOLDER_ROOT+'" title="查看未归档资料"><span class="folder-glyph">'+FOLDER_ICON+'</span><span class="folder-name">未归档</span><small>'+loose+' 份文件</small></button>');
  }
 }
 host.innerHTML=crumbs+(cards.length?'<div class="library-folder-grid">'+cards.join('')+'</div>':'');
 host.oncontextmenu=event=>{
  const card=event.target.closest('.library-folder-card[data-folder-open]');
  if(!card)return;
  const id=card.dataset.folderOpen;
  if(!id||id===FOLDER_ROOT||id===FOLDER_ALL)return;
  const folder=folders.find(item=>item.id===id);
  if(!folder||typeof showFolderContextMenu!=='function')return;
  event.preventDefault();
  showFolderContextMenu(event,folder,scope);
 };
 host.onclick=event=>{
  if(event.target.closest('[data-folder-create]')){
   const parentId=filter&&filter!==FOLDER_ROOT&&filter!==FOLDER_ALL?filter:'';
   folderNamePrompt({title:'新建文件夹',label:'文件夹名称',placeholder:'例如：PLL'}).then(name=>{
    if(!name)return;
    folderEdit(profile=>{
     if(parentId&&!profile.folders?.some(item=>item.id===parentId&&item.scope===scope))throw new Error('上级文件夹已变化，请重新打开。');
     profile.folders??=[];
     profile.folders.push({id:crypto.randomUUID(),name,parentId,scope});
    },'已新建文件夹');
   });
   return;
  }
  if(event.target.closest('[data-folder-manage]')){openFolderManager();return}
  const open=event.target.closest('[data-folder-open]');
  if(open){
   folderFilters.set(scope,open.dataset.folderOpen===''?'':open.dataset.folderOpen);
   if(typeof setLibraryPage==='function')setLibraryPage(1);
   render();return;
  }
  const crumbButton=event.target.closest('[data-folder-crumb]');
  if(crumbButton){
   folderFilters.set(scope,crumbButton.dataset.folderCrumb);
   if(typeof setLibraryPage==='function')setLibraryPage(1);
   render();
  }
 };
}
