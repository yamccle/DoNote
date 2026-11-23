'use strict';
// 文件夹右键菜单：打开 / 重命名 / 新建子文件夹 / 删除（内容上移到上一级）
let folderMenuTarget=null;
function folderContextMenu(){
 let menu=$('folderContextMenu');
 if(menu)return menu;
 menu=document.createElement('div');menu.id='folderContextMenu';menu.className='context-menu';menu.setAttribute('role','menu');menu.hidden=true;
 document.body.append(menu);
 menu.addEventListener('click',event=>{
  const item=event.target.closest('[data-folder-action]');
  if(!item)return;
  event.stopPropagation();
  const action=item.dataset.folderAction,target=folderMenuTarget;
  hideFolderContextMenu();
  if(target)runFolderAction(action,target);
 });
 return menu;
}
function hideFolderContextMenu(){
 const menu=$('folderContextMenu');if(menu)menu.hidden=true;
 folderMenuTarget=null;
}
function showFolderContextMenu(event,folder,scope){
 const menu=folderContextMenu();
 folderMenuTarget={folder:{...folder},scope};
 menu.innerHTML='<button type="button" role="menuitem" data-folder-action="open">打开文件夹</button><button type="button" role="menuitem" data-folder-action="rename">重命名</button><button type="button" role="menuitem" data-folder-action="newChild">新建子文件夹</button><button type="button" role="menuitem" data-folder-action="move">移动到…</button><span class="context-menu-sep" role="separator"></span><button type="button" role="menuitem" data-folder-action="delete" class="context-menu-danger">删除文件夹</button>';
 menu.hidden=false;
 const rect=menu.getBoundingClientRect();
 menu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-rect.width-8))+'px';
 menu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-rect.height-8))+'px';
}
function folderNamePrompt({title,label,value='',placeholder=''}){
 return new Promise(resolve=>{
  let dialog=$('folderNameDialog');
  if(!dialog){
   dialog=document.createElement('dialog');dialog.id='folderNameDialog';dialog.className='compact-dialog';dialog.setAttribute('aria-labelledby','folderNameDialogTitle');
   dialog.innerHTML='<div class="modalhead"><h2 id="folderNameDialogTitle">文件夹</h2><button type="button" class="icon-button" data-close="folderNameDialog" aria-label="关闭">✕</button></div><div class="modalbody"><div class="field"><label for="folderNameDialogInput" id="folderNameDialogLabel">名称</label><input id="folderNameDialogInput" maxlength="60" autocomplete="off"></div><p id="folderNameDialogError" class="form-message" role="alert"></p></div><div class="modalfoot"><div class="right"><button type="button" class="secondary" id="folderNameDialogCancel">取消</button><button type="button" class="primary" id="folderNameDialogOk">确定</button></div></div>';
   document.body.append(dialog);
   dialog.querySelector('[data-close]').onclick=()=>dialog.close();
   $('folderNameDialogCancel').onclick=()=>dialog.close();
   $('folderNameDialogOk').onclick=()=>{
    const name=$('folderNameDialogInput').value.trim();
    if(!name){$('folderNameDialogError').textContent='请输入名称。';$('folderNameDialogInput').focus();return}
    dialog.dataset.result=name;dialog.close();
   };
   $('folderNameDialogInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('folderNameDialogOk').click()}});
  }
  $('folderNameDialogTitle').textContent=title;
  $('folderNameDialogLabel').textContent=label;
  $('folderNameDialogInput').value=value;
  $('folderNameDialogInput').placeholder=placeholder||'';
  $('folderNameDialogError').textContent='';
  dialog.dataset.result='';
  dialog.addEventListener('close',()=>resolve(dialog.dataset.result||null),{once:true});
  dialog.showModal();
  $('folderNameDialogInput').focus();
  $('folderNameDialogInput').select();
 });
}
async function folderEdit(change,success='文件夹已更新'){
 try{
  const next=structuredClone(appState),profile=next.profiles.find(item=>item.id===next.activeId);
  profile.folders??=[];change(profile);
  if(!validRecordFolders(profile.folders))throw new Error('同一级不能有同名文件夹，名称不能为空。');
  await commitState(next);render();toast(success);
 }catch(error){toast(error.message)}
}
async function deleteRecordFolder(folder,scope){
 // 递归收集该文件夹及其所有子文件夹
 const folders=recordFolders(scope),children=new Map();
 for(const item of folders){
  if(!children.has(item.parentId))children.set(item.parentId,[]);
  children.get(item.parentId).push(item.id);
 }
 const ids=new Set([folder.id]),queue=[folder.id];
 while(queue.length)for(const child of children.get(queue.pop())||[])if(!ids.has(child)){ids.add(child);queue.push(child)}
 const nested=ids.size-1,targets=records.filter(note=>ids.has(note.folderId));
 const summary=[nested?nested+' 个子文件夹':'',targets.length?targets.length+' 份资料':''].filter(Boolean).join(' 和 ');
 const message='删除文件夹「'+folder.name+'」'+(summary?'及其中的 '+summary:'')+'？'+(targets.length?'里面的资料会移到回收站（保留 30 天，可恢复），':'')+'所有子文件夹会一并删除。';
 if(!await confirmWorkspaceDeletion(message))return;
 try{
  const next=structuredClone(appState),profile=next.profiles.find(item=>item.id===next.activeId);
  profile.folders=(profile.folders||[]).filter(item=>!ids.has(item.id));
  // 记录随后整体移入回收站；这里只确认没有遗漏在树外的新增记录。
  if(profile.records.filter(note=>ids.has(note.folderId)).length!==targets.length)throw new Error('文件夹内容有变化，请刷新后重试。');
  await commitState(next);
  if(targets.length)await removeWorkspaceRecords(new Set(targets.map(note=>note.id)));
  const current=activeFolderFilter(scope);
  if(ids.has(current))folderFilters.set(scope,folder.parentId||'');
  if(folderEditor?.id&&ids.has(folderEditor.id))folderEditor.id='';
  if($('folderManager').open)renderFolderManager();
  render();
  toast('已删除文件夹「'+folder.name+'」'+(targets.length?'，'+targets.length+' 份资料在回收站':''));
 }catch(error){toast(error.message)}
}
async function runFolderAction(action,target){
 const {folder,scope}=target;
 if(action==='move'){
  openFolderManager({scope,id:folder.id});
  $('folderMessage').textContent='在「上一级」选择目标文件夹，再点击「保存修改」。';
  $('folderParent').focus();return;
 }
 if(action==='open'){
  folderFilters.set(scope,folder.id);
  if(typeof setLibraryPage==='function')setLibraryPage(1);
  render();return;
 }
 if(action==='rename'){
  const name=await folderNamePrompt({title:'重命名文件夹',label:'文件夹名称',value:folder.name});
  if(!name||name===folder.name)return;
  await folderEdit(profile=>{
   const item=profile.folders.find(entry=>entry.id===folder.id);
   if(!item)throw new Error('文件夹已变化，请刷新后重试。');
   item.name=name;
  });
  return;
 }
 if(action==='newChild'){
  const name=await folderNamePrompt({title:'新建子文件夹',label:'子文件夹名称',placeholder:'例如 2024'});
  if(!name)return;
  await folderEdit(profile=>{
   if(!profile.folders.some(entry=>entry.id===folder.id))throw new Error('文件夹已变化，请刷新后重试。');
   profile.folders.push({id:crypto.randomUUID(),name,scope,parentId:folder.id});
  },'已新建子文件夹');
  return;
 }
 if(action==='delete')await deleteRecordFolder(folder,scope);
}
document.addEventListener('click',event=>{
 const menu=$('folderContextMenu');
 if(menu&&!menu.hidden&&!event.target.closest('#folderContextMenu'))hideFolderContextMenu();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')hideFolderContextMenu()});
document.addEventListener('contextmenu',event=>{
 // 文件夹卡片会先 preventDefault 并打开自己的菜单，这里不要把它关掉。
 if(event.defaultPrevented)return;
 const menu=$('folderContextMenu');
 if(menu&&!menu.hidden&&!event.target.closest('#folderContextMenu'))hideFolderContextMenu();
});
window.addEventListener('scroll',()=>hideFolderContextMenu(),true);
