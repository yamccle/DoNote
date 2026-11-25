/**
 * [INPUT]: 接收视频会话、字幕任务和桌面识别消息。
 * [OUTPUT]: 显示任务进度、当前字幕和可编辑的时间轴。
 * [POS]: 视频预览内的字幕面板，按资料库记录保存字幕。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
// Jobs live with the application, not the reader dialog. Each is tied to its original workspace and attachment.
const videoSubtitleJobs=new Map();
const videoSubtitleHost=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
const VIDEO_ASR_MODEL_KEY='donote-asr-model';
function selectedVideoAsrModel(){
 try{
  const value=localStorage.getItem(VIDEO_ASR_MODEL_KEY);
  if(['base','small','large-v3-turbo','large-v3'].includes(value))return value;
 }catch{}
 return 'small';
}
function videoSubtitleKey(s){return s.profileId+'/'+s.file.id}
function videoSubtitleNotify(job,changed){for(const view of job.views)view(changed)}
function videoSubtitleJobStatus(job,text,percent=null,changed){
 job.status=text;job.percent=percent;videoSubtitleNotify(job,changed);
 if(window.DoNoteTasks&&text){
  const running=!!(job.id||job.kind);
  const isCancel=/已取消|已停止/.test(text);
  const isErr=!running&&/失败|中断|未保存|超时|没有识别到/.test(text);
  const isDone=!running&&!isCancel&&!isErr&&/已生成|可导出/.test(text);
  const note=typeof appState!=='undefined'?appState?.profiles?.find(p=>p.id===job.profileId)?.records?.find(n=>n.id===job.ownerId):null;
  window.DoNoteTasks.upsert('asr:'+job.profileId+':'+job.fileId,{
   kind:job.kind==='translation'?'translate':'asr',
   title:(note?.title?note.title.slice(0,16)+' · ':'')+(job.kind==='translation'?'字幕同步翻译':'视频语音识别'),
   detail:text,
   percent:isDone?100:percent,
   state:running?'running':isCancel?'cancelled':isErr?'error':isDone?'done':'running',
   onOpen:job.ownerId?()=>{if(typeof openResource==='function')void openResource(job.ownerId)}:null
  });
 }
}
// 识别时同步翻译：识别出一条英文字幕就立即离线翻译一条，边识别边出中文。
const VIDEO_AUTO_TRANSLATE_KEY='donote-auto-subtitle-translate';
function videoAutoTranslateEnabled(){try{return localStorage.getItem(VIDEO_AUTO_TRANSLATE_KEY)!=='off'}catch{return true}}
function videoSyncSuffix(job){
 const auto=job.auto;
 if(!auto?.enabled||!auto.done)return '';
 return ' · 已同步翻译 '+auto.done+' 条'+(auto.failed?'（已中断）':'');
}
function settleVideoAutoTranslation(job){
 const auto=job.auto;if(!auto)return;
 if(auto.running||auto.queue.length||job.id)return;
 if(job.kind==='translation'&&job.translationController===auto.controller){
  job.kind=null;job.translationController=null;
  if(auto.controller.signal.aborted)videoSubtitleJobStatus(job,'已停止同步翻译。'+(auto.done?' 已同步 '+auto.done+' 条。':''));
  else if(!auto.failed)videoSubtitleJobStatus(job,job.ownerId?'英文字幕与中文字幕已生成，请核对专业术语及数字。':'英文字幕已生成，本次字幕可导出。',100);
  videoSubtitleNotify(job);
 }
}
async function drainVideoAutoTranslation(job){
 const auto=job.auto;
 if(!auto?.enabled||auto.running||auto.failed||auto.controller.signal.aborted)return;
 auto.running=true;
 let lastSave=Date.now();
 try{
  while(auto.enabled&&!auto.controller.signal.aborted){
   if(!auto.queue.length)break;
   const batch=[],batchIndices=[];
   for(const index of auto.queue.splice(0,8)){
    const cue=job.cues[index];
    if(cue&&cue.en.trim()&&!cue.zh.trim()){batch.push(cue);batchIndices.push(index)}
   }
   if(!batch.length)continue;
   await translateVideoSubtitlesFree(batch,{
    signal:auto.controller.signal,
    onProgress:()=>{
     if(!job.id)videoSubtitleJobStatus(job,'正在同步翻译剩余字幕 '+auto.done+' 条…');
    },
    onTranslated(localIndex,value){
     const index=batchIndices[localIndex],cue=job.cues[index];
     if(!cue||cue.zh===value)return;
     cue.zh=value;auto.done++;
     videoSubtitleJobStatus(job,job.id
      ?'正在识别，已显示 '+job.recognitionCues+' 条英文字幕'+videoSyncSuffix(job)+'…'
      :'正在同步翻译剩余字幕 '+auto.done+' 条…',job.percent,[index]);
     if(job.ownerId&&Date.now()-lastSave>=5000){lastSave=Date.now();videoSubtitleSave(job).catch(()=>{})}
    }
   });
  }
 }catch(error){
  if(auto.controller.signal.aborted){/* 取消时由 cancel 分支收尾 */}
  else{
   auto.failed=true;
   videoSubtitleJobStatus(job,'同步翻译中断：'+error.message+(auto.done?' 已同步 '+auto.done+' 条。':''));
  }
 }finally{
  auto.running=false;
  if(auto.enabled&&!auto.failed&&auto.queue.length&&!auto.controller.signal.aborted){void drainVideoAutoTranslation(job);return}
  settleVideoAutoTranslation(job);
  if(auto.done&&job.ownerId&&!auto.failed)videoSubtitleSave(job).catch(()=>{});
 }
}
function videoSubtitleRejectAck(job,error){if(!job.ack)return;clearTimeout(job.ack.timer);const reject=job.ack.reject;job.ack=null;reject(error)}
function videoSubtitleSend(job,message,seq){return new Promise((resolve,reject)=>{
 if(job.id!==message.id){reject(new Error('识别已取消。'));return}
 const timer=setTimeout(()=>{job.ack=null;reject(new Error('视频传输超时，请重试。'))},30000);
 job.ack={seq,resolve,reject,timer};try{videoSubtitleHost.postMessage(message)}catch(e){videoSubtitleRejectAck(job,e)}
})}
async function videoSubtitleSave(job){
 const snapshot=structuredClone(job.cues);
 readingSaveQueue=readingSaveQueue.catch(()=>{}).then(async()=>{
  const next=structuredClone(appState),note=next.profiles.find(p=>p.id===job.profileId)?.records.find(n=>n.id===job.ownerId);
  if(!note||!note.attachments?.some(a=>a.id===job.fileId))throw new Error('原视频已删除，字幕无法保存。');
  note.videoSubtitles??={};note.videoSubtitles[job.fileId]=snapshot;await commitState(next);
 });return readingSaveQueue;
}
async function videoSubtitleStream(job,blob,model){
 const id=job.id;
 const ack=await videoSubtitleSend(job,{type:'video-transcribe',id,model,size:blob.size,source:'range-v1'},-1);
 if(ack?.source==='range-v1'){
  if(job.id!==id)return;
  videoSubtitleJobStatus(job,'正在加载本地模型…');
  videoSubtitleHost.postMessage({type:'video-transcribe-finish',id});
  return;
 }
 const chunkSize=256*1024;
 let lastPercent=0;
 for(let offset=0,seq=0;offset<blob.size;offset+=chunkSize,seq++){
  if(job.id!==id)throw new Error('识别已取消。');
  const bytes=new Uint8Array(await blob.slice(offset,offset+chunkSize).arrayBuffer());
  if(job.id!==id)throw new Error('识别已取消。');
  await videoSubtitleSend(job,{type:'video-transcribe-chunk',id,seq,data:encodeVideoBytes(bytes)},seq);
  if(job.id!==id)throw new Error('识别已取消。');
  const percent=Math.round(Math.min(blob.size,offset+chunkSize)/blob.size*100);
  if(percent!==lastPercent){
   lastPercent=percent;
   videoSubtitleJobStatus(job,'正在准备视频 '+percent+'%',percent);
  }
 }
 if(job.id===id){videoSubtitleJobStatus(job,'正在准备识别组件和模型…');videoSubtitleHost.postMessage({type:'video-transcribe-finish',id})}
}
function encodeVideoBytes(bytes){
 if(typeof bytes.toBase64==='function')return bytes.toBase64();
 let raw='';
 for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(raw);
}
async function respondVideoRange(job,{id,offset,length}){
 const blob=job.sourceBlob;
 if(!blob||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||
    offset<0||length<1||length>1024*1024||offset+length>blob.size)return;
 let bytes;
 try{bytes=new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer())}catch{}
 if(job.id===id)videoSubtitleHost.postMessage({type:'video-transcribe-range',id,offset,data:bytes?encodeVideoBytes(bytes):''});
}
function checkedAsrCues(values){
 if(!Array.isArray(values))return [];
 return values.filter(c=>Number.isFinite(c?.start)&&Number.isFinite(c?.end)&&c.start>=0&&c.end>c.start&&
   typeof c.en==='string'&&c.en.trim()).map(c=>({start:c.start,end:c.end,en:c.en,zh:''}));
}
function appendAsrCues(job,values){
 const cues=checkedAsrCues(values);
 if(!cues.length)return;
 // 重新生成时第一批结果会清空旧字幕：必须先重置，再取起始下标，
 // 否则新字幕会按旧字幕的条数偏移，导致开头的字幕不进翻译队列。
 if(!job.recognitionCues)job.cues=[];
 job.recognitionCues=(job.recognitionCues||0)+cues.length;
 const startIndex=job.cues.length;
 job.cues.push(...cues);
 videoSubtitleJobStatus(job,'正在识别，已显示 '+job.recognitionCues+' 条英文字幕'+videoSyncSuffix(job)+'…',job.percent);
 // 识别时同步翻译：新识别出的英文字幕立即进入翻译队列。
 if(job.auto?.enabled&&!job.auto.failed&&!job.auto.controller.signal.aborted){
  for(let index=startIndex;index<job.cues.length;index++)job.auto.queue.push(index);
  void drainVideoAutoTranslation(job);
 }
 if(job.ownerId&&Date.now()-job.lastRecognitionSave>=15000){
  job.lastRecognitionSave=Date.now();
  videoSubtitleSave(job).catch(()=>{});
 }
}
async function finishAsrJob(job,error){
 job.id=null;job.sourceBlob=null;
 const count=job.recognitionCues;
 if(error)job.auto?.controller.abort();
 try{
  if(count&&job.ownerId){
   videoSubtitleJobStatus(job,'正在保存已生成的英文字幕…',job.percent);
   await videoSubtitleSave(job);
  }
  const auto=job.auto;
  const autoPending=auto?.enabled&&!auto.failed&&!auto.controller.signal.aborted&&(auto.queue.length||auto.running);
  if(error)videoSubtitleJobStatus(job,error+(count?' 已保留 '+count+' 条英文字幕。':''));
  else if(autoPending){
   // 识别结束但翻译还没跟上：转入“翻译中”阶段，让取消按钮与进度继续生效。
   job.kind='translation';job.translationController=auto.controller;
   videoSubtitleJobStatus(job,'英文字幕已生成，正在同步翻译剩余字幕…',job.percent);
  }
  else if(count)videoSubtitleJobStatus(job,job.ownerId?(auto?.done?'英文字幕与中文字幕已生成，请核对专业术语及数字。':'英文字幕已生成，请校对后翻译。'):'英文字幕已生成，本次字幕只能导出。',100);
  else videoSubtitleJobStatus(job,'没有识别到语音。');
 }catch(failure){
  videoSubtitleJobStatus(job,'字幕未保存：'+failure.message);
 }finally{
  if(job.kind==='recognition')job.kind=null;
  if(job.kind!=='translation')job.translationController=null;
  videoSubtitleNotify(job);
  settleVideoAutoTranslation(job);
 }
}
videoSubtitleHost?.addEventListener('message',event=>{
 const data=event.data,job=[...videoSubtitleJobs.values()].find(item=>item.id&&item.id===data?.id);if(!job)return;
 if(data.type==='video-transcribe-ack'){if(job.ack&&data.seq===job.ack.seq){clearTimeout(job.ack.timer);const resolve=job.ack.resolve;job.ack=null;resolve(data)}return}
 if(data.type==='video-transcribe-range-request'){void respondVideoRange(job,data).catch(()=>{});return}
 if(data.type==='video-transcribe-segments'){appendAsrCues(job,data.segments);return}
 if(data.type==='video-transcribe-progress'){videoSubtitleJobStatus(job,data.status||'正在识别…',Number.isFinite(data.percent)?Math.max(0,Math.min(100,data.percent)):null);return}
 if(data.type!=='video-transcribe-result')return;
 if(data.error)videoSubtitleRejectAck(job,new Error(data.error));
 if(!data.error&&Array.isArray(data.segments)&&!job.recognitionCues)appendAsrCues(job,data.segments);
 const error=data.error||(Number.isInteger(data.count)&&data.count!==job.recognitionCues?'部分识别结果未接收完整。':'');
 void finishAsrJob(job,error);
});
function mountVideoSubtitles(session,blob,content){
 const video=session.video,signal=session.controller.signal,key=videoSubtitleKey(session);
 let job=videoSubtitleJobs.get(key);
 if(!job){const profile=appState.profiles.find(p=>p.id===session.profileId),note=profile?.records.find(n=>n.id===session.ownerId);job={profileId:session.profileId,ownerId:session.ownerId,fileId:session.file.id,cues:structuredClone(note?.videoSubtitles?.[session.file.id]||[]),views:new Set(),kind:null,id:null,status:'',percent:null};videoSubtitleJobs.set(key,job)}
 const root=document.createElement('section');root.className='video-subtitles';
 root.innerHTML = `
  <div class="video-subtitles-head">
   <div class="video-subtitles-title"><strong>视频字幕</strong><span class="video-subtitles-caption">本地识别 · 可在设置中选择模型</span></div>
   <div class="video-subtitles-actions">
    <label class="video-subtitles-auto" title="识别出英文字幕时立即用离线翻译生成中文，边识别边翻译"><input type="checkbox" data-act="auto-translate"> 识别时同步翻译</label>
    <button type="button" data-act="generate">生成英文字幕</button>
    <button type="button" class="primary" data-act="translate-chooser" aria-expanded="false">翻译为中文</button>
    <button type="button" data-act="export">导出 SRT</button>
   </div>
  </div>
  <div class="video-translation-chooser" hidden>
   <div class="video-subtitles-actions" role="group" aria-label="字幕翻译方式">
    <button type="button" data-method="free">离线字幕翻译</button>
    <button type="button" data-method="api">AI / API</button>
    <button type="button" data-method="assistant">外部助手</button>
   </div>
   <div data-external-request hidden>
    <p class="video-subtitles-note" data-external-status role="status"></p>
    <div class="video-subtitles-actions">
     <div data-external-actions hidden>
      <select aria-label="翻译助手"></select>
      <button type="button" class="primary" data-method="send">发送翻译请求</button>
     </div>
     <button type="button" data-method="copy" hidden>复制给助手的指令</button>
     <button type="button" data-method="withdraw" hidden>撤回请求</button>
     <button type="button" data-method="authorize">助手设置</button>
    </div>
    <textarea data-instruction aria-label="给助手的指令" readonly hidden></textarea>
   </div>
  </div>
  <p class="video-subtitles-note" data-detached-note hidden>此视频未存入资料库，字幕可导出。</p>
  <div class="video-subtitles-task" hidden>
   <div class="video-subtitles-task-line">
    <p class="video-subtitles-status" role="status"></p>
    <button type="button" data-act="cancel" hidden>取消识别</button>
   </div>
   <progress class="video-subtitles-progress" max="100" aria-label="字幕任务进度" hidden></progress>
  </div>
  <div class="video-subtitles-playhead">
   <div class="video-subtitles-current" aria-live="off"></div>
   <button type="button" data-act="locate" hidden>定位当前句</button>
  </div>
  <div class="video-subtitles-list"></div>
 `;

 content.append(root);
 root.querySelector('[data-detached-note]').hidden=!!session.ownerId;
 const list=root.querySelector('.video-subtitles-list'),status=root.querySelector('.video-subtitles-status'),current=root.querySelector('.video-subtitles-current'),progress=root.querySelector('progress');
 const task=root.querySelector('.video-subtitles-task'),playhead=root.querySelector('.video-subtitles-playhead');
 const button=name=>root.querySelector('[data-act="'+name+'"]');
 const locate=button('locate');
 const autoToggle=button('auto-translate');
 autoToggle.checked=videoAutoTranslateEnabled();
 autoToggle.closest('label').hidden=!videoSubtitleHost;
 autoToggle.addEventListener('change',()=>{
  try{localStorage.setItem(VIDEO_AUTO_TRANSLATE_KEY,autoToggle.checked?'on':'off')}catch{}
  if(job.auto){
   job.auto.enabled=autoToggle.checked&&!!videoSubtitleHost;
   if(!job.auto.enabled)job.auto.controller.abort();
  }
 });
 let lastCues, fields=[], timeline=[], activeRow;
 if(typeof installVideoLearningControls==='function')installVideoLearningControls(root,video,()=>job.cues,signal);
 if(typeof installVideoSubtitleOverlay==='function')installVideoSubtitleOverlay(root,video,()=>job.cues,signal);
 function time(value){const t=Math.max(0,Number(value)||0),h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=Math.floor(t)%60;return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':')}
 function srtTime(value){const ms=Math.max(0,Math.round((Number(value)||0)*1000));return time(ms/1000)+','+String(ms%1000).padStart(3,'0')}
 function showCurrent(force=false){
  const position=video.currentTime;
  let low=0,high=timeline.length;
  while(low<high){
   const mid=(low+high)>>>1;
   if(timeline[mid].start<=position)low=mid+1;else high=mid;
  }
  let entry;
  for(let index=low-1;index>=0&&timeline[index].latestEnd>position;index--){
   if(timeline[index].end>position){entry=timeline[index];break}
  }
  const row=fields[entry?.index];
  if(!force&&activeRow===row)return;
  activeRow?.row.classList.remove('is-current');
  activeRow?.jump.removeAttribute('aria-current');
  activeRow=row;
  playhead.classList.toggle('has-cue',!!row);
  locate.hidden=!row;
  if(!row){current.textContent='播放时显示当前字幕';return}
  row.row.classList.add('is-current');
  row.jump.setAttribute('aria-current','time');
  const cue=entry.cue;
  const en=document.createElement('div'),zh=document.createElement('div');
  en.textContent=cue.en;zh.textContent=cue.zh||'';
  current.replaceChildren(en,zh);
 }
 function cuesChanged(indices){
  list.dispatchEvent(new CustomEvent('donote-video-cues-changed',{detail:indices}));
  showCurrent(true);
 }
 function render(){
  const rows=document.createDocumentFragment();
  fields=[];
  job.cues.forEach((cue,index)=>fields.push(createCueRow(cue,index,rows)));
  timeline=job.cues.map((cue,index)=>({cue,index,start:cue.start,end:cue.end}))
   .filter(entry=>Number.isFinite(entry.start)&&entry.end>entry.start).sort((a,b)=>a.start-b.start);
  let latestEnd=0;
  for(const entry of timeline)entry.latestEnd=latestEnd=Math.max(latestEnd,entry.end);
  list.replaceChildren(rows);
  if(!fields.length)list.textContent='尚无字幕。生成后可点击时间跳转、修改英文与中文。';
  cuesChanged();
 }
 function createCueRow(cue,index,rows){
   const row=document.createElement('div');
   row.className='video-subtitle-row';
   const jump=document.createElement('button');
   jump.type='button';jump.className='video-subtitle-time';
   jump.textContent=time(cue.start);jump.title='跳转到此处';
   jump.onclick=()=>{video.currentTime=cue.start;void video.play().catch(()=>{})};
   const detail=document.createElement('details');
   detail.className='video-subtitle-detail';
   const summary=document.createElement('summary');
   summary.title='展开或收起字幕编辑';
   const preview=document.createElement('span');
   preview.className='video-subtitle-preview';
   const texts=document.createElement('div');
   texts.className='video-subtitle-texts';
   const inputs={},previews={};
   for(const [key,label] of [['en','英文字幕'],['zh','中文字幕']]){
    const line=previews[key]=document.createElement('span');
    line.textContent=cue[key]||'';
    preview.append(line);
    const field=inputs[key]=document.createElement('textarea');
    field.rows=2;field.value=cue[key]||'';field.disabled=!!job.kind;
    field.placeholder=label;field.setAttribute('aria-label',label+' '+(index+1));
    field.addEventListener('change',()=>{
     const value=field.value.trim();
     if(value===cue[key])return;
     cue[key]=value;
     const message=key==='en'&&cue.zh?'英文已修改，对应中文可能过期，请检查或重新翻译。':job.status;
     videoSubtitleJobStatus(job,message,job.percent,[index]);
     if(job.ownerId)videoSubtitleSave(job).catch(error=>videoSubtitleJobStatus(job,'字幕未保存：'+error.message));
    });
    texts.append(field);
   }
   summary.append(preview);
   detail.append(summary,texts);
   row.append(jump,detail);rows.append(row);
   return {...inputs,previews,row,jump,summary};
 }
 function appendCueRows(){
  const rows=document.createDocumentFragment(),changed=[];
  for(let index=fields.length;index<job.cues.length;index++){
   const cue=job.cues[index],previous=timeline.at(-1);
   if(previous&&cue.start<previous.start){render();return}
   fields.push(createCueRow(cue,index,rows));
   timeline.push({cue,index,start:cue.start,end:cue.end,latestEnd:Math.max(previous?.latestEnd||0,cue.end)});
   changed.push(index);
  }
  list.append(rows);
  cuesChanged(changed);
 }
 let wasBusy;
 function update(changed){
  if(status.textContent!==job.status)status.textContent=job.status;
  const busy=!!job.kind,cancel=button('cancel');
  task.hidden=!busy&&!job.status;
  if(wasBusy!==busy){
   button('generate').disabled=busy;
   button('translate-chooser').disabled=busy;
   for(const choice of root.querySelectorAll('[data-method="free"],[data-method="api"],[data-method="assistant"]'))choice.disabled=busy;
   for(const pair of fields)pair.en.disabled=pair.zh.disabled=busy;
   wasBusy=busy;
  }
  cancel.disabled=!!job.translationController?.signal.aborted||!!job.savingTranslation||(!job.translationController&&!job.id);
  cancel.hidden=!busy;
  const cancelText=job.kind==='translation'?'取消翻译':'取消识别';
  if(cancel.textContent!==cancelText)cancel.textContent=cancelText;
  progress.hidden=!busy;
  if(job.percent===null)progress.removeAttribute('value');else progress.value=job.percent;
  if(lastCues!==job.cues){lastCues=job.cues;render()}
  else if(fields.length<job.cues.length)appendCueRows();
  else if(changed?.length){
   for(const index of changed){
    const {en,zh,previews}=fields[index],cue=job.cues[index];
    if(en.value!==cue.en)en.value=cue.en;
    if(zh.value!==(cue.zh||''))zh.value=cue.zh||'';
    if(previews.en.textContent!==cue.en)previews.en.textContent=cue.en;
    if(previews.zh.textContent!==(cue.zh||''))previews.zh.textContent=cue.zh||'';
   }
   cuesChanged(changed);
  }
 }
 job.views.add(update);
 signal.addEventListener('abort',()=>job.views.delete(update),{once:true});
 video.addEventListener('timeupdate',()=>showCurrent(),{signal});
 locate.onclick=()=>{
  const current=activeRow;
  if(!current||current.row.hidden)return;
  const bounds=current.row.getBoundingClientRect();
  const top=list.scrollTop+bounds.top-list.getBoundingClientRect().top;
  current.summary.focus({preventScroll:true});
  list.scrollTo({
   top:top-Math.max(0,(list.clientHeight-bounds.height)/2),
   behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'
  });
 };
 button('generate').onclick=()=>{
  if(!videoSubtitleHost){videoSubtitleJobStatus(job,'请在 DoNote Windows 桌面版使用本地识别。');return}
  if(job.kind||(job.cues.length&&!confirm('新字幕会替换当前字幕，确定重新识别吗？')))return;
  job.auto?.controller.abort();
  const autoOn=autoToggle.checked&&!!videoSubtitleHost;
  job.auto={enabled:autoOn,controller:new AbortController(),queue:[],done:0,failed:false,running:false};
  const id=job.id=crypto.randomUUID();
  job.kind='recognition';job.sourceBlob=blob;job.recognitionCues=0;job.lastRecognitionSave=0;
  videoSubtitleJobStatus(job,'正在准备当前视频…'+(autoOn?'（识别时同步翻译）':''),0);
  videoSubtitleStream(job,blob,selectedVideoAsrModel()).catch(error=>{
   if(job.id!==id)return;
   job.auto?.controller.abort();
   videoSubtitleHost.postMessage({type:'video-transcribe-cancel',id});
   void finishAsrJob(job,error.message);
  });
 };
 button('cancel').onclick=()=>{
  if(job.translationController){job.translationController.abort();if(job.auto)job.auto.enabled=false;videoSubtitleJobStatus(job,'正在停止翻译…');return}
  if(!job.id)return;
  job.auto?.controller.abort();if(job.auto)job.auto.enabled=false;
  videoSubtitleHost?.postMessage({type:'video-transcribe-cancel',id:job.id});
  videoSubtitleRejectAck(job,new Error('任务已取消。'));
  void finishAsrJob(job,'已停止识别。');
 };

 async function runTranslation(free) {
  if (job.kind) return;
  if (!job.cues.some(cue => cue.en.trim())) {
   videoSubtitleJobStatus(job, '请先生成英文字幕。');
   return;
  }
  if (free && !job.cues.some(cue => cue.en.trim() && !cue.zh?.trim())) {
   videoSubtitleJobStatus(job, '已有中文字幕，没有需要填补的空白字幕。');
   return;
  }
  let config;
  if (!free) {
   const trigger=root.querySelector('[data-method="api"]');
   trigger.disabled=true;
   try{config=await getAiModelConfig(job.profileId);}
   catch(error){videoSubtitleJobStatus(job,error.message);return;}
   finally{trigger.disabled=!!job.kind;}
   if(signal.aborted||job.kind||job.profileId!==appState.activeId)return;
   if(!config?.model){
    videoSubtitleJobStatus(job,'请在模型设置填写 API 地址、模型名和所需密钥，保存后再翻译。');
    void openAiModelSettings();return;
   }
   const replacement = job.cues.some(cue => cue.zh?.trim()) ? '已有中文字幕将重新翻译。' : '';
   if (!confirm('将英文字幕文本发送至你配置的 AI / API 服务。' + replacement + '继续吗？')) return;
  }
  const controller = new AbortController();
  const batch = [];
  let completed = 0, lastSave = Date.now(), checkpoint;
  job.kind = 'translation';
  job.translationController = controller;
  videoSubtitleJobStatus(job, free ? '正在加载离线翻译模型…' : '正在翻译…', free ? null : 0);

  let translated, error;
  try {
   const translate = free ? translateVideoSubtitlesFree : translateVideoSubtitles;
   translated = await translate(job.cues, {
    signal: controller.signal,
    profileId: job.profileId,
    config,
    onProgress(done,total){
     videoSubtitleJobStatus(job,'正在翻译 '+done+' / '+total+'…',total?Math.round(done/total*100):null,batch.splice(0));
     if(job.ownerId&&Date.now()-lastSave>=5000){
      lastSave=Date.now();
      checkpoint=videoSubtitleSave(job).catch(()=>{});
     }
    },
    onTranslated(index,value){
     job.cues[index].zh=value;
     batch.push(index);
     completed++;
    }
   });
   controller.signal.throwIfAborted();
  } catch (failure) {
   error = failure;
  }

  try {
   if ((!error && translated) || completed) {
    if(!error&&translated&&!completed)job.cues=translated;
    job.savingTranslation = true;
    videoSubtitleJobStatus(job,'正在保存译文…',null,batch.splice(0));
    await checkpoint;
    if (job.ownerId) await videoSubtitleSave(job);
   }
   if (error) {
    const message = controller.signal.aborted ? '已取消翻译。' : '翻译中断：' + error.message;
    const kept = completed ? ' 已保留 ' + completed + ' 条译文。' + (free ? '可继续翻译空白字幕。' : '') : '';
    videoSubtitleJobStatus(job, message + kept);
   } else {
    videoSubtitleJobStatus(job, job.ownerId ? '中文字幕已生成，请核对专业术语及数字。' :
     '中文字幕已生成，本次字幕可导出。', 100);
   }
  } catch (failure) {
   videoSubtitleJobStatus(job, '中文字幕未能保存：' + failure.message);
  } finally {
   job.savingTranslation = false;
   job.kind = null;
   job.translationController = null;
   videoSubtitleNotify(job);
  }
 }
 if(typeof installVideoTranslationChooser==='function')installVideoTranslationChooser(root,job,session,runTranslation);
 button('export').onclick=()=>{if(!job.cues.length){videoSubtitleJobStatus(job,'暂无字幕可导出。');return}const srt=job.cues.map((c,i)=>(i+1)+'\n'+srtTime(c.start)+' --> '+srtTime(c.end)+'\n'+c.en+(c.zh?'\n'+c.zh:'')).join('\n\n')+'\n';downloadBlob(session.file.name.replace(/\.[^.]+$/,'')+'.bilingual.srt',new Blob(['\ufeff'+srt],{type:'text/plain;charset=utf-8'}))};update();
}
