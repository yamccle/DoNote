import {readFileSync} from 'node:fs';

const MODERN='2026-07-28';
const LEGACY=['2025-11-25','2025-06-18','2025-03-26'];
const VERSIONS=[MODERN,...LEGACY];
const {CreateRecord,UpdateRecord,DeleteRecord,Literature}=JSON.parse(readFileSync(new URL('./openapi.json',import.meta.url),'utf8')).components.schemas;
for(const schema of [CreateRecord,UpdateRecord])schema.properties.literature=Literature;
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const requestId={type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$',description:'Unique operation ID. Reuse the same ID and payload for retries.'};
const videoIds={recordId:{type:'string'},fileId:{type:'string'}};
const tools=[
 {name:'take_subtitle_translation_request',description:'Pick up a DoNote request created by the user clicking 外部助手 in the subtitle panel. Pass the request id if provided, otherwise take your oldest active request. Returns id, recordId and fileId. Pass the returned id as subtitleRequestId on every read and write for this request. Read subtitles in pages, translate only missing Chinese lines, write translations, and verify task_status for each batch. Continue until all pages are handled. Do not claim completion if any writes failed.',inputSchema:object({id:{type:'string'}}),permissions:['subtitles:read','subtitles:write']},
 {name:'list_videos',description:'Find a video in DoNote by its title or filename. Use the returned recordId and fileId for subtitle tools. If multiple results match, ask which one.',inputSchema:object({query:{type:'string',maxLength:500},limit:{type:'integer',minimum:1,maximum:50},offset:{type:'integer',minimum:0}}),permission:'subtitles:read'},
 {name:'read_video_subtitles',description:'Queue a live read of up to 40 subtitle lines from the video. Poll task_status for subtitleResult, then use nextOffset to continue. DoNote must be running and connected with automatic sync enabled. Use a new requestId for each page or an expired read.',inputSchema:object({...videoIds,requestId,subtitleRequestId:{type:'string',description:'ID of the request accepted with take_subtitle_translation_request, if applicable.'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:40}},['recordId','fileId','requestId']),permission:'subtitles:read'},
 {name:'write_subtitle_translations',description:'Write Chinese translations directly to DoNote. Translate the English cues yourself. Keep index and revision from the read result. Defaults to filling blank Chinese subtitles only. Set replaceExisting only when the user asks to replace existing text. Poll task_status until applied before reporting success.',inputSchema:object({...videoIds,requestId,subtitleRequestId:{type:'string',description:'ID of the request accepted with take_subtitle_translation_request, if applicable.'},replaceExisting:{type:'boolean'},cues:{type:'array',minItems:1,maxItems:40,items:object({index:{type:'integer',minimum:0},revision:{type:'string'},zh:{type:'string',minLength:1,maxLength:8000}},['index','revision','zh'])}},['recordId','fileId','requestId','cues']),permission:'subtitles:write'},
 {name:'write_video_subtitles',description:'Write new timed subtitle cues to an empty track or append to the end. Read the track first and pass total as expectedCount. Each cue needs start and end in seconds and English or Chinese text. To translate existing lines use write_subtitle_translations. Poll task_status until applied.',inputSchema:object({...videoIds,requestId,expectedCount:{type:'integer',minimum:0},cues:{type:'array',minItems:1,maxItems:40,items:object({start:{type:'number',minimum:0},end:{type:'number',minimum:0},en:{type:'string',maxLength:8000},zh:{type:'string',maxLength:8000}},['start','end'])}},['recordId','fileId','requestId','expectedCount','cues']),permission:'subtitles:write'},
 {name:'search_literature_metadata',description:'Search Crossref using the same source as the literature dialog. Returns candidates only, never saves automatically. Check title, authors, year and material type against the original PDF; course slides or proceedings may have no matching article. To save a verified candidate use update_record with title, author, literature and latest baseUpdatedAt, then poll task_status until applied.',inputSchema:object({title:{type:'string',maxLength:240},doi:{type:'string',maxLength:250}}),permission:'records:read'},
 {name:'workspace',description:'List available record categories, statuses, and the workspace snapshot timestamp.',inputSchema:object(),permission:'records:read'},
 {name:'search_records',description:'Search the last published snapshot by title, author or tags.',inputSchema:object({query:{type:'string',maxLength:2000},limit:{type:'integer',minimum:1,maximum:20},offset:{type:'integer',minimum:0,maximum:100000}}),permission:'records:read'},
 {name:'create_record',description:'Queue a new note. Use a category ID from workspace. Pending means queued, and only applied means written to the notebook.',inputSchema:object({requestId,record:CreateRecord},['requestId','record']),permission:'records:create'},
 {name:'update_record',description:'Queue a version-checked update. Read the latest record updatedAt for baseUpdatedAt. Use appendBody to add text.',inputSchema:object({requestId,record:UpdateRecord},['requestId','record']),permission:'records:update'},
 {name:'delete_record',description:'Queue a version-checked deletion of a record and its unshared attachments.',inputSchema:object({requestId,record:DeleteRecord},['requestId','record']),permission:'records:delete'},
 {name:'upload_text_file',description:'Upload a UTF-8 code or text file of at most 256 KiB. Use the returned id in record.fileIds. Reuse requestId for retries.',inputSchema:object({requestId,name:{type:'string',maxLength:500},text:{type:'string',maxLength:262144}},['requestId','name','text']),permission:'files:write'},
 {name:'task_status',description:'Check a task submitted using this assistant token. Only applied means the notebook has saved it.',inputSchema:object({id:{type:'string'}},['id'])}
];
const publicTask=task=>({id:task.id,state:task.state,recordId:task.recordId??null,error:task.error||'',
 ...(task.subtitleResult?{subtitleResult:task.subtitleResult}:task.operation==='subtitle-read'&&task.state==='applied'?{notice:'Subtitle result expired. Submit a new read with a new requestId.'}:{})});
function submitSubtitleTask(api,agent,operation,{recordId,fileId,requestId,subtitleRequestId,...fields}){
 return api.enqueueTask(agent,{operation,requestId,subtitleRequestId,record:{id:recordId,fileId,...fields}});
}

function headerName(value){
 const encoded=value?.match(/^=\?base64\?([a-zA-Z0-9+/=]+)\?=$/);
 return encoded?Buffer.from(encoded[1],'base64').toString('utf8'):value;
}

export async function serveMcp(req,res,agent,api){
 const {reply,jsonBody,version}=api;
 const reject=(id,code,message,status=200,data)=>reply({jsonrpc:'2.0',id,error:{code,message,...(data?{data}:{})}},status);
 if(req.method!=='POST'){res.setHeader('Allow','POST');res.writeHead(405);res.end();return}
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return reject(null,-32600,'Expected application/json',415);
 let message;
 try{message=await jsonBody(req,2*1024*1024)}catch(e){return reject(null,-32700,e.message,e.status||400)}
 if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')return reject(null,-32600,'Invalid request',400);
 const {id,method,params={}}=message,protocol=req.headers['mcp-protocol-version'];
 if(id!==undefined&&typeof id!=='string'&&!Number.isSafeInteger(id))return reject(null,-32600,'Invalid request ID',400);
 if(!params||typeof params!=='object'||Array.isArray(params))return reject(id??null,-32602,'Invalid parameters',400);
 const metaVersion=params._meta?.['io.modelcontextprotocol/protocolVersion'],modern=protocol===MODERN||metaVersion===MODERN;
 const requested=protocol||metaVersion;
 if(requested&&!VERSIONS.includes(requested))return reject(id??null,-32022,'Unsupported protocol version',400,{supported:VERSIONS,requested});
 if(modern&&(protocol!==metaVersion||req.headers['mcp-method']!==method||method==='tools/call'&&headerName(req.headers['mcp-name'])!==params.name)){
  return reject(id??null,-32020,'MCP headers do not match the request',400);
 }
 if(id===undefined){res.writeHead(202);res.end();return}
 const complete=result=>reply({jsonrpc:'2.0',id,result:{...(modern?{resultType:'complete'}:{}),...result}});
 const serverInfo={name:'yams-one',version},capabilities={tools:{}};
 const instructions='Reads use the last published workspace snapshot. Write requests are queued. Verify a task is applied before reporting that it was saved. For a request to translate a video in DoNote, find it with list_videos, read pages with read_video_subtitles and task_status, translate the requested lines, then submit write_subtitle_translations and verify all write tasks. Continue through nextOffset. Keep existing Chinese unless the user requests replacement.';
 const visibleTools=tools.filter(tool=>(!tool.permission||agent.scopes.includes(tool.permission))&&(!tool.permissions||tool.permissions.every(permission=>agent.scopes.includes(permission))));
 if(method==='server/discover'&&modern)return complete({supportedVersions:VERSIONS,capabilities,_meta:{'io.modelcontextprotocol/serverInfo':serverInfo},instructions});
 if(method==='initialize'&&!modern){
  const protocolVersion=LEGACY.includes(params.protocolVersion)?params.protocolVersion:LEGACY[0];
  return complete({protocolVersion,capabilities,serverInfo,instructions});
 }
 if(method==='ping')return complete({});
 if(method==='tools/list')return complete({tools:visibleTools.map(({permission,permissions,...tool})=>tool)});
 if(method!=='tools/call')return reject(id,-32601,'Method not found',modern?404:200);
 const args=params.arguments??{};
 if(!args||typeof args!=='object'||Array.isArray(args))return reject(id,-32602,'Invalid tool arguments');
 const result=(value,isError=false)=>complete({content:[{type:'text',text:JSON.stringify(value)}],...(isError?{isError:true}:{structuredContent:value})});
 if(!visibleTools.some(tool=>tool.name===params.name))return result({error:'此助手未获授权使用此工具。'},true);
 try{
  switch(params.name){
   case 'search_literature_metadata':return result(await api.lookupLiterature(agent,args));
   case 'take_subtitle_translation_request':return result(await api.takeSubtitleRequest(agent,args));
   case 'list_videos':return result(api.listVideos(agent,args));
   case 'read_video_subtitles':return result(publicTask(await submitSubtitleTask(api,agent,'subtitle-read',args)));
   case 'write_subtitle_translations':return result(publicTask(await submitSubtitleTask(api,agent,'subtitle-translate',args)));
   case 'write_video_subtitles':return result(publicTask(await submitSubtitleTask(api,agent,'subtitle-append',args)));
   case 'workspace':return result(api.workspaceFor(agent));
   case 'search_records':return result(api.recordsFor(agent,{query:args.query,limit:Math.min(20,Number(args.limit)||10),offset:args.offset}));
   case 'create_record':return result(publicTask(await api.enqueueTask(agent,{operation:'create',requestId:args.requestId,record:args.record})));
   case 'update_record':return result(publicTask(await api.enqueueTask(agent,{operation:'update',requestId:args.requestId,record:args.record})));
   case 'delete_record':return result(publicTask(await api.enqueueTask(agent,{operation:'delete',requestId:args.requestId,record:args.record})));
   case 'upload_text_file':return result(await api.uploadTextFile(agent,args));
   case 'task_status':return result(publicTask(api.taskFor(agent,args.id)));
  }
 }catch(error){return result({error:error.status?error.message:'接入服务内部错误。'},true)}
}
