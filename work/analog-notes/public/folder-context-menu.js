/**
 * [INPUT]: 读取文件夹卡片、管理行和当前栏目的文件夹。
 * [OUTPUT]: 打开文件夹操作菜单，转交新建、改名、移动或删除。
 * [POS]: 共用工作台的菜单定位与键盘交互。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

function showFolderContextMenu(event,folder,scope){
 if(event.type==='contextmenu')event.stopPropagation();
 const options={scope,id:folder.id};
 showWorkspaceMenu(event,[
  {label:'打开文件夹',run:()=>{
   if(revealFolderLocation(scope,folder.id)&&$('folderManager').open)$('folderManager').close();
  }},
  {label:'重命名…',run:()=>openFolderAction('rename',options)},
  {label:'新建子文件夹…',run:()=>openFolderAction('create',{scope,parentId:folder.id})},
  {label:'移动到…',run:()=>openFolderAction('move',options)},
  null,
  {label:'删除文件夹…',danger:true,run:()=>openFolderAction('remove',options)}
 ],{anchor:event.type==='contextmenu'?null:event.target.closest('button')});
}
