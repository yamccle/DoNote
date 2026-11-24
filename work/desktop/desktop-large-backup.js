/**
 * [INPUT]: 读取当前工作台的备份文件流和 Windows 消息接口。
 * [OUTPUT]: 按块写入本地备份或云端备份的临时目录。
 * [POS]: 本地备份与云端备份共用的文件写入入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
 const host=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
 if(host&&$('writeFolder')){
  const pending=new Map();
  function request(fields,timeout=120000){
   const id=crypto.randomUUID();
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('大文件备份操作超时。'))},timeout);
    pending.set(id,{resolve,reject,timer});
    host.postMessage({...fields,id});
   });
  }
  host.addEventListener('message',event=>{
   const data=event.data,entry=pending.get(data?.id);
   if(!entry||data?.type!=='native-backup-result')return;
   pending.delete(data.id);clearTimeout(entry.timer);
   if(data.error)entry.reject(new Error(data.error));
   else if(data.cancelled)entry.reject(new DOMException('已取消','AbortError'));
   else entry.resolve(data);
  });
  window.desktopLargeBackup={freeBytes:()=>request({type:'native-storage-space'}),estimatedBytes,writeSnapshot};

  function estimatedBytes(){
   let total=64*1024**2;
   for(const note of records)for(const attachment of note.attachments||[])total+=attachment.size||0;
   return Math.ceil(total*1.05);
  }
  function base64(bytes){
   let raw='';
   for(let offset=0;offset<bytes.length;offset+=8192)raw+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
   return btoa(raw);
  }
  async function writeFile(path,blob,index,count,report,isCancelled){
   const chunkSize=1024*1024;
   await request({type:'native-backup-file-start',path,size:blob.size},60000);
   for(let offset=0,seq=0;offset<blob.size;offset+=chunkSize,seq++){
    if(isCancelled())throw new DOMException('已取消','AbortError');
    const chunk=blob.slice(offset,Math.min(blob.size,offset+chunkSize));
    const value=base64(new Uint8Array(await chunk.arrayBuffer()));
    await request({type:'native-backup-chunk',seq,data:value},120000);
    report('正在流式备份 '+(index+1)+' / '+count+' · '+path
      +' · '+sizeLabel(Math.min(blob.size,offset+chunkSize))+' / '+sizeLabel(blob.size));
   }
   await request({type:'native-backup-file-finish'},60000);
  }

  async function writeSnapshot(folderName,estimate,report,{isCancelled=()=>false,restoreOnly=false}={}){
   try{
    await request({type:'native-backup-start',folderName,estimatedBytes:estimate},60000);
    const files=await folderContents(false,{large:true,restoreOnly,onProgress:(name,done,total)=>{
     if(isCancelled())throw new DOMException('已取消','AbortError');
     report('正在校验 '+name+' · '+sizeLabel(done)+' / '+sizeLabel(total));
    }});
    files.push(files.shift());
    for(let index=0;index<files.length;index++){
     if(isCancelled())throw new DOMException('已取消','AbortError');
     await writeFile(files[index].path,files[index].blob,index,files.length,report,isCancelled);
    }
    return await request({type:'native-backup-finish'},60000);
   }catch(error){
    try{await request({type:'native-backup-cancel'},30000)}catch{}
    throw error;
   }
  }
  $('writeFolder').textContent='流式备份到文件夹（大文件）';
  $('writeFolder').onclick=()=>withExport($('writeFolder'),async()=>{
   const estimate=estimatedBytes();
   const target=await request({type:'native-backup-choose'},5*60*1000);
   if(Number.isFinite(target.freeBytes)&&target.freeBytes>=0&&target.freeBytes<estimate+512*1024**2)
    throw new Error('目标磁盘空间不足。预计需要 '+sizeLabel(estimate)+'，当前可用 '+sizeLabel(target.freeBytes)+'。');
   const folderName='AnalogNotes-'+safeSegment(activeProfile().name)+'-'+today()+'-'+Date.now();
   const result=await writeSnapshot(folderName,estimate,message=>{$('importMessage').textContent=message});
   markBackupExport();await refreshStorageSummary();
   $('importMessage').textContent='大文件备份已完成：'+result.path;
   toast('大文件备份已完整保存');
  });
 }
}
