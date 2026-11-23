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
  window.desktopLargeBackup={request,freeBytes:()=>request({type:'native-storage-space'})};

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
  async function writeFile(path,blob,index,count){
   const chunkSize=1024*1024;
   await request({type:'native-backup-file-start',path,size:blob.size},60000);
   for(let offset=0,seq=0;offset<blob.size;offset+=chunkSize,seq++){
    const chunk=blob.slice(offset,Math.min(blob.size,offset+chunkSize));
    const value=base64(new Uint8Array(await chunk.arrayBuffer()));
    await request({type:'native-backup-chunk',seq,data:value},120000);
    $('importMessage').textContent='正在流式备份 '+(index+1)+' / '+count+' · '+path
      +' · '+sizeLabel(Math.min(blob.size,offset+chunkSize))+' / '+sizeLabel(blob.size);
   }
   await request({type:'native-backup-file-finish'},60000);
  }

  $('writeFolder').textContent='流式备份到文件夹（大文件）';
  $('writeFolder').onclick=()=>withExport($('writeFolder'),async()=>{
   const estimate=estimatedBytes();
   const target=await request({type:'native-backup-choose'},5*60*1000);
   if(Number.isFinite(target.freeBytes)&&target.freeBytes>=0&&target.freeBytes<estimate+512*1024**2)
    throw new Error('目标磁盘空间不足。预计需要 '+sizeLabel(estimate)+'，当前可用 '+sizeLabel(target.freeBytes)+'。');
   const folderName='AnalogNotes-'+safeSegment(activeProfile().name)+'-'+today()+'-'+Date.now();
   await request({type:'native-backup-start',folderName,estimatedBytes:estimate},60000);
   try{
    const files=await folderContents(false,{large:true,onProgress:(name,done,total)=>{
     $('importMessage').textContent='正在校验 '+name+' · '+sizeLabel(done)+' / '+sizeLabel(total);
    }});
    files.push(files.shift());
    for(let index=0;index<files.length;index++)await writeFile(files[index].path,files[index].blob,index,files.length);
    await request({type:'native-backup-finish'},60000);
    markBackupExport();await refreshStorageSummary();
    $('importMessage').textContent='大文件备份已完成：'+target.path+'\\'+folderName;
    toast('大文件备份已完整保存');
   }catch(error){
    try{await request({type:'native-backup-cancel'},30000)}catch{}
    throw error;
   }
  });
 }
}
