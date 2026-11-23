'use strict';

function installVideoTranslationChooser(root,job,session,runTranslation){
 const signal=session.controller.signal;
 const chooser=root.querySelector('.video-translation-chooser');
 const find=name=>chooser.querySelector('[data-method="'+name+'"]');
 const select=chooser.querySelector('select');
 const requestPanel=chooser.querySelector('[data-external-request]');
 const status=chooser.querySelector('[data-external-status]');
 const actions=chooser.querySelector('[data-external-actions]');
 const send=find('send'),authorize=find('authorize'),copy=find('copy'),withdraw=find('withdraw');
 let current=null,busy=false,timer;
 const identity=()=>({profileId:job.profileId,recordId:job.ownerId,fileId:job.fileId});
 const liveConnection=()=>bridgeConnection?.profileId===job.profileId&&appState.activeId===job.profileId;
 const isActive=()=>['waiting','accepted'].includes(current?.state);
 const pendingLines=()=>job.cues.filter(cue=>cue.en?.trim()&&!cue.zh?.trim()).length;
 function describeRequestError(error){
  if(error.status!==404)return error.message;
  return bridgeConnection?.kind==='local'
   ?'本机接入服务缺少字幕请求接口。请到「助手设置」点击「启动并连接本机服务」。'
   :'接入服务缺少字幕请求接口。请将该服务升级到 1.3.0 或更新版本后重新连接。';
 }
 const instruction=()=>current?
  '请使用 DoNote 的 take_subtitle_translation_request 工具领取任务 '+current.id+
  '，翻译《'+current.fileName+'》的空白中文字幕。每次读取和写入都传入该 subtitleRequestId，分批写回并确认已保存。':'';

 function updateRequest(value){
  if(!value||value.recordId!==job.ownerId)return;
  current=value;
  copy.hidden=withdraw.hidden=!isActive();
  send.disabled=busy||isActive()||!select.value||!pendingLines();
  const labels={
   waiting:'已排队，等待 '+value.agentName+' 接手。可复制指令发给助手。',
   accepted:value.agentName+' 已接手，尚有 '+pendingLines()+' 条英文字幕待译。',
   completed:'已写回中文字幕。',
   cancelled:'已撤回待处理请求。',
   unavailable:'此助手的字幕权限已关闭。请重新授权或选择其他助手。',
   expired:'翻译请求已过期，可重新发送。'
  };
  status.textContent=labels[value.state]||'';
 }

 async function refreshRequest(){
  if(signal.aborted||!liveConnection()||!job.ownerId)return;
  const args=new URLSearchParams(identity());
  const {request}=await bridgeApi('/api/admin/subtitle-requests?'+args);
  if(signal.aborted)return;
  if(request&&['waiting','accepted'].includes(request.state)&&!pendingLines()){
   const result=await bridgeApi('/api/admin/subtitle-requests/'+request.id,{method:'POST',body:{
    profileId:job.profileId,state:'completed'
   }});
   updateRequest(result.request);
   return;
  }
  updateRequest(request);
 }

 async function openExternal(){
  requestPanel.hidden=false;
  actions.hidden=true;
  send.disabled=true;
  status.textContent='';
  if(!job.ownerId){status.textContent='请先将视频保存到资料库。';return;}
  if(!liveConnection()){
   status.textContent='请先在 AI 管理连接外部助手。';
   return;
  }
  status.textContent='正在查找已授权的助手…';
  try{
   const {agents}=await bridgeApi('/api/admin/agents');
   if(signal.aborted)return;
   const list=agents.filter(agent=>agent.profileId===job.profileId&&!agent.revoked&&
    ['subtitles:read','subtitles:write'].every(scope=>agent.scopes.includes(scope)));
   select.replaceChildren(...list.map(agent=>new Option(agent.name,agent.id)));
   actions.hidden=!list.length;
   status.textContent=list.length?(pendingLines()?'选择助手后发送当前视频的翻译请求。':'没有待译的英文字幕。'):
    '没有已授权的助手，请在 AI 管理启用字幕翻译。';
   send.disabled=!list.length||!pendingLines();
   await refreshRequest();
   clearInterval(timer);
   timer=setInterval(()=>{void refreshRequest().catch(()=>{});},3000);
  }catch(error){if(!signal.aborted){status.textContent=describeRequestError(error);if(error.status===404)actions.hidden=true;}}
 }
 function closeChooser(){
  chooser.hidden=true;
  root.querySelector('[data-act="translate-chooser"]').setAttribute('aria-expanded','false');
 }
 root.querySelector('[data-act="translate-chooser"]').onclick=()=>{
  chooser.hidden=!chooser.hidden;
  root.querySelector('[data-act="translate-chooser"]').setAttribute('aria-expanded',String(!chooser.hidden));
 };
 find('free').onclick=()=>{closeChooser();void runTranslation(true);};
 find('api').onclick=()=>{closeChooser();void runTranslation(false);};
 find('assistant').onclick=()=>void openExternal();
 authorize.onclick=()=>{
  $('openAiManager').click();
  $('bridgeAgentList').scrollIntoView({block:'nearest'});
 };
 send.onclick=async()=>{
  if(busy||job.kind||!pendingLines()||!liveConnection())return;
  busy=true;send.disabled=true;
  status.textContent='正在发送请求…';
  try{
   await publishBridgeSnapshot({onlyIfChanged:true});
   const {request}=await bridgeApi('/api/admin/subtitle-requests',{method:'POST',body:{
    ...identity(),agentId:select.value
   }});
   updateRequest(request);
   videoSubtitleJobStatus(job,'外部助手翻译请求已排队。');
  }catch(error){status.textContent=describeRequestError(error);}
  finally{busy=false;send.disabled=isActive()||!select.value||!pendingLines();}
 };
 copy.onclick=async()=>{
  if(!isActive())return;
  try{
   await navigator.clipboard.writeText(instruction());
   status.textContent='指令已复制。粘贴到已连接 DoNote 的助手对话。';
  }catch(error){
   const field=chooser.querySelector('[data-instruction]');
   field.hidden=false;field.value=instruction();field.select();
   status.textContent='请复制下方指令到助手对话。';
  }
 };
 withdraw.onclick=async()=>{
  if(busy||!isActive())return;
  busy=true;withdraw.disabled=true;
  try{
   const result=await bridgeApi('/api/admin/subtitle-requests/'+current.id,{method:'POST',body:{
    profileId:job.profileId,state:'cancelled'
   }});
   updateRequest(result.request);
  }catch(error){status.textContent=error.message;}
  finally{busy=false;withdraw.disabled=false;}
 };
 signal.addEventListener('abort',()=>clearInterval(timer),{once:true});
}
