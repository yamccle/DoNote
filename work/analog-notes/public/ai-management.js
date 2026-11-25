/**
 * [INPUT]: 读取当前工作台记录快照、桌面宿主凭证消息与 AI 接入服务返回状态。
 * [OUTPUT]: 驱动精简版 #aiManager 弹窗，管理本机一键连接、助手令牌授权、MCP 校验与异步任务同步。
 * [POS]: 外部 AI 助手连接器前端控制层，桌面模式下默认收起高级地址与细粒度权限折叠区。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
let bridgeTaskFilter='recent';
let bridgeConnection=null,bridgeSyncing=false,bridgeTimer=null,bridgeIndicatorTimer=null,bridgeRestoreRequestedProfile=null;
function desktopAiHost(){return location.origin==='https://yams-one.example'&&window.chrome?.webview}
function persistBridgeConnection(){
 const desktop=desktopAiHost(),profileId=appState?.activeId;
 if(!desktop||!profileId)return;
 const connection=bridgeConnection,remember=$('bridgeRemember').checked;
 if(!connection||!remember)desktop.postMessage({type:'yams-one-ai-credential',action:'forget',profileId});
 else desktop.postMessage({type:'yams-one-ai-credential',action:'save',profileId,kind:connection.kind,baseUrl:connection.base,adminToken:connection.kind==='remote'?connection.token:null});
}
function requestStoredBridge(force=false){
 const desktop=desktopAiHost(),profileId=appState?.activeId;
 if(!desktop||!ready||!profileId||bridgeConnection?.profileId===profileId||(!force&&bridgeRestoreRequestedProfile===profileId))return;
 bridgeRestoreRequestedProfile=profileId;
 desktop.postMessage({type:'yams-one-ai-credential',action:'restore',profileId});
}
const bridgeScopeLabels={'records:read':'读取已发布快照','records:create':'新增记录','records:update':'更新记录（需版本校验）','records:delete':'删除记录及附件','files:read':'读取服务中已有附件','files:write':'上传附件','subtitles:read':'读取视频字幕','subtitles:write':'写入视频字幕'};
function bridgeBase(value){const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('请填写有效服务地址。');if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('云端服务需要 HTTPS，本机地址可使用 HTTP。');return url.href.replace(/\/$/,'')}
async function bridgeApi(route,{method='GET',body,raw=false}={}){
 const connection=bridgeConnection;
 if(!connection||connection.profileId!==appState.activeId)throw new Error('请为当前用户连接 AI 接入服务。');
 const res=await fetch(connection.base+route,{method,headers:{Authorization:'Bearer '+connection.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(raw?180000:30000)});
 if(connection!==bridgeConnection||connection.profileId!==appState.activeId)throw new Error('连接或用户已切换，请稍后重试。');
 if(!res.ok){let error;try{error=(await res.json()).error}catch{}throw Object.assign(new Error(error||'接入服务返回 HTTP '+res.status),{status:res.status,retryable:res.status>=500||[401,429].includes(res.status)})}return raw?res.blob():res.json();
}
function bridgeStatus(text,error=false){$('bridgeStatus').textContent=text;$('bridgeStatus').classList.toggle('bridge-error',error)}
const bridgePdfText=new Map();
async function bridgePdfExcerpt(file,profileId){
 if(!file||file.size>24*1024**2)return '';
 const key=fileKey(profileId,file.id);
 if(bridgePdfText.has(key))return bridgePdfText.get(key);
 let task,text='';
 try{
  const library=await pdfLibrary(),blob=await readBlob(file.id,profileId);
  task=await localPdfTask(library,blob);
  const pdf=await task.promise;
  for(let i=1;i<=Math.min(20,pdf.numPages)&&text.length<50000;i++){
   const page=await pdf.getPage(i),content=await page.getTextContent();
   text+='\n'+content.items.map(item=>item.str||'').join(' ');
  }
  text=text.trim().slice(0,50000);
 }catch{}finally{await task?.destroy().catch(()=>{})}
 if(bridgePdfText.size>=60)bridgePdfText.delete(bridgePdfText.keys().next().value);
 bridgePdfText.set(key,text);return text;
}
async function publishBridgeSnapshot({onlyIfChanged=false}={}){
 const connection=bridgeConnection;
 const p=activeProfile(),includeBody=$('bridgeIncludeBody').checked,includePdf=includeBody&&$('bridgeIncludePdf').checked;
 const summaries=new Map();let budget=2_000_000,pdfCount=0;
 if(includeBody)for(const note of [...p.records].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))){
  if(budget<=0)break;
  if(connection!==bridgeConnection||appState.activeId!==p.id)throw new Error('工作台已切换，请重新发布。');
  const file=includePdf&&pdfCount<30?note.attachments?.find(fileIsPdf):null;
  if(file)pdfCount++;
  const body=[note.body,note.webArticle?.searchText,file?await bridgePdfExcerpt(file,p.id):''].filter(Boolean).join('\n\n').slice(0,Math.min(150000,budget));
  if(body){summaries.set(note.id,body);budget-=body.length}
 }
 const snapshot={id:p.id,name:p.name,categories:categoryList().map(({id,name,statuses})=>({id,name,statuses})),topics:p.topics,includeBody,records:p.records.map(n=>({id:n.id,type:n.type,title:n.title,literature:n.literature,author:n.author||'',tags:n.tags,status:n.status,updatedAt:n.updatedAt,planStart:n.planStart,planEnd:n.planEnd,planTrack:n.planTrack,folderPath:folderPathParts(n.folderId,folderScope(n.type),p),relatedResources:n.relatedResources,body:includeBody?summaries.get(n.id):undefined,attachments:(n.attachments||[]).map(({id,name,mime,size})=>({id,name,mime,size}))}))};
 if(connection!==bridgeConnection||appState.activeId!==p.id)throw new Error('工作台已切换，请重新发布。');
 const serialized=JSON.stringify(snapshot);if(onlyIfChanged&&connection?.snapshot===serialized)return;
 await bridgeApi('/api/admin/profiles',{method:'POST',body:snapshot});connection.snapshot=serialized;
}
async function refreshBridgeLists(){
 const profileId=appState.activeId,[agents,tasks,audit]=await Promise.all([bridgeApi('/api/admin/agents'),bridgeApi('/api/admin/tasks?profileId='+encodeURIComponent(profileId)),bridgeApi('/api/admin/audit')]);
 if(appState.activeId!==profileId)return;
 $('bridgeAgentList').innerHTML=agents.agents.filter(a=>a.profileId===profileId&&!a.revoked).map(a=>'<div class="manager-row"><span><b>'+esc(a.name)+'</b><small class="profile-meta">'+a.scopes.map(s=>esc(bridgeScopeLabels[s]||s)).join(' · ')+'</small></span><button class="secondary" data-subtitle-agent="'+a.id+'">'+(a.scopes.includes('subtitles:read')&&a.scopes.includes('subtitles:write')?'关闭字幕权限':'启用字幕翻译')+'</button><button class="danger" data-revoke-agent="'+a.id+'">删除凭证</button></div>').join('')||'<p class="section-note">当前用户还没有接入助手。</p>';
 for(const button of $('bridgeAgentList').querySelectorAll('[data-subtitle-agent]')){
  button.onclick=async()=>{
   const agent=agents.agents.find(item=>item.id===button.dataset.subtitleAgent);
   const enabled=agent.scopes.includes('subtitles:read')&&agent.scopes.includes('subtitles:write');
   if(!enabled&&!confirm('允许「'+agent.name+'」按需读取当前工作台的视频字幕并写回译文？原视频不会发送。'))return;
   button.disabled=true;
   try{
    await bridgeApi('/api/admin/agents/'+agent.id+'/subtitle-scopes',{method:'POST',body:{
     profileId,scopes:enabled?[]:['subtitles:read','subtitles:write']
    }});
    await refreshBridgeLists();
    bridgeStatus(enabled?'字幕权限已关闭。':'字幕权限已启用。请刷新外部助手的 DoNote 工具列表。');
   }catch(error){bridgeStatus(error.message,true);}
   finally{button.disabled=false;}
  };
 }
 $('bridgeAgentList').querySelectorAll('[data-revoke-agent]').forEach(button=>button.onclick=async()=>{if(!confirm('撤销并删除此助手凭证？删除后令牌立即失效且从列表移除，尚未同步的任务会被拒绝；已经写入的记录会保留。'))return;try{await bridgeApi('/api/admin/agents/'+button.dataset.revokeAgent+'/revoke',{method:'POST',body:{}});await refreshBridgeLists();bridgeStatus('助手凭证已撤销并删除。')}catch(e){bridgeStatus(e.message,true)}});
 const stateNames={pending:'待同步',applied:'已写入',rejected:'未写入'};
 const ordered=[...tasks.tasks].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')),pending=ordered.filter(t=>t.state==='pending').length,rejected=ordered.filter(t=>t.state==='rejected').length;
 const shown=(bridgeTaskFilter==='recent'?ordered:ordered.filter(t=>t.state===bridgeTaskFilter)).slice(0,5);
 $('bridgeTaskList').innerHTML='<div class="bridge-queue-summary"><span class="tiny">最近 '+shown.length+' 条 · 待同步 '+pending+' 条 · 未写入 '+rejected+' 条</span><div class="bridge-queue-filters">'+[['recent','最近任务'],['pending','待同步'],['rejected','未写入']].map(([key,label])=>'<button type="button" class="secondary" data-bridge-task-filter="'+key+'" aria-pressed="'+(bridgeTaskFilter===key)+'">'+label+'</button>').join('')+'</div></div>'+shown.map(t=>'<div class="manager-row"><span><b>'+esc(t.record.title||t.record.id)+'</b><small class="profile-meta">'+esc(t.agentName)+' · '+({create:'新增',update:'更新',delete:'删除'}[t.operation]||t.operation)+' · '+esc(stateNames[t.state]||t.state)+' · '+esc(t.createdAt)+(t.error?' · '+esc(t.error):'')+'</small></span>'+(t.state==='pending'?'<button class="secondary" data-reject-task="'+t.id+'">拒绝任务</button>':'')+'</div>').join('')||'<p class="section-note">暂无任务。</p>';
 for(const button of $('bridgeTaskList').querySelectorAll('[data-bridge-task-filter]'))button.onclick=()=>{bridgeTaskFilter=button.dataset.bridgeTaskFilter;refreshBridgeLists().catch(e=>bridgeStatus(e.message,true))};
 for(const button of $('bridgeTaskList').querySelectorAll('[data-reject-task]'))button.onclick=async()=>{try{await bridgeApi('/api/admin/tasks/'+button.dataset.rejectTask+'/result',{method:'POST',body:{state:'rejected',error:'用户拒绝同步此任务。'}});await refreshBridgeLists()}catch(e){bridgeStatus(e.message,true)}};
 $('bridgeAudit').textContent=audit.audit.slice(-15).reverse().map(e=>e.at+' · '+e.event+(e.taskId?' · '+e.taskId:'')).join('\n')||'暂无操作记录。';
}
async function applyBridgeTask(task){
 const profileId=appState.activeId;if(task.profileId!==profileId)throw new Error('任务所属用户不匹配。');
 if(bridgeSubtitleOperations.has(task.operation))return applyBridgeSubtitleTask(task,profileId);
 const already=activeProfile().aiApplied?.[task.id]||records.find(n=>n.aiSource?.taskId===task.id);if(already)return already.recordId||already.id;
 const data=task.record,now=new Date().toISOString(),type=data.type||records.find(n=>n.id===data.id)?.type;
 if(!statusOptions[type])throw new Error('目标栏目已删除，请让助手读取最新工作台配置后重试。');
 const previous=task.operation!=='create'?records.find(n=>n.id===data.id):null;
 if(task.operation!=='create'&&(!previous||previous.updatedAt!==data.baseUpdatedAt))throw new Error('原记录已变化或不存在，未覆盖内容；请基于最新版本重新提交。');
 if(task.operation==='delete'){
  if((await bridgeApi('/v1/tasks/'+task.id)).state!=='pending')return null;
  if(appState.activeId!==profileId||workspaceEditorActive())throw new Error('用户已切换或正在编辑，请稍后重试。');
  if(records.find(n=>n.id===data.id)?.updatedAt!==data.baseUpdatedAt)throw new Error('原记录已变化，未删除。');
  await removeWorkspaceRecords(new Set([data.id]),task.id);return data.id;
 }
 const id=previous?.id||'ai-'+task.id;
 if(!previous&&records.some(n=>n.id===id))throw new Error('记录编号冲突，未写入。');
 let note=previous?structuredClone(previous):{id,type,title:data.title,body:data.body||'',date:data.date||today(),author:data.author||'',reference:data.reference||'',url:data.url||'',tags:data.tags||[],status:data.status||statusOptions[type][0],pinned:false,attachments:[],relatedResources:[]};
 if(previous){
  for(const key of ['title','author','tags','status'])if(data[key]!==undefined)note[key]=structuredClone(data[key]);
  if(data.appendBody){
   const addition=type==='plan'?planMarkdown(data.appendBody).html:'<div>'+esc(data.appendBody).replace(/\n/g,'<br>')+'</div>';
   note=normalizeRichNote({...note,bodyHtml:noteBodyHtml(previous)+'<div><br></div>'+addition});
  }
 }else if(type==='plan'&&data.body)note=normalizeRichNote({...note,bodyHtml:planMarkdown(data.body).html});
 if(data.literature!==undefined){if(!validLiteratureData(data.literature))throw new Error('文献信息格式无效。');note.literature={...note.literature,...data.literature};note.reference=[note.literature.publication,note.literature.year].filter(Boolean).join(' · ')||note.reference;}
 for(const key of ['planStart','planEnd','planTrack','relatedResources'])if(data[key]!==undefined)note[key]=structuredClone(data[key]);
 if(type==='plan')note.date=note.planStart;
 if(data.relatedResources?.some(id=>!records.some(n=>n.id===id&&n.type==='resource')))throw new Error('有待关联的文献或视频已移除。');
 const writes=[];
 for(const [index,fileId]of(data.fileIds||[]).entries()){
  const manifest=await bridgeApi('/api/admin/tasks/'+task.id+'/files/'+encodeURIComponent(fileId)),blob=await bridgeApi('/v1/files/'+encodeURIComponent(fileId),{raw:true});
  if(blob.size!==manifest.size||await fileDigest(blob)!==manifest.sha256)throw new Error('助手附件校验失败。');
  const a={id:'ai-'+task.id+'-'+index,name:manifest.name,mime:manifest.mime,size:manifest.size,addedAt:now,aiBridgeFileId:fileId};note.attachments.push(a);writes.push({key:fileKey(profileId,a.id),blob:new Blob([blob],{type:manifest.mime})});
 }
 note.createdAt=previous?.createdAt||previous?.attachments?.[0]?.addedAt||previous?.date||now;
 note.updatedAt=now;note.aiSource={agentId:task.agentId,agentName:task.agentName,taskId:task.id,submittedAt:task.createdAt};
 if(note.attachments.length>MAX_ATTACHMENTS||!validate(note)||!statusOptions[type].includes(note.status))throw new Error('任务字段不符合当前记录规则。');
 if((await bridgeApi('/v1/tasks/'+task.id)).state!=='pending')return null;
 if(appState.activeId!==profileId||workspaceEditorActive())throw new Error('用户已切换或正在编辑，请稍后重试。');
 const next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId),latest=p.records.find(n=>n.id===id);
 if(previous&&latest?.updatedAt!==previous.updatedAt)throw new Error('同步时原记录发生变化，未覆盖。');
 if(data.folderPath!==undefined){const folderId=folderFromImportPath(p,folderScope(note.type),data.folderPath);if(folderId)note.folderId=folderId;else delete note.folderId;if(!validRecordFolders(p.folders))throw new Error('文件夹超过数量或层级限制。')}
 addNewTopicTags(p,note.tags);p.records=p.records.filter(n=>n.id!==id).concat(note);p.aiApplied=p.aiApplied||{};p.aiApplied[task.id]={recordId:id,at:now};await commitState(next,writes);return id;
}
async function syncBridge({silent=false,requestedSubtitlesOnly=false}={}){
 if(!ready||bridgeSyncing)return;
 if(!bridgeConnection||bridgeConnection.profileId!==appState.activeId){if(!silent)bridgeStatus('请先连接当前工作台的 AI 接入服务。',true);return}
 if(workspaceEditorActive()){if(!silent)bridgeStatus('请先保存或关闭编辑中的记录，再同步 AI 任务。',true);return}
 bridgeSyncing=true;const profile=appState.activeId;let applied=0,rejected=0;
 try{
  const {tasks}=await bridgeApi('/api/admin/tasks?profileId='+encodeURIComponent(profile));
  for(const task of tasks.filter(t=>t.state==='pending'&&(!requestedSubtitlesOnly||t.subtitleRequestId))){
   if(appState.activeId!==profile)break;
   const live=await bridgeApi('/v1/tasks/'+task.id);if(live.state!=='pending')continue;
   let result;
   try{
    const outcome=await applyBridgeTask(live);
    if(!outcome)continue;
    result={state:'applied',...(typeof outcome==='string'?{recordId:outcome}:outcome)};
    if(live.operation!=='subtitle-read')applied++;
   }
   catch(e){if(e.retryable||e instanceof TypeError||['TimeoutError','AbortError'].includes(e.name)||/另一个窗口|已切换|正在编辑|存储空间/.test(e.message))throw e;result={state:'rejected',error:e.message.slice(0,1000)};rejected++}
   await bridgeApi('/api/admin/tasks/'+task.id+'/result',{method:'POST',body:result});
  }
  if(appState.activeId===profile){if(applied||!silent)render();if(!requestedSubtitlesOnly)await publishBridgeSnapshot({onlyIfChanged:true});if($('aiManager').open)await refreshBridgeLists();bridgeStatus('连接正常 · 本次写入 '+applied+' 条，未写入 '+rejected+' 条。');if(applied)toast('已同步 '+applied+' 项 AI 写入')}
 }catch(e){bridgeStatus('同步未完成：'+e.message,true);if(!silent)toast(e.message)}finally{bridgeSyncing=false}
}
function startBridgeTimer(){
 clearInterval(bridgeTimer);
 if(!bridgeConnection)return;
 const sync=()=>syncBridge({silent:true,requestedSubtitlesOnly:!$('bridgeAutoSync').checked});
 bridgeTimer=setInterval(sync,3000);void sync();
}
function disconnectBridge(message='已断开。接入服务中的待同步任务仍会保留。',forget=false){
 bridgeTaskFilter='recent';bridgeConnection=null;clearInterval(bridgeTimer);clearInterval(bridgeIndicatorTimer);$('bridgeAdminToken').value='';$('bridgeNewToken').value='';$('bridgeMcpUrl').value='';$('bridgeNewTokenPanel').hidden=true;
 if(forget)persistBridgeConnection();
 updateAiConnectionIndicator(false);
 for(const id of ['bridgeAgentList','bridgeTaskList','bridgeAudit'])$(id).replaceChildren();
 bridgeStatus(message);
}
function updateAiConnectionIndicator(connected){
 if(location.origin==='https://yams-one.example'&&window.chrome?.webview)window.chrome.webview.postMessage(connected?'ai-indicator:on':'ai-indicator:off');
}
function startBridgeIndicatorHeartbeat(){
 clearInterval(bridgeIndicatorTimer);
 if(location.origin!=='https://yams-one.example'||!window.chrome?.webview)return;
 bridgeIndicatorTimer=setInterval(async()=>{
  const connection=bridgeConnection;if(!connection)return;
  try{await bridgeApi('/api/admin/agents');if(bridgeConnection===connection)updateAiConnectionIndicator(true)}
  catch{if(bridgeConnection===connection)updateAiConnectionIndicator(false)}
 },30000);
}
async function verifyBridgeMcp(){
 const connection=bridgeConnection,token=$('bridgeNewToken').value;
 if(!connection||!token)throw new Error('请先连接服务并创建助手凭证。');
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
 async function request(method,params,id){
  const response=await fetch(connection.base+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params}),redirect:'error',signal:AbortSignal.timeout(12000)});
  if(connection!==bridgeConnection)throw new Error('连接已切换，请重新验证。');
  if(response.status===404)throw new Error('当前服务缺少 /mcp，请升级 AI 接入服务。');
  if(!response.ok)throw new Error('服务返回 HTTP '+response.status+'。请检查助手令牌和服务地址。');
  if(id===undefined)return;
  const data=await response.json();if(data.error||!data.result)throw new Error(data.error?.message||'MCP 返回格式无效。');
  return data.result;
 }
 const hello=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'yams-one-check',version:'1.0'}},1);
 headers['MCP-Protocol-Version']=hello.protocolVersion;
 await request('notifications/initialized');
 const {tools}=await request('tools/list',{},2);
 return tools.map(tool=>tool.name);
}
async function connectBridgeAt(base,token,kind='remote',restored=false){
 $('bridgeNewToken').value='';$('bridgeMcpUrl').value='';$('bridgeNewTokenPanel').hidden=true;
 const connection={base,token,kind,profileId:appState.activeId};
 bridgeConnection=connection;
 try{
  await publishBridgeSnapshot();await refreshBridgeLists();startBridgeTimer();updateAiConnectionIndicator(true);startBridgeIndicatorHeartbeat();
  if(!restored)persistBridgeConnection();
  bridgeStatus((restored?'已自动恢复连接。':'已连接并发布当前用户快照。')+'原附件未自动上传。');
 }catch(error){
  if(bridgeConnection===connection){bridgeConnection=null;clearInterval(bridgeTimer);clearInterval(bridgeIndicatorTimer);updateAiConnectionIndicator(false)}
  throw error;
 }
}
function initializeDesktopBridge(){
 const desktop=desktopAiHost();
 if(!desktop)return;
 updateAiConnectionIndicator(false);
 document.documentElement.classList.add('desktop-host');
 $('bridgeRememberOption').hidden=false;
 if($('bridgeAdvancedOptions'))$('bridgeAdvancedOptions').open=false;
 $('bridgeCredentialNote').textContent='勾选「记住连接」后，本机连接会自动重启；远程管理令牌会使用当前 Windows 用户的加密存储。断开并忘记后不再自动连接。';
 $('bridgeDisconnect').textContent='断开并忘记';
 const button=$('bridgeDesktopConnect'),manual=$('bridgeConnect');
 let requestedProfile=null;
 button.hidden=false;
 button.onclick=()=>{
  if(!ensureReady()||manual.disabled)return;
  requestedProfile=appState.activeId;
  button.disabled=manual.disabled=true;
  bridgeStatus('正在启动本机 AI 服务…');
  desktop.postMessage('start-local-ai');
 };
 desktop.addEventListener('message',async event=>{
  const message=event.data;
  if(message?.type==='yams-one-ai-persistence'){
   if(message.error&&message.profileId===appState.activeId)bridgeStatus('连接正常，但未能记住凭证：'+message.error,true);
   return;
  }
  if(message?.type==='yams-one-ai-restore'){
   if(message.profileId!==appState.activeId)return;
   if(message.missing)return;
   bridgeRestoreRequestedProfile=null;
   if(bridgeConnection)return;
   try{
    if(message.error)throw new Error(message.error);
    const base=bridgeBase(message.baseUrl),token=message.adminToken;
    if(typeof token!=='string'||token.length<24)throw new Error('保存的连接信息无效。');
    $('bridgeUrl').value=base;
    await connectBridgeAt(base,token,message.kind,true);
   }catch(error){bridgeStatus('自动连接失败：'+error.message+'。可在 AI 管理中重试。',true)}
   return;
  }
  if(message?.type!=='yams-one-local-ai'||!requestedProfile)return;
  const profile=requestedProfile;requestedProfile=null;
  try{
   if(appState.activeId!==profile)throw new Error('用户已切换，请重新连接当前工作台。');
   if(message.error)throw new Error(message.error);
   const base=bridgeBase(message.baseUrl),token=message.adminToken;
   if(typeof token!=='string'||token.length<24)throw new Error('本机服务连接信息无效。');
   $('bridgeUrl').value=base;$('bridgeAdminToken').value='';
   await connectBridgeAt(base,token,'local');
  }catch(error){bridgeStatus('本机连接失败：'+error.message,true)}
  finally{button.disabled=manual.disabled=false}
 });
}
function initializeAiManager(){
 $('openAiManager').onclick=()=>{if(!ensureReady())return;if(bridgeConnection&&bridgeConnection.profileId!==appState.activeId)disconnectBridge('用户已切换，请重新连接。');$('bridgeCurrentProfile').textContent=activeProfile().name;$('aiManager').showModal();if(bridgeConnection)refreshBridgeLists().catch(e=>bridgeStatus(e.message,true));else requestStoredBridge(true)};
 $('bridgeConnect').onclick=async()=>{
  const button=$('bridgeConnect');button.disabled=true;
  try{
   const base=bridgeBase($('bridgeUrl').value.trim()),token=$('bridgeAdminToken').value.trim();
   if(!token)throw new Error('请输入管理令牌或导入连接文件。');
   await connectBridgeAt(base,token);
  }catch(error){bridgeStatus('连接失败：'+error.message,true)}
  finally{button.disabled=false}
 };
 $('bridgeDisconnect').onclick=()=>disconnectBridge('已断开，保存的连接已清除。',true);
 $('bridgeRemember').onchange=()=>{if(bridgeConnection)persistBridgeConnection();else if(!$('bridgeRemember').checked)persistBridgeConnection()};
 $('bridgeImportConnection').onclick=()=>$('bridgeConnectionFile').click();$('bridgeConnectionFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>8192)throw new Error('连接文件过大。');const value=JSON.parse(await file.text());$('bridgeUrl').value=bridgeBase(value.baseUrl);if(typeof value.adminToken!=='string'||value.adminToken.length<24)throw new Error('管理令牌无效。');$('bridgeAdminToken').value=value.adminToken;bridgeStatus('连接文件已读取，请点击「连接并发布快照」。')}catch(error){bridgeStatus(error.message,true)}finally{e.target.value=''}};
 $('bridgeAutoSync').onchange=startBridgeTimer;$('bridgeSync').onclick=()=>syncBridge();$('bridgePublish').onclick=async()=>{try{await publishBridgeSnapshot();bridgeStatus('当前用户快照已更新。')}catch(e){bridgeStatus(e.message,true)}};
 $('bridgeGrantFull').onclick=()=>{document.querySelectorAll('[data-bridge-scope]').forEach(box=>box.checked=true);$('bridgeIncludeBody').checked=true;$('bridgeIncludePdf').checked=true;$('bridgeAutoSync').checked=true;startBridgeTimer()};
 for(const button of document.querySelectorAll('[data-bridge-preset]'))button.onclick=()=>{
  const preset=button.dataset.bridgePreset,set=(scope,on)=>{const box=document.querySelector('[data-bridge-scope="'+scope+'"]');if(box)box.checked=on};
  set('records:read',true);set('records:create',preset!=='read');set('records:update',preset==='write');set('records:delete',false);set('files:read',true);set('files:write',preset==='write');set('subtitles:read',false);set('subtitles:write',false);
  bridgeStatus('已套用'+(preset==='read'?'只读':'可写')+'权限，可以继续微调。');
 };
 $('bridgeCopyMcp').onclick=async()=>{const value=$('bridgeMcpUrl').value.trim();if(!value){toast('连接并创建助手后才会生成连接器地址。');return}try{await navigator.clipboard.writeText(value);toast('连接器地址已复制')}catch{$('bridgeMcpUrl').select();toast('请手动复制已选中的地址')}};
 $('bridgeAgentForm').onsubmit=async e=>{e.preventDefault();try{const scopes=[...document.querySelectorAll('[data-bridge-scope]:checked')].map(c=>c.dataset.bridgeScope);await publishBridgeSnapshot({onlyIfChanged:true});const response=await bridgeApi('/api/admin/agents',{method:'POST',body:{name:$('bridgeAgentName').value.trim(),profileId:appState.activeId,scopes}});$('bridgeNewToken').value=response.token;$('bridgeMcpStatus').textContent='';$('bridgeMcpUrl').value=bridgeConnection.base+'/mcp';$('bridgeNewTokenPanel').hidden=false;$('bridgeAgentName').value='';await refreshBridgeLists();bridgeStatus('助手已创建。只向此助手提供独立令牌，不要提供管理令牌。')}catch(error){bridgeStatus(error.message,true)}};
 $('bridgeCopyToken').onclick=async()=>{try{await navigator.clipboard.writeText($('bridgeNewToken').value);toast('助手令牌已复制')}catch{ $('bridgeNewToken').select();toast('请手动复制已选中的助手令牌') }};
 $('bridgeTestMcp').onclick=async()=>{
  const button=$('bridgeTestMcp'),status=$('bridgeMcpStatus');button.disabled=true;
  status.textContent='正在验证…';
  try{const tools=await verifyBridgeMcp();status.textContent='MCP 验证通过 · 可用工具：'+tools.join('、')+'。'}
  catch(error){status.textContent='MCP 验证失败：'+error.message}
  finally{button.disabled=false}
 };
 $('bridgeDownloadGuide').onclick=()=>downloadBlob('AI接入说明.txt',new Blob([bridgeGuide()],{type:'text/plain;charset=utf-8'}));
 document.querySelectorAll('[data-close="aiManager"]').forEach(b=>b.onclick=()=>$('aiManager').close());
 initializeDesktopBridge();
}
function bridgeGuide(){const endpoint=bridgeConnection?.base||$('bridgeUrl').value.replace(/\/$/,'');return `DoNote AI 接入\n\n视频字幕：在「AI 管理」的助手列表中点「启用字幕翻译」，然后刷新助手的 DoNote 连接。对助手说「把《视频名》的英文字幕翻译成简体中文并写回 DoNote」。使用 list_videos → read_video_subtitles → task_status → write_subtitle_translations → task_status，按 nextOffset 读完并核对已写入的批次。已有字幕默认保留，DoNote 须运行且开启自动同步。新字幕可用 write_video_subtitles 追加定时字幕。\n\n文献信息：MCP search_literature_metadata 或 GET /v1/literature/search?title=标题（也可使用 doi）返回 Crossref 候选。核对后用 update_record 提交 literature（doi、publication、year、abstract、translatedTitle、translatedAbstract），并轮询 task_status 直到 applied。请勿将课程或合集与单篇论文混配。\n\n服务地址：${bridgeConnection?.base||$('bridgeUrl').value}\nGrok MCP：${endpoint}/mcp\n当前用户：${activeProfile().name}\n用户 ID：${appState.activeId}\n\n请从网站创建独立助手令牌，使用 Authorization: Bearer <助手令牌>。不要使用管理令牌。\n\nGET /v1/workspace：栏目、状态、快照时间（需要读取权限）。\nGET /v1/records?q=关键词：读取上次发布快照（可选正文，原附件不自动上传）。\nPOST /v1/tasks：提交 create/update。requestId 必须在重试时保持不变。返回 pending/202 代表已排队，不代表已经写入浏览器。\nGET /v1/tasks/{id}：轮询，只有 applied 才代表已写入；rejected 表示未写入。\nPOST /v1/files：原件上传（需要文件上传权限），X-File-Name 为 URL 编码文件名。返回文件 id 后，在任务 record.fileIds 中引用。\n\n新增示例：\n${JSON.stringify({requestId:'replace-with-unique-request-id',operation:'create',record:{type:'issue',title:'待验证的设计问题',body:'现象、假设、验证步骤',tags:['AI辅助'],status:'待排查'}},null,2)}\n\n更新需 record.id、baseUpdatedAt。支持 appendBody 追加总结、folderPath 重新分类和 relatedResources 关联资料。计划使用 type: plan 并填写 planStart 与 planEnd。具备删除权限的助手可提交 delete，须提供最新 baseUpdatedAt。\n\n本机助手使用 localhost 地址。云端助手需要可访问的 HTTPS 服务，不能访问你电脑的 localhost。网站打开并连接后自动同步；关闭网页时任务保存在服务队列，重新连接后再写入。\n\n请阅读配套目录中的「AI接入指南.md」、openapi.json 和 Python adapter.py。`}
initializeAiManager();
// Resume queued authorized work as soon as editing ends or the desktop regains focus.
$('editor').addEventListener('close',()=>{if($('bridgeAutoSync').checked&&bridgeConnection)queueMicrotask(()=>syncBridge({silent:true}))});
window.addEventListener('focus',()=>{if($('bridgeAutoSync').checked&&bridgeConnection)void syncBridge({silent:true})});

