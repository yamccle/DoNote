import http from 'node:http';
import net from 'node:net';
import {promises as fs,createWriteStream,createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {serveMcp} from './mcp.mjs';

const VERSION='1.3.0',MAX_FILE=100*1024*1024,SCOPES=['records:read','records:create','records:update','records:delete','files:read','files:write','subtitles:read','subtitles:write'];
const subtitleScopes=['subtitles:read','subtitles:write'];
const subtitleOperations={ 'subtitle-read':'subtitles:read', 'subtitle-translate':'subtitles:write', 'subtitle-append':'subtitles:write' };
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const identifier=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s)&&!Object.hasOwn(Object.prototype,s)&&s!=='prototype';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function equalHash(a,b){return typeof a==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b))}
function bounded(s,max,required=false){return typeof s==='string'&&s.length<=max&&(!required||s.trim().length>0)}
function tagsOk(tags){return Array.isArray(tags)&&tags.length<=30&&tags.every(t=>bounded(t,99,true))}
async function atomicJson(file,value){const temporary=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600});try{await fs.rename(temporary,file)}catch(error){await fs.unlink(temporary).catch(()=>{});throw error}}
async function jsonBody(req,max=16*1024*1024){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>max)throw fail('请求过大。',413);chunks.push(part)}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw fail('JSON 格式无效。')}}
function publicAgent(a){const {tokenHash,...publicData}=a;return publicData}
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toJSON()?.slice(0,10)===value;
const literatureLimits={doi:250,publication:300,year:4,abstract:12000,translatedTitle:2000,translatedAbstract:16000};
function checkLiterature(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([k,v])=>!Object.hasOwn(literatureLimits,k)||!bounded(v,literatureLimits[k])))throw fail('文献信息格式无效。');
 if(value.year&&!/^\d{4}$/.test(value.year)||value.doi&&!/^10\.\d{4,9}\/\S+$/i.test(value.doi))throw fail('文献年份或 DOI 格式无效。');
}
function validateRecord(input,profile,operation){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('缺少记录对象。');
 if(operation==='delete'){if(!identifier(input.id)||!bounded(input.baseUpdatedAt,80,true)||Object.keys(input).some(key=>!['id','baseUpdatedAt'].includes(key)))throw fail('删除需要记录 ID 和 baseUpdatedAt。');return structuredClone(input)}
 const supported=new Set(operation==='create'?['type','title','body','author','reference','url','date','tags','status','fileIds','planStart','planEnd','planTrack','relatedResources','folderPath']:['id','baseUpdatedAt','title','appendBody','author','tags','status','fileIds','planStart','planEnd','planTrack','relatedResources','folderPath']);
 supported.add('literature');
 for(const key of Object.keys(input))if(!supported.has(key))throw fail('不支持的字段：'+key);
 if(input.literature!==undefined)checkLiterature(input.literature);
 if(operation==='create'){
  const category=profile.categories.find(c=>c.id===input.type),statuses=input.type==='resource'?['待读','在读','已读']:category?.statuses;
  if(!statuses||!bounded(input.title,240,true)||!bounded(input.body??'',150000)||!statuses.includes(input.status??statuses[0]))throw fail('请检查记录类型、标题、正文或状态。');
  if(input.date&&(!/^\d{4}-\d{2}-\d{2}$/.test(input.date)||isNaN(new Date(input.date+'T00:00:00Z'))))throw fail('日期格式无效。');
 }else if(!identifier(input.id)||!bounded(input.baseUpdatedAt,80,true))throw fail('更新需要记录 ID 和 baseUpdatedAt。');
 if(input.title!==undefined&&!bounded(input.title,240,true)||input.appendBody!==undefined&&!bounded(input.appendBody,150000)||input.author!==undefined&&!bounded(input.author,200)||input.reference!==undefined&&!bounded(input.reference,2000)||input.tags!==undefined&&!tagsOk(input.tags)||input.status!==undefined&&!bounded(input.status,30,true))throw fail('记录字段格式无效。');
 if(input.url!==undefined&&(!bounded(input.url,4000)||input.url&&!/^https?:\/\//i.test(input.url)))throw fail('链接必须以 http 或 https 开头。');
 if(input.fileIds!==undefined&&(!Array.isArray(input.fileIds)||input.fileIds.length>50||input.fileIds.some(id=>!identifier(id))))throw fail('文件 ID 列表无效。');
 const type=input.type||profile.records.find(record=>record.id===input.id)?.type;
 const schedule=input.planStart!==undefined||input.planEnd!==undefined||operation==='create'&&type==='plan';
 if(schedule&&(type!=='plan'||!validDay(input.planStart)||!validDay(input.planEnd)||input.planEnd<input.planStart))throw fail('计划需要有效的开始与结束日期。');
 if(input.planTrack!==undefined&&(type!=='plan'||!['','journal','study'].includes(input.planTrack)))throw fail('计划归属无效。');
 if(input.relatedResources!==undefined&&(!Array.isArray(input.relatedResources)||input.relatedResources.length>100||input.relatedResources.some(id=>!identifier(id))))throw fail('关联资料 ID 无效。');
 if(input.folderPath!==undefined&&(!Array.isArray(input.folderPath)||input.folderPath.length>12||input.folderPath.some(name=>!bounded(name,60,true))))throw fail('文件夹路径无效。');
 return structuredClone(input);
}

export async function createBridge({dataDir,adminToken,host='127.0.0.1',port=4318,allowedOrigins=['null']}={}){
 if(!bounded(adminToken,512,true)||adminToken.length<24)throw Error('管理令牌至少需要 24 个字符。');
 const root=path.resolve(dataDir),filesDir=path.join(root,'files'),statePath=path.join(root,'state.json');await fs.mkdir(filesDir,{recursive:true,mode:0o700});
 let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));if(state.version!==1)throw Error('数据版本不支持')}catch(error){if(error.code!=='ENOENT')throw error;state={version:1,profiles:{},agents:[],tasks:[],files:{},audit:[]};await atomicJson(statePath,state)}
 let pending=Promise.resolve();
 const subtitleResults=new Map();
 const subtitleResultTimer=setInterval(()=>{
  const now=Date.now();
  for(const [id,item] of subtitleResults)if(item.expires<=now)subtitleResults.delete(id);
 },60000);
 subtitleResultTimer.unref();
 const transact=fn=>{const result=pending.catch(()=>{}).then(async()=>{const next=structuredClone(state),value=await fn(next);await atomicJson(statePath,next);state=next;return value});pending=result;return result};
 const log=(s,actor,event,details={})=>{s.audit.push({id:crypto.randomUUID(),at:new Date().toISOString(),actor,event,...details});s.audit=s.audit.slice(-2000)};
 const ownerHash=digest(adminToken);
 function identity(req){const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)throw fail('需要 Bearer 令牌。',401);const hash=digest(token);if(equalHash(hash,ownerHash))return {owner:true,id:'owner'};const agent=state.agents.find(a=>!a.revoked&&equalHash(a.tokenHash,hash));if(!agent)throw fail('令牌无效或已撤销。',401);return agent}
 const scope=(who,permission)=>{if(!who.owner&&!who.scopes.includes(permission))throw fail('此助手没有 '+permission+' 权限。',403)};
 const owner=who=>{if(!who.owner)throw fail('此操作仅限管理令牌。',403)};

 function profileFor(who){const profile=state.profiles[who.profileId];if(!profile)throw fail('工作台尚未发布快照。',409);return profile}
 function workspaceFor(who){
  scope(who,'records:read');const profile=profileFor(who);
  return {profileId:profile.id,name:profile.name,categories:[...profile.categories,{id:'resource',name:'文献与媒体库',statuses:['待读','在读','已读']}],topics:profile.topics,syncedAt:profile.syncedAt,includeBody:profile.includeBody};
 }
 function recordsFor(who,{query='',limit=50,offset=0}={}){
  scope(who,'records:read');const profile=profileFor(who);
  if(typeof query!=='string'||query.length>2000)throw fail('搜索内容无效。');
  const q=query.toLowerCase(),count=Math.min(200,Math.max(1,Number(limit)||50)),start=Math.max(0,Math.min(100000,Number(offset)||0));
  const matches=profile.records.filter(r=>[r.title,r.author,r.body,...(r.folderPath||[]),...r.tags].join(' ').toLowerCase().includes(q));
  return {records:matches.slice(start,start+count),total:matches.length,snapshotAt:profile.syncedAt,notice:'浏览器上次发布的快照，可能落后于新提交的任务。'};
 }
 function taskFor(who,id){
  const task=state.tasks.find(t=>t.id===id&&(who.owner||t.agentId===who.id));
  if(!task)throw fail('任务不存在。',404);
  const result=subtitleResults.get(task.id);
  if(!who.owner&&task.operation==='subtitle-read'){
   scope(who,'subtitles:read');
   if(result&&result.expires>Date.now())return {...task,subtitleResult:result.value};
  }
  return task;
 }
 function subtitleVideo(who,recordId,fileId){
  const profile=profileFor(who);
  const record=profile.records.find(item=>item.id===recordId);
  const file=record?.attachments.find(item=>item.id===fileId&&videoAttachment(item));
  if(!file)throw fail('找不到该工作台中的视频，请重新查找。',404);
  return {record,file};
 }
 function eligibleSubtitleAssistant(agent,profileId){
  return agent?.profileId===profileId&&!agent.revoked&&subtitleScopes.every(permission=>agent.scopes.includes(permission));
 }
 function activeSubtitleRequest(request,now=Date.now()){
  return ['waiting','accepted'].includes(request.state)&&Date.parse(request.expiresAt)>now;
 }
 async function takeSubtitleRequest(who,{id}={}){
  for(const permission of subtitleScopes)scope(who,permission);
  if(id!==undefined&&!identifier(id))throw fail('翻译请求编号无效。');
  return transact(s=>{
   if(!eligibleSubtitleAssistant(s.agents.find(agent=>agent.id===who.id),who.profileId))
    throw fail('此助手的字幕权限已撤销。',403);
   const request=(s.subtitleRequests||[]).find(item=>item.agentId===who.id&&
    item.profileId===who.profileId&&(!id||item.id===id)&&activeSubtitleRequest(item));
   if(!request)return {request:null};
   if(request.state==='waiting'){
    request.state='accepted';request.acceptedAt=new Date().toISOString();
    log(s,who.id,'subtitle-request-accepted',{profileId:who.profileId,requestId:request.id});
   }
   return {request};
  });
 }
 function videoAttachment(file){
  return /^video\//i.test(file.mime||'')||/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(file.name||'');
 }
 function listVideos(who,{query='',limit=20,offset=0}={}){
  scope(who,'subtitles:read');
  if(!bounded(query,500)||!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0)throw fail('视频搜索参数无效。');
  const needle=query.trim().toLowerCase(),rows=[];
  for(const record of profileFor(who).records)for(const file of record.attachments){
   if(videoAttachment(file)&&[record.title,file.name].join(' ').toLowerCase().includes(needle))
    rows.push({recordId:record.id,fileId:file.id,title:record.title,fileName:file.name});
  }
  return {videos:rows.slice(offset,offset+limit),total:rows.length};
 }
 function validateSubtitleTask(who,input){
  const record=input.record,operation=input.operation;
  if(!record||!identifier(record.id)||!identifier(record.fileId))throw fail('需要视频所属记录和附件的 ID。');
  subtitleVideo(who,record.id,record.fileId);
  const base={id:record.id,fileId:record.fileId};
  if(operation==='subtitle-read'){
   const {offset=0,limit=30}=record;
   if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>40)throw fail('字幕分页参数无效。');
   return {...base,offset,limit};
  }
  const rows=record.cues;
  if(!Array.isArray(rows)||!rows.length||rows.length>40)throw fail('每批需提供 1 到 40 条字幕。');
  if(operation==='subtitle-translate'){
   const seen=new Set();
   const cues=rows.map(row=>{
    if(!row||!Number.isInteger(row.index)||row.index<0||row.index>=30000||seen.has(row.index)||
       !/^[a-f0-9]{64}$/.test(row.revision||'')||!bounded(row.zh,8000,true))
      throw fail('每条译文需要读取时返回的 index、revision 和非空 zh。');
    seen.add(row.index);return {index:row.index,revision:row.revision,zh:row.zh.trim()};
   });
   return {...base,cues,replaceExisting:record.replaceExisting===true};
  }
  if(!Number.isInteger(record.expectedCount)||record.expectedCount<0||record.expectedCount+rows.length>30000)
   throw fail('追加字幕需要有效的 expectedCount。');
  const cues=rows.map(row=>{
   if(!row||!Number.isFinite(row.start)||!Number.isFinite(row.end)||row.start<0||row.end<=row.start||row.end>86400||
      !bounded(row.en??'',8000)||!bounded(row.zh??'',8000)||!((row.en||'').trim()||(row.zh||'').trim()))
    throw fail('每条字幕需要起止秒数和至少一种语言的文本。');
   return {start:row.start,end:row.end,en:(row.en||'').trim(),zh:(row.zh||'').trim()};
  });
  return {...base,cues,expectedCount:record.expectedCount};
 }
 async function lookupLiterature(who,{title='',doi=''}={}){
  scope(who,'records:read');profileFor(who);
  if(!bounded(title,240)||!bounded(doi,250)||!title.trim()&&!doi.trim())throw fail('请输入标题或 DOI。');
  doi=doi.trim();if(doi&&!/^10\.\d{4,9}\/\S+$/i.test(doi))throw fail('DOI 格式无效。');
  const url=doi?'https://api.crossref.org/works/'+encodeURIComponent(doi):'https://api.crossref.org/works?'+new URLSearchParams({'query.title':title.trim(),rows:'5'});
  let response;try{response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'DoNote/1.2 (literature lookup)'}})}catch{throw fail('Crossref 连接失败，请稍后重试。',502)}
  if(!response.ok)throw fail(response.status===404?'未找到该 DOI。':'Crossref 查询暂不可用。',response.status===404?404:502);
  const data=(await response.json()).message;
  const candidates=(doi?[data]:data.items||[]).filter(i=>i.title?.[0]).map(i=>({title:i.title[0].slice(0,240),author:(i.author||[]).map(a=>a.name||[a.given,a.family].filter(Boolean).join(' ')).join('、').slice(0,200),materialType:i.type||'',sourceUrl:i.URL||'',literature:{doi:(i.DOI||'').slice(0,250),publication:(i['container-title']?.[0]||'').slice(0,300),year:String(i.issued?.['date-parts']?.[0]?.[0]||''),abstract:(i.abstract||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000)}}));
  return {source:'Crossref',candidates,notice:'候选尚未保存。核对原文、作者、年份和资料类型后，用 update_record 提交 literature；不要把整本合集 DOI 写入某篇文章。'};
 }
 async function uploadTextFile(who,input){
  scope(who,'files:write');profileFor(who);
  if(!identifier(input.requestId)||!bounded(input.name,500,true)||!bounded(input.text,262144,true))throw fail('需要 requestId、文件名和不超过 256 KiB 的文本。');
  const bytes=Buffer.from(input.text),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  if(bytes.length>262144)throw fail('文本文件不能超过 256 KiB。',413);
  const id=crypto.createHash('sha256').update(who.id+'\0'+input.requestId).digest('hex'),target=path.join(filesDir,id+'.bin');
  return transact(async s=>{
   if(s.agents.find(a=>a.id===who.id)?.revoked)throw fail('令牌已撤销。',401);
   const previous=s.files[id];
   if(previous){
    if(previous.sha256!==sha256||previous.name!==input.name)throw fail('此 requestId 已用于不同文件。',409);
    return previous;
   }
   // Same deterministic filename makes a retry recoverable if the process stopped before state was committed.
   await fs.writeFile(target,bytes,{mode:0o600});
   const file={id,profileId:who.profileId,name:input.name,size:bytes.length,mime:'text/plain',sha256,createdAt:new Date().toISOString()};
   s.files[id]=file;log(s,who.id,'file-uploaded',{fileId:id,profileId:who.profileId,size:file.size});
   return file;
  });
 }
 async function enqueueTask(who,input){
        if(who.owner)throw fail('请使用独立助手令牌提交任务。');
    const operation=input?.operation,subtitleScope=Object.hasOwn(subtitleOperations,operation)?subtitleOperations[operation]:null;
    if(!input||!identifier(input.requestId)||(!subtitleScope&&!['create','update','delete'].includes(operation)))
     throw fail('需要稳定的 requestId 和受支持的操作。');
    const requiredScope=subtitleScope||'records:'+operation;
    scope(who,requiredScope);
    const profile=profileFor(who);
    const record=subtitleScope?validateSubtitleTask(who,input):validateRecord(input.record,profile,operation);
    for(const id of record.fileIds||[])if(state.files[id]?.profileId!==who.profileId)throw fail('附件不存在或不属于此工作台。',403);
    const task=await transact(s=>{
     const agent=s.agents.find(a=>a.id===who.id);
     if(!agent||agent.revoked)throw fail('令牌已撤销。',401);
     scope(agent,requiredScope);
     const linked=input.subtitleRequestId;
     if(linked!==undefined&&(!subtitleScope||operation==='subtitle-append'||!identifier(linked)))
      throw fail('字幕翻译请求编号无效。');
     const existing=s.tasks.find(t=>t.agentId===who.id&&t.requestId===input.requestId);
     if(existing){
      const fields=[...new Set([...Object.keys(existing.record),...Object.keys(record)])];
      if(existing.operation!==input.operation||existing.subtitleRequestId!==linked||fields.some(key=>JSON.stringify(existing.record[key])!==JSON.stringify(record[key])))throw fail('此 requestId 已用于不同内容。',409);
      return existing;
     }
     if(linked){
      const request=(s.subtitleRequests||[]).find(item=>item.id===linked&&item.agentId===who.id&&
       item.profileId===who.profileId&&item.recordId===record.id&&item.fileId===record.fileId);
      if(!request||request.state!=='accepted'||!activeSubtitleRequest(request))
       throw fail('请领取有效的字幕翻译请求后再提交。',409);
      if(record.replaceExisting)throw fail('此请求只翻译空白中文字幕。');
     }
     if(s.tasks.filter(t=>t.state==='pending').length>=1000)throw fail('待同步任务过多，请先同步。',429);
     const t={id:crypto.randomUUID(),requestId:input.requestId,agentId:who.id,agentName:who.name,profileId:who.profileId,operation:input.operation,record,subtitleRequestId:linked,state:'pending',createdAt:new Date().toISOString()};
     s.tasks.push(t);log(s,who.id,'task-submitted',{taskId:t.id,profileId:t.profileId,operation:t.operation});return t;
    });
    return task;
 }
 const originAllowed=origin=>!origin||origin==='https://yams-one.example'||allowedOrigins.includes(origin)||/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
 const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  if(origin&&originAllowed(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,X-File-Name,X-Profile-Id,MCP-Protocol-Version,Mcp-Method,Mcp-Name');res.setHeader('Access-Control-Allow-Private-Network','true')}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const reply=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
  try{
   if(!originAllowed(origin))throw fail('未授权的浏览器来源。',403);
   if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
   const url=new URL(req.url,'http://localhost'),route=url.pathname;
   if(req.method==='GET'&&route==='/health')return reply({service:'analog-notes-ai-bridge',version:VERSION,storage:'durable queue; browser applies changes',mcp:'/mcp'});
   if(req.method==='GET'&&route==='/openapi.json'){const spec=JSON.parse(await fs.readFile(new URL('./openapi.json',import.meta.url),'utf8'));return reply(spec)}
   if(route==='/mcp'){
    res.setHeader('WWW-Authenticate','Bearer realm="YamsOne"');
    const agent=identity(req);
    res.removeHeader('WWW-Authenticate');
    if(agent.owner)throw fail('MCP 需要独立助手令牌。',403);
    return await serveMcp(req,res,agent,{version:VERSION,reply,jsonBody,workspaceFor,recordsFor,enqueueTask,taskFor,uploadTextFile,lookupLiterature,listVideos,takeSubtitleRequest});
   }
   const who=identity(req);
   if(route==='/api/admin/profiles'&&req.method==='POST'){
    owner(who);const input=await jsonBody(req);if(!identifier(input.id)||!bounded(input.name,80,true)||!Array.isArray(input.categories)||input.categories.length>30||!Array.isArray(input.records)||input.records.length>100000)throw fail('工作台快照格式无效。');
    if(input.categories.some(c=>!identifier(c.id)||!bounded(c.name,80,true)||!Array.isArray(c.statuses)||c.statuses.some(s=>!bounded(s,30,true))))throw fail('栏目格式无效。');
    const records=input.records.map(r=>{if(!identifier(r.id)||!bounded(r.title,240,true)||!bounded(r.updatedAt??'',80)||!bounded(r.body??'',150000))throw fail('快照记录格式无效。');return {id:r.id,type:r.type,title:r.title,literature:r.literature,author:r.author||'',tags:r.tags||[],status:r.status,updatedAt:r.updatedAt,planStart:r.planStart,planEnd:r.planEnd,planTrack:r.planTrack,folderPath:r.folderPath,relatedResources:r.relatedResources,body:input.includeBody?(r.body||''):undefined,attachments:(r.attachments||[]).map(a=>({id:a.id,name:a.name,size:a.size,mime:a.mime}))}});
    const profile={id:input.id,name:input.name,categories:input.categories,topics:input.topics||[],records,includeBody:!!input.includeBody,syncedAt:new Date().toISOString()};
    await transact(s=>{s.profiles[input.id]=profile;log(s,'owner','snapshot',{profileId:input.id,count:records.length,includeBody:profile.includeBody})});return reply({ok:true,profileId:input.id,count:records.length});
   }
   if(route==='/api/admin/profiles'&&req.method==='GET'){owner(who);return reply({profiles:Object.values(state.profiles).map(p=>({id:p.id,name:p.name,count:p.records.length,syncedAt:p.syncedAt,includeBody:p.includeBody}))})}
   if(route==='/api/admin/agents'&&req.method==='GET'){owner(who);return reply({agents:state.agents.map(publicAgent)})}
   if(route==='/api/admin/agents'&&req.method==='POST'){
    owner(who);const input=await jsonBody(req,65536);if(!identifier(input.profileId)||!state.profiles[input.profileId]||!bounded(input.name,60,true)||!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.some(s=>!SCOPES.includes(s)))throw fail('请检查助手名称、工作台及权限。');
    const token='an_agent_'+crypto.randomBytes(32).toString('base64url'),agent={id:crypto.randomUUID(),name:input.name.trim(),profileId:input.profileId,scopes:[...new Set(input.scopes)],tokenHash:digest(token),createdAt:new Date().toISOString(),revoked:false};
    await transact(s=>{s.agents.push(agent);log(s,'owner','agent-created',{agentId:agent.id,profileId:agent.profileId})});return reply({agent:publicAgent(agent),token,notice:'令牌仅返回一次。'},201);
   }
   if(route==='/api/admin/subtitle-requests'&&req.method==='GET'){
    owner(who);
    const profileId=url.searchParams.get('profileId'),fileId=url.searchParams.get('fileId');
    const requests=(state.subtitleRequests||[]).filter(item=>item.profileId===profileId&&item.fileId===fileId);
    const request=requests.at(-1);
    if(request&&activeSubtitleRequest(request)&&!eligibleSubtitleAssistant(
        state.agents.find(agent=>agent.id===request.agentId),profileId))
     return reply({request:{...request,state:'unavailable'}});
    const expired=request&&['waiting','accepted'].includes(request.state)&&!activeSubtitleRequest(request);
    return reply({request:expired?{...request,state:'expired'}:request||null});
   }
   if(route==='/api/admin/subtitle-requests'&&req.method==='POST'){
    owner(who);
    const input=await jsonBody(req,4096);
    if(!identifier(input.profileId)||!identifier(input.recordId)||!identifier(input.fileId)||!identifier(input.agentId))
     throw fail('视频、工作台或助手编号无效。');
    const request=await transact(s=>{
     const agent=s.agents.find(item=>item.id===input.agentId);
     if(!eligibleSubtitleAssistant(agent,input.profileId))throw fail('请为此助手启用字幕读取和写入权限。',403);
     const record=s.profiles[input.profileId]?.records.find(item=>item.id===input.recordId);
     const file=record?.attachments.find(item=>item.id===input.fileId&&videoAttachment(item));
     if(!file)throw fail('视频尚未发布或已移除。',404);
     const now=Date.now();
     s.subtitleRequests=(s.subtitleRequests||[]).filter(item=>Date.parse(item.expiresAt)>now-86400000);
     const existing=s.subtitleRequests.find(item=>item.profileId===input.profileId&&item.fileId===input.fileId&&activeSubtitleRequest(item,now));
     if(existing){
      if(existing.agentId!==agent.id)throw fail('此视频已有助手请求，请先取消。',409);
      return existing;
     }
     if(s.subtitleRequests.length>=1000)throw fail('字幕翻译请求过多。',429);
     const item={id:crypto.randomUUID(),profileId:input.profileId,recordId:record.id,fileId:file.id,
      title:record.title,fileName:file.name,agentId:agent.id,agentName:agent.name,state:'waiting',
      createdAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString()};
     s.subtitleRequests.push(item);
     log(s,'owner','subtitle-request-created',{profileId:input.profileId,requestId:item.id,agentId:agent.id});
     return item;
    });
    return reply({request},201);
   }
   const subtitleRequest=route.match(/^\/api\/admin\/subtitle-requests\/([a-zA-Z0-9-]+)$/);
   if(subtitleRequest&&req.method==='POST'){
    owner(who);
    const input=await jsonBody(req,4096);
    if(!['completed','cancelled'].includes(input.state))throw fail('字幕请求状态无效。');
    const request=await transact(s=>{
     const item=(s.subtitleRequests||[]).find(request=>request.id===subtitleRequest[1]&&request.profileId===input.profileId);
     if(!item)throw fail('翻译请求不存在。',404);
     if(activeSubtitleRequest(item)){
     item.state=input.state;
     if(input.state==='cancelled'){
      for(const task of s.tasks){
       if(task.subtitleRequestId!==item.id||task.state!=='pending')continue;
       task.state='rejected';task.error='用户已撤回翻译请求。';task.finishedAt=new Date().toISOString();
      }
     }
    }
     return item;
    });
    return reply({request});
   }
   const subtitleGrant=route.match(/^\/api\/admin\/agents\/([a-zA-Z0-9-]+)\/subtitle-scopes$/);
   if(subtitleGrant&&req.method==='POST'){
    owner(who);
    const input=await jsonBody(req,4096);
    if(!Array.isArray(input.scopes)||input.scopes.some(value=>!subtitleScopes.includes(value)))throw fail('字幕权限无效。');
    const updated=await transact(s=>{
     const agent=s.agents.find(item=>item.id===subtitleGrant[1]&&!item.revoked);
     if(!agent||agent.profileId!==input.profileId)throw fail('找不到该工作台中的助手。',404);
     agent.scopes=[...new Set([...agent.scopes.filter(value=>!subtitleScopes.includes(value)),...input.scopes])];
     for(const task of s.tasks){
      const permission=Object.hasOwn(subtitleOperations,task.operation)?subtitleOperations[task.operation]:null;
      if(task.agentId===agent.id&&permission&&!agent.scopes.includes(permission)&&task.state==='pending'){
       task.state='rejected';task.error='字幕权限已撤销。';task.finishedAt=new Date().toISOString();
      }
     }
     log(s,'owner','subtitle-permissions',{agentId:agent.id,profileId:agent.profileId});
     return publicAgent(agent);
    });
    return reply(updated);
   }
   const revoke=route.match(/^\/api\/admin\/agents\/([a-zA-Z0-9-]+)\/revoke$/);
   if(revoke&&req.method==='POST'){owner(who);await transact(s=>{const a=s.agents.find(a=>a.id===revoke[1]);if(!a)throw fail('助手不存在。',404);a.revoked=true;for(const task of s.tasks)if(task.agentId===a.id&&task.state==='pending'){task.state='rejected';task.error='助手凭证已撤销。';task.finishedAt=new Date().toISOString()}log(s,'owner','agent-revoked',{agentId:a.id})});return reply({ok:true})}
   if(route==='/api/admin/tasks'&&req.method==='GET'){owner(who);const profileId=url.searchParams.get('profileId'),tasks=state.tasks.filter(t=>!profileId||t.profileId===profileId);return reply({tasks:[...tasks.filter(t=>t.state!=='pending').slice(-100),...tasks.filter(t=>t.state==='pending')]})}
   const manifest=route.match(/^\/api\/admin\/tasks\/([a-zA-Z0-9-]+)\/files\/([a-zA-Z0-9-]+)$/);
   if(manifest&&req.method==='GET'){
    owner(who);const task=state.tasks.find(t=>t.id===manifest[1]),file=state.files[manifest[2]];
    if(!task||!file||task.profileId!==file.profileId||!task.record.fileIds?.includes(file.id))throw fail('任务附件不存在。',404);
    return reply(file);
   }
   const result=route.match(/^\/api\/admin\/tasks\/([a-zA-Z0-9-]+)\/result$/);
   if(result&&req.method==='POST'){
    owner(who);
    const input=await jsonBody(req,512*1024);
    if(!['applied','rejected'].includes(input.state)||input.error&&!bounded(input.error,1000))throw fail('结果格式无效。');
    const value=await transact(s=>{
     const t=s.tasks.find(t=>t.id===result[1]);if(!t)throw fail('任务不存在。',404);
     if(t.state!=='pending')return t;
     if(t.operation==='subtitle-read'&&input.state==='applied'&&(!input.subtitleResult||
         !Array.isArray(input.subtitleResult.cues)||input.subtitleResult.cues.length>40||
         input.subtitleResult.recordId!==t.record.id||input.subtitleResult.fileId!==t.record.fileId))
      throw fail('字幕读取结果无效。');
     t.state=input.state;t.recordId=input.recordId||null;t.error=input.error||'';
     t.finishedAt=new Date().toISOString();
     log(s,'owner','task-'+t.state,{taskId:t.id,agentId:t.agentId,profileId:t.profileId});
     return t;
    });
    if(value.operation==='subtitle-read'&&value.state==='applied'&&input.subtitleResult){
     const now=Date.now();
     for(const [id,item] of subtitleResults)if(item.expires<=now)subtitleResults.delete(id);
     subtitleResults.set(value.id,{value:input.subtitleResult,expires:now+10*60*1000});
     if(subtitleResults.size>128)subtitleResults.delete(subtitleResults.keys().next().value);
    }
    return reply(value);
   }
   if(route==='/api/admin/audit'&&req.method==='GET'){owner(who);return reply({audit:state.audit.slice(-100)})}
   if(route==='/v1/workspace'&&req.method==='GET')return reply(workspaceFor(who));
   if(route==='/v1/literature/search'&&req.method==='GET')return reply(await lookupLiterature(who,{title:url.searchParams.get('title')||'',doi:url.searchParams.get('doi')||''}));
   if(route==='/v1/records'&&req.method==='GET')return reply(recordsFor(who,{query:url.searchParams.get('q')||'',limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')}));
   if(route==='/v1/videos'&&req.method==='GET')return reply(listVideos(who,{
    query:url.searchParams.get('q')||'',limit:Number(url.searchParams.get('limit')||20),offset:Number(url.searchParams.get('offset')||0)
   }));
   if(route==='/v1/tasks'&&req.method==='POST'){
    const task=await enqueueTask(who,await jsonBody(req,2*1024*1024));
    return reply(task,task.state==='pending'?202:200);
   }
   const taskMatch=route.match(/^\/v1\/tasks\/([a-zA-Z0-9-]+)$/);
   if(taskMatch&&req.method==='GET')return reply(taskFor(who,taskMatch[1]));
   if(route==='/v1/files'&&req.method==='POST'){
    if(Number(req.headers['content-length'])>MAX_FILE)throw fail('单文件最多 100 MiB。',413);
    scope(who,'files:write');const profileId=who.owner?req.headers['x-profile-id']:who.profileId;if(!identifier(profileId)||!state.profiles[profileId])throw fail('工作台不存在。');let name;try{name=decodeURIComponent(req.headers['x-file-name']||'')}catch{throw fail('文件名编码无效。')}if(!bounded(name,500,true))throw fail('需要 X-File-Name（URL 编码的文件名）。');
    const id=crypto.randomUUID(),target=path.join(filesDir,id+'.bin'),hash=crypto.createHash('sha256');let size=0;
    try{await pipeline(req,new Transform({transform(chunk,enc,cb){size+=chunk.length;if(size>MAX_FILE)return cb(fail('单文件最多 100 MB。',413));hash.update(chunk);cb(null,chunk)}}),createWriteStream(target,{flags:'wx',mode:0o600}));const file={id,profileId,name,size,mime:bounded(req.headers['content-type'],150)?req.headers['content-type']:'application/octet-stream',sha256:hash.digest('hex'),createdAt:new Date().toISOString()};await transact(s=>{s.files[id]=file;log(s,who.id,'file-uploaded',{fileId:id,profileId,size})});return reply(file,201)}catch(error){await fs.unlink(target).catch(()=>{});throw error}
   }
   const fileMatch=route.match(/^\/v1\/files\/([a-zA-Z0-9-]+)$/);
   if(fileMatch&&req.method==='GET'){scope(who,'files:read');const file=state.files[fileMatch[1]];if(!file||!who.owner&&file.profileId!==who.profileId)throw fail('文件不存在或无权读取。',404);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name)});await pipeline(createReadStream(path.join(filesDir,file.id+'.bin')),res);return}
   throw fail('接口不存在。',404);
  }catch(error){if(!res.headersSent&&!res.destroyed)reply({error:error.status?error.message:'服务内部错误，请检查接入服务日志。'},error.status||500);else if(!res.destroyed)res.destroy()}
 });
 server.on('close',()=>clearInterval(subtitleResultTimer));
 server.requestTimeout=180000;server.headersTimeout=30000;
 return {server,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server.address()))}),close:()=>new Promise(resolve=>server.close(resolve))};
}

async function lockWindowsDataDirectory(dataDir){
 if(process.platform!=='win32')return;
 const directory=(await fs.realpath(dataDir)).toLowerCase();
 const pipe='\\\\.\\pipe\\YamsOne-AiBridge-'+digest(directory);
 const lock=net.createServer(socket=>socket.destroy());
 try{
  await new Promise((resolve,reject)=>{
   lock.once('error',reject);
   lock.listen(pipe,()=>{lock.off('error',reject);resolve()});
  });
 }catch(error){
  if(['EADDRINUSE','EACCES'].includes(error.code))throw Error('这个资料夹的 AI 接入服务已在运行。');
  throw error;
 }
 return lock;
}

async function main(){
 const here=path.dirname(fileURLToPath(import.meta.url));
 const host=process.env.ANALOG_BIND||'127.0.0.1';
 const port=Number(process.env.PORT||4318);
 const dataDir=path.resolve(process.env.ANALOG_DATA_DIR||path.join(here,'runtime'));
 const isLoopback=['127.0.0.1','localhost','::1'].includes(host);
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT 必须是 0 至 65535 之间的整数。');
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const lock=await lockWindowsDataDirectory(dataDir);
 let bridge;
 try{
  let adminToken=process.env.ANALOG_ADMIN_TOKEN;
  if(!adminToken){
   if(!isLoopback)throw Error('云端监听必须设置 ANALOG_ADMIN_TOKEN（至少 24 字符），并在外层配置 HTTPS。');
   const tokenPath=path.join(dataDir,'owner.secret');
   try{adminToken=(await fs.readFile(tokenPath,'utf8')).trim()}catch(error){
    if(error.code!=='ENOENT')throw error;
    adminToken='an_owner_'+crypto.randomBytes(32).toString('base64url');
    await fs.writeFile(tokenPath,adminToken,{mode:0o600,flag:'wx'});
   }
  }
  const allowedOrigins=(process.env.ANALOG_ALLOWED_ORIGINS||'null').split(',').map(s=>s.trim());
  bridge=await createBridge({dataDir,adminToken,host,port,allowedOrigins});
  const address=await bridge.listen();
  if(isLoopback){
   const connection=path.join(dataDir,'connection.json');
   const baseUrl='http://'+(host==='::1'?'[::1]':host)+':'+address.port;
   const pid=process.pid;
   await atomicJson(connection,{baseUrl,adminToken,pid});
   process.stdout.write('YAMS_ONE_BRIDGE_READY '+JSON.stringify({baseUrl,pid,version:VERSION})+'\n');
   process.stdout.write('AI 接入服务已启动：'+baseUrl+'\n请在网站 AI 管理中导入连接文件：'+connection+'\n此连接文件含管理令牌，仅供本人使用。\n');
  }else{
   process.stdout.write('AI bridge listening on configured interface. Configure HTTPS and persistent storage before cloud use.\n');
  }
  if(process.env.ANALOG_DESKTOP_MANAGED==='1'){
   process.stdin.once('end',async()=>{await bridge.close();lock?.close()});
   process.stdin.resume();
  }
 }catch(error){
  await bridge?.close();
  lock?.close();
  throw error;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1});
