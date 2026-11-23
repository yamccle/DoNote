'use strict';
// Desktop bridge for MinerU 4.x native PDF parsing.
(() => {
 const host=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
 if(!host)return;
 const pending=new Map(),progress=new Map(),chunkSize=256*1024;
 function key(type,id,seq='') {return type+':'+id+':'+seq}
 function cleanBlock(block){
  if(!block||typeof block!=='object')return block;
  const text=typeof block.text==='string'?wellFormedText(block.text):block.text;
  return text===block.text?block:{...block,text};
 }
 function request(message,type,timeout,signal){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const requestKey=key(type,message.id,type==='ack'?message.seq??-1:'');
   const finish=(error,value)=>{
    clearTimeout(timer);pending.delete(requestKey);
    signal?.removeEventListener('abort',abort);
    if(error)reject(error);else resolve(value);
   };
   const timer=setTimeout(()=>finish(new Error('MinerU 响应超时。')),timeout);
   const abort=()=>finish(signal.reason);
   signal?.addEventListener('abort',abort,{once:true});
   pending.set(requestKey,{id:message.id,finish});
   try{host.postMessage(message)}catch(error){finish(error)}
  });
 }
 host.addEventListener('message',event=>{
  const data=event.data;
  if(data?.type==='mineru-reflow-progress'){
   progress.get(data.id)?.(data.status);
   return;
  }
  if(!['mineru-reflow-ack','mineru-reflow-ready','mineru-reflow-result','mineru-reflow-error'].includes(data?.type))return;
  const resultType=data?.type==='mineru-reflow-result'?'result':data?.type==='mineru-reflow-ready'?'ready':'ack';
  const requestKey=key(resultType,data.id,resultType==='ack'?data.seq:'');
  const entry=pending.get(requestKey)||(data.error&&[...pending.values()].find(item=>item.id===data.id));
  entry?.finish(data.error?new Error(data.error):null,data);
 });
 function base64(bytes){
  let value='';
  for(let offset=0;offset<bytes.length;offset+=8192)value+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return btoa(value);
 }

 window.MinerUReflow={
  available:true,
  async create(blob,{signal,onProgress=()=>{}}={}){
   if(!(blob instanceof Blob)||!blob.size)throw new Error('PDF 文件不可用。');
   const documentId=crypto.randomUUID();
   let closed=false;
   const close=()=>{
    if(closed)return;
    closed=true;
    signal?.removeEventListener('abort',close);
    try{host.postMessage({type:'mineru-close',id:documentId})}catch{}
   };
   signal?.throwIfAborted();
   signal?.addEventListener('abort',close,{once:true});
   try{
    await request({type:'mineru-open',id:documentId,size:blob.size},'ack',30000,signal);
    let previousPercent=-1;
    for(let offset=0,seq=0;offset<blob.size;offset+=chunkSize,seq++){
     signal?.throwIfAborted();
     const chunk=blob.slice(offset,offset+chunkSize);
     const data=base64(new Uint8Array(await chunk.arrayBuffer()));
     await request({type:'mineru-chunk',id:documentId,seq,data},'ack',120000,signal);
     const percent=Math.round((offset+chunk.size)/blob.size*100);
     if(percent!==previousPercent)onProgress('正在准备 PDF · '+percent+'%');
     previousPercent=percent;
    }
    await request({type:'mineru-ready',id:documentId},'ready',30000,signal);
   }catch(error){
    close();
    throw error;
   }
   const pages=new Map(),blankPages=new Set(),windows=new Map();
   let parseQueue=Promise.resolve();
   async function parseWindow(start,end,tier='flash',onProgress){
    const cacheKey=start+':'+end+':'+tier;
    if(windows.has(cacheKey))return windows.get(cacheKey);
    const task=parseQueue.catch(()=>{}).then(async()=>{
     if(closed)throw new DOMException('已取消','AbortError');
     const id=crypto.randomUUID();
     if(onProgress)progress.set(id,onProgress);
     try{
      const value=await request({type:'mineru-parse',id,documentId,start,end,tier},'result',22*60*1000,signal);
      if(!Array.isArray(value.pages))throw new Error('MinerU 没有返回页面结构。');
      for(const page of value.pages){
       const number=Number(page.page);
       pages.set(number,Array.isArray(page.blocks)?page.blocks.map(cleanBlock):[]);
       if(page.blank)blankPages.add(number);
      }
      return value;
     }catch(error){
      if(!closed)try{host.postMessage({type:'mineru-cancel',id})}catch{}
      throw error;
     }finally{progress.delete(id)}
    });
    parseQueue=task.catch(()=>{});
    windows.set(cacheKey,task);
    task.catch(()=>windows.delete(cacheKey));
    return task;
   }
   return {documentId,parseWindow,pageBlocks:page=>pages.get(Number(page))||null,pageIsBlank:page=>blankPages.has(page),close};
  }
 };
})();
