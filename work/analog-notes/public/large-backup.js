'use strict';

async function openLargeBackupFile(directory,path){
 if(typeof path!=='string'||path.length>1400)throw new Error('备份中的附件路径无效。');
 const parts=path.split('/');
 if(parts.some(part=>!part||part==='.'||part==='..'||/[\\:\u0000-\u001f]/.test(part))){
  throw new Error('备份中的附件路径无效。');
 }
 let folder=directory;
 try{
  for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);
  return (await folder.getFileHandle(parts.at(-1))).getFile();
 }catch(error){throw new Error('备份目录缺少文件或无法读取：'+path);}
}

const restoreFolderButton=document.createElement('button');
restoreFolderButton.type='button';
restoreFolderButton.className='secondary';
restoreFolderButton.textContent='从备份文件夹恢复';
restoreFolderButton.hidden=!window.showDirectoryPicker;
$('writeFolder').after(restoreFolderButton);
restoreFolderButton.onclick=async()=>{
 if(!ensureReady()||restoreFolderButton.disabled)return;
 let directory;
 try{directory=await window.showDirectoryPicker({mode:'read'});}
 catch(error){if(error.name!=='AbortError')$('importMessage').textContent=error.message;return;}
 await restoreWorkspaceBackup(async()=>{
  const manifest=await openLargeBackupFile(directory,'backup.json');
  if(manifest.size>128*1024**2)throw new Error('备份清单过大。');
  return {backup:JSON.parse(await manifest.text()),zip:{directory}};
 },restoreFolderButton);
};
