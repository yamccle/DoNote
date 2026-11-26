/**
 * [INPUT]: 读取已收藏网页的正文、离线快照和标注。
 * [OUTPUT]: 展示正文和快照。保存摘录并跳回原文。
 * [POS]: 打开网页时读取正文。选择离线快照时再请求快照附件。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

let webReaderSession=null,webReaderSaveQueue=Promise.resolve();
const WEB_ANNOTATION_LIMIT=300;
const WEB_READER_THEMES=['system','light','paper','dark'];
const WEB_READER_WIDTHS=['compact','standard','wide'];

function validWebAnnotations(value){
 return Array.isArray(value)&&value.length<=WEB_ANNOTATION_LIMIT&&new Set(value.map(entry=>entry?.id)).size===value.length&&value.every(entry=>
  entry&&typeof entry.id==='string'&&/^[a-z0-9-]{1,80}$/i.test(entry.id)&&['article','live'].includes(entry.mode)
  &&typeof entry.quote==='string'&&entry.quote.length<=2000&&typeof entry.note==='string'&&entry.note.length<=1200&&(entry.quote.trim()||entry.note.trim())
  &&Number.isSafeInteger(entry.start)&&Number.isSafeInteger(entry.end)&&entry.start>=0&&entry.end>=entry.start&&entry.end<=5_000_000
  &&typeof entry.before==='string'&&entry.before.length<=64&&typeof entry.after==='string'&&entry.after.length<=64
  &&typeof entry.createdAt==='string'&&entry.createdAt.length<=40&&Number.isFinite(Date.parse(entry.createdAt)));
}
function webRecord(id,profile=activeProfile()){
 return profile?.records.find(record=>record.id===id&&record.type==='resource'&&record.webArticle);
}
function updateWebRecord(id,profileId,apply){
 const operation=webReaderSaveQueue.catch(()=>{}).then(async()=>{
  if(appState.activeId!==profileId)throw new Error('已切换工作台，请重新打开网页。');
  const next=structuredClone(appState),profile=next.profiles.find(entry=>entry.id===profileId);
  const record=webRecord(id,profile);
  if(!record)throw new Error('此网页已从资料库移除。');
  if(apply(record)===false)return;
  await commitState(next);
 });
 webReaderSaveQueue=operation;
 return operation;
}
function currentWebAnnotations(id){
 const marks=webRecord(id)?.webAnnotations;
 return validWebAnnotations(marks)?marks:[];
}
async function saveWebAnnotation(id,annotation){
 const profileId=appState.activeId;
 if(!validWebAnnotations([annotation]))throw new Error('请输入有效的摘录或笔记。');
 await updateWebRecord(id,profileId,record=>{
  const marks=record.webAnnotations??[];
  if(!validWebAnnotations(marks))throw new Error('现有网页标注格式异常。');
  if(marks.length>=WEB_ANNOTATION_LIMIT)throw new Error('这篇网页的标注数量已达上限。');
  record.webAnnotations=[annotation,...marks];record.updatedAt=new Date().toISOString();
 });
 const session=webReaderSession;
 if(session?.id===id&&session.profileId===profileId)renderWebAnnotations(session);
}
async function addWebArticleAnnotation(recordId,{quote,note}){
 await saveWebAnnotation(recordId,{id:crypto.randomUUID(),mode:'live',quote:String(quote??'').trim().slice(0,2000),
  note:String(note??'').trim().slice(0,1200),start:0,end:0,before:'',after:'',createdAt:new Date().toISOString()});
}
function webReaderPrefs(profileId){
 const defaults={size:18,width:'standard',theme:'system'};
 try{
  const value=JSON.parse(localStorage.getItem('web-reader-prefs/'+profileId)||'null');
  if(!value)return defaults;
  if(Number.isInteger(value.size)&&value.size>=14&&value.size<=28)defaults.size=value.size;
  if(WEB_READER_WIDTHS.includes(value.width))defaults.width=value.width;
  if(WEB_READER_THEMES.includes(value.theme))defaults.theme=value.theme;
 }catch{}
 return defaults;
}
function setWebReaderPrefs(session){
 const {shell,prefs,profileId}=session;
 shell.style.setProperty('--web-reader-size',prefs.size+'px');shell.dataset.width=prefs.width;shell.dataset.readingTheme=prefs.theme;
 try{localStorage.setItem('web-reader-prefs/'+profileId,JSON.stringify(prefs))}catch{}
}
function validWebReading(value){
 return !!value&&['article','snapshot'].includes(value.mode)&&Number.isFinite(value.scroll)&&value.scroll>=0&&value.scroll<=1
  &&typeof value.updatedAt==='string'&&value.updatedAt.length<=40&&Number.isFinite(Date.parse(value.updatedAt));
}
function getWebCheckpoint(record,profileId){
 const saved=validWebReading(record.webReading)?record.webReading:{mode:'article',scroll:0,updatedAt:''};
 try{
  const checkpoint=JSON.parse(localStorage.getItem('web-reader/'+profileId+'/'+record.id)||'null');
  if(validWebReading(checkpoint)&&checkpoint.updatedAt>=saved.updatedAt)return checkpoint;
 }catch{}
 return saved;
}
function checkpointWebReading(session){
 const value={mode:session.mode,scroll:session.articleScroll,updatedAt:new Date().toISOString()};
 try{localStorage.setItem('web-reader/'+session.profileId+'/'+session.id,JSON.stringify(value))}catch{}
 return value;
}
function persistWebReading(session){
 const value=checkpointWebReading(session);
 return updateWebRecord(session.id,session.profileId,record=>{
  record.webReading=value;
  if(record.status==='待读')record.status='在读';
 }).catch(error=>{if(appState.activeId===session.profileId&&webRecord(session.id))toast('网页阅读进度未保存：'+error.message)});
}
function selectedWebText(session){
 if(session.mode!=='article')return null;
 const selection=getSelection();
 if(!selection||selection.isCollapsed||!selection.rangeCount)return null;
 const range=selection.getRangeAt(0),body=session.article;
 if(!body.contains(range.startContainer)||!body.contains(range.endContainer))return null;
 const prefix=document.createRange();
 prefix.selectNodeContents(body);prefix.setEnd(range.startContainer,range.startOffset);
 const start=prefix.toString().length,quote=range.toString(),end=start+quote.length,text=body.textContent;
 if(!quote.trim())return null;
 if(quote.length>2000)return {tooLong:true};
 return {quote,start,end,before:text.slice(Math.max(0,start-64),start),after:text.slice(end,end+64)};
}
function webTextRangeMap(article){
 const nodes=[],walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT);
 let node,index=0;
 while((node=walker.nextNode())){
  if(!node.length)continue;
  nodes.push({node,start:index,end:index+node.length});index+=node.length;
 }
 return (start,end)=>{
  if(start<0||end<=start||end>index)return null;
  const first=nodes.find(entry=>entry.end>start),last=nodes.find(entry=>entry.end>=end);
  if(!first||!last)return null;
  const range=document.createRange();
  range.setStart(first.node,start-first.start);range.setEnd(last.node,end-last.start);
  return range;
 };
}
function webQuotePosition(text,mark){
 if(!mark.quote)return null;
 if(mark.mode==='article'&&mark.end>mark.start&&text.slice(mark.start,mark.end)===mark.quote)return [mark.start,mark.end];
 let start=text.indexOf(mark.quote);
 if(start<0)return null;
 if(text.indexOf(mark.quote,start+1)===-1)return [start,start+mark.quote.length];
 while(start!==-1){
  const end=start+mark.quote.length;
  if((mark.before||mark.after)&&text.slice(Math.max(0,start-mark.before.length),start)===mark.before&&text.slice(end,end+mark.after.length)===mark.after)return [start,end];
  start=text.indexOf(mark.quote,start+1);
 }
 return null;
}
function validWebNoteSource(source){
 return source===undefined||(
  source&&/^[a-zA-Z0-9-]{1,80}$/.test(source.recordId)&&
  typeof source.quote==='string'&&source.quote.trim()&&source.quote.length<=2000&&
  Number.isSafeInteger(source.start)&&Number.isSafeInteger(source.end)&&source.start>=0&&source.end>=source.start&&source.end<=5_000_000&&
  typeof source.before==='string'&&source.before.length<=64&&
  typeof source.after==='string'&&source.after.length<=64
 );
}
function webExcerptOrigin(record){
 try{return new URL(record.webArticle.url).hostname}catch{return '网页'}
}
async function saveWebExcerpt(session,picked){
 const fromMark=typeof picked?.quote==='string'&&picked.quote.trim();
 const selection=fromMark?picked:(selectedWebText(session)||session.selection);
 if(!fromMark&&session.mode!=='article')throw new Error('请先切换到正文阅读。');
 if(selection?.tooLong||String(selection?.quote||'').length>2000)throw new Error('请选择不超过 2,000 字的正文。');
 const quote=String(selection?.quote||'');
 if(!quote.trim())throw new Error('请先在正文中选中文字。');
 const owner=webRecord(session.id);
 if(!owner)throw new Error('此网页已从资料库移除。');
 const profileId=appState.activeId;
 const source={
  recordId:owner.id,quote,
  start:Number.isSafeInteger(selection.start)?selection.start:0,
  end:Number.isSafeInteger(selection.end)?selection.end:0,
  before:String(selection.before||'').slice(0,64),
  after:String(selection.after||'').slice(0,64)
 };
 if(!validWebNoteSource(source))throw new Error('请输入有效的摘录。');
 const note={
  id:crypto.randomUUID(),type:'paper',title:(owner.title+' · 摘录').slice(0,240),
  body:['出处：'+owner.title+' · '+webExcerptOrigin(owner),quote].join('\n\n'),
  tags:['网页摘录'],date:today(),status:statusOptions.paper[0],pinned:false,
  relatedResources:[owner.id],webSource:source,attachments:[]
 };
 if(profileId!==appState.activeId)throw new Error('工作台已切换。');
 await put(note);
 toast('摘录已保存为研究笔记',{label:'打开笔记',run:()=>showDetail(note.id)});
}
let pendingWebFocus=null;
function focusWebQuote(session,source){
 selectWebReaderMode(session,'article');
 const apply=()=>{
  if(webReaderSession!==session||session.mode!=='article')return;
  const position=webQuotePosition(session.article.textContent,{mode:'article',...source});
  if(!position){toast('原文中找不到这段摘录。');return}
  const range=webTextRangeMap(session.article)(...position);
  if(!range){toast('原文中找不到这段摘录。');return}
  if(globalThis.Highlight&&CSS.highlights){
   CSS.highlights.set('web-article-focus',new Highlight(range));
   setTimeout(()=>{if(webReaderSession===session)CSS.highlights.delete('web-article-focus')},6000);
  }
  const top=range.getBoundingClientRect().top-session.scroll.getBoundingClientRect().top;
  session.scroll.scrollBy({top:top-36,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});
 };
 // restoreWebArticleScroll 也在下一帧改滚动位置，定位必须晚于它。
 requestAnimationFrame(()=>requestAnimationFrame(apply));
}
async function openWebEvidence(source){
 if(!validWebNoteSource(source)||!source)return;
 const record=webRecord(source.recordId);
 if(!record){toast('原网页已从资料库移除。');return}
 if($('reader').open){
  const closed=new Promise(resolve=>$('reader').addEventListener('close',resolve,{once:true}));
  $('reader').close();await closed;
 }
 pendingWebFocus=source;
 try{await openSavedWebpage(record)}
 finally{if(pendingWebFocus===source)pendingWebFocus=null}
}
function renderWebSourceLink(note){
 const source=note.webSource;
 if(!source||!validWebNoteSource(source))return;
 const button=document.createElement('button');
 button.type='button';button.className='secondary';button.textContent='打开原文摘录';
 button.onclick=async()=>{try{await openWebEvidence(source)}catch(error){toast(error.message)}};
 $('detailContent').append(button);
}
function renderWebAnnotations(session){
 const marks=currentWebAnnotations(session.id),text=session.article.textContent,rangeFor=webTextRangeMap(session.article);
 session.markList.replaceChildren();
 const ranges=[];
 for(const mark of marks){
  const card=document.createElement('article');card.className='web-mark';
  const meta=document.createElement('div');meta.className='web-mark-meta';
  const origin=document.createElement('span');origin.textContent=mark.mode==='live'?'原网页标注':'正文标注';
  const remove=document.createElement('button');remove.type='button';remove.className='danger';remove.textContent='删除';
  remove.onclick=async()=>{
   remove.disabled=true;
   try{
    await updateWebRecord(session.id,session.profileId,record=>{
     record.webAnnotations=(record.webAnnotations??[]).filter(entry=>entry.id!==mark.id);
     record.updatedAt=new Date().toISOString();
    });
    renderWebAnnotations(session);
   }catch(error){toast(error.message);remove.disabled=false}
  };
  meta.append(origin,remove);card.append(meta);
  const position=webQuotePosition(text,mark),range=position?rangeFor(...position):null;
  if(range)ranges.push(range);
  if(mark.quote){
   const quote=document.createElement(range?'button':'blockquote');quote.className='web-mark-quote';quote.textContent=mark.quote;
   if(range){
    quote.type='button';quote.title='在正文中定位';quote.onclick=()=>{
     selectWebReaderMode(session,'article');
     requestAnimationFrame(()=>{
      if(webReaderSession!==session||session.mode!=='article')return;
      const top=range.getBoundingClientRect().top-session.scroll.getBoundingClientRect().top;
      session.scroll.scrollBy({top:top-36,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});
     });
    };
   }
   card.append(quote);
  }
  if(mark.note){const note=document.createElement('p');note.className='web-mark-note';note.textContent=mark.note;card.append(note)}
  if(mark.quote){
   const save=document.createElement('button');save.type='button';save.className='secondary web-mark-save';save.textContent='保存为研究笔记';
   save.onclick=async()=>{
    save.disabled=true;
    try{await saveWebExcerpt(session,mark)}catch(error){toast(error.message)}
    finally{save.disabled=false}
   };
   card.append(save);
  }
  session.markList.append(card);
 }
 if(!marks.length){const empty=document.createElement('p');empty.className='web-reader-hint';empty.textContent='这里会汇总正文与原网页标注。';session.markList.append(empty)}
 session.marksButton.textContent='标注'+(marks.length?' · '+marks.length:'');
 if(globalThis.Highlight&&CSS.highlights&&webReaderSession===session)CSS.highlights.set('web-article-mark',new Highlight(...ranges));
}
function restoreWebArticleScroll(session){
 const value=session.articleScroll;
 const restore=()=>{
  if(webReaderSession!==session||session.mode!=='article')return;
  session.scroll.scrollTop=Math.max(0,session.scroll.scrollHeight-session.scroll.clientHeight)*value;
 };
 restore();requestAnimationFrame(restore);
}
function selectWebReaderMode(session,mode){
 if(session.mode===mode)return;
 if(mode==='snapshot'&&!session.snapshot){
  toast('这篇网页没有可用的离线快照。');return;
 }
 session.mode=mode;
 session.articleMode.setAttribute('aria-pressed',String(mode==='article'));
 session.snapshotMode.setAttribute('aria-pressed',String(mode==='snapshot'));
 session.exportButton.textContent=mode==='snapshot'?'导出快照':'导出正文';
 session.articleArea.hidden=mode==='snapshot';
 session.snapshotArea.hidden=mode==='article';
 if(mode==='snapshot'){
  if(!session.frame.srcdoc)session.frame.srcdoc=session.snapshot;
 }else restoreWebArticleScroll(session);
 session.highlighter.disabled=mode!=='article';
 if(session.excerptButton)session.excerptButton.disabled=mode!=='article';
 checkpointWebReading(session);
}
function setWebReadLabel(session){
 const done=webRecord(session.id)?.status==='已读';
 session.readButton.textContent=done?'标记为未读完':'标记为已读';
}
function exportWebArticle(record,content){
 const title=esc(record.title),source=esc(record.webArticle.url);
 const date=esc(record.webArticle.capturedAt.slice(0,10));
 return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  +'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
  +'<title>'+title+'</title><style>body{max-width:68ch;margin:2rem auto;padding:0 1.25rem;font:18px/1.8 system-ui,sans-serif;color:#242322;overflow-wrap:anywhere}'
  +'h1,h2,h3{line-height:1.3}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f2f2ef;padding:.75rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.35em}header{border-bottom:1px solid #ddd;margin-bottom:1.5em;padding-bottom:1em}small{color:#555}</style>'
  +'</head><body><header><h1>'+title+'</h1><small>'+esc(record.author||'')+' · 保存于 '+date+'<br><a href="'+source+'" rel="noreferrer">原网页</a></small></header><article>'+content+'</article></body></html>';
}
async function openSavedWebpage(record){
 if(!ensureReady()||!record?.webArticle||$('reader').open)return;
 const profileId=appState.activeId,articleFile=record.attachments?.find(file=>file.webRole==='article'),snapshotFile=record.attachments?.find(file=>file.webRole==='snapshot');
 if(!articleFile){toast('网页正文缺失，请从完整备份恢复。');return}
 const reader=$('reader'),download=$('readerDownload');
 try{
  const articleBlob=await readBlob(articleFile.id,profileId,{fromSync:true});
  const snapshotBlob=snapshotFile?await readBlob(snapshotFile.id,profileId).catch(()=>null):null;
  if(profileId!==appState.activeId||reader.open||!webRecord(record.id))return;
  const content=safeCapturedHtml(await articleBlob.text());
  const snapshot=snapshotBlob?safeCapturedHtml(await snapshotBlob.text(),{snapshot:true}):'';
  if(profileId!==appState.activeId||reader.open||!webRecord(record.id))return;
  discardMinimizedWorkspaceDialog('reader');
  readerFile={id:articleFile.id,name:articleFile.name,blob:articleBlob};
  $('readerTitle').textContent=record.title;
  reader.classList.add('web-reader');download.hidden=true;
  const shell=document.createElement('div');shell.className='web-reader-shell';
  shell.innerHTML=`<div class="web-reader-toolbar">
   <div class="web-reader-modes" role="group" aria-label="网页阅读模式">
    <button class="secondary" type="button" data-web-article>正文阅读</button>
    <button class="secondary" type="button" data-web-snapshot>离线快照</button>
    <span class="web-offline-status">已保存到本机</span>
   </div>
   <div class="web-reader-actions">
    <button class="secondary" type="button" data-web-export>导出正文</button>
    <button class="secondary" type="button" data-web-live hidden>原网页标注 ↗</button>
    <button class="secondary" type="button" data-web-done></button>
    <button class="secondary" type="button" data-web-marks aria-expanded="true">标注</button>
   </div>
  </div>
  <div class="web-reader-layout">
   <div class="web-reader-main">
    <div class="web-reader-scroll">
     <div class="web-reader-sheet">
      <header class="web-reader-header"><p></p><h1></h1><small></small></header>
      <article class="web-reader-article"></article>
     </div>
    </div>
    <div class="web-reader-snapshot" hidden>
     <p class="web-reader-hint">原网页的离线快照。网页脚本和在线组件已停用。</p>
     <iframe title="离线网页快照" sandbox referrerpolicy="no-referrer"></iframe>
    </div>
   </div>
   <aside class="web-reader-side" aria-label="网页阅读设置与标注">
    <div class="web-reader-settings">
     <h3>阅读样式</h3>
     <label>字号 <input type="range" min="14" max="28" step="1" data-web-size><output></output></label>
     <label>版心 <select data-web-width><option value="compact">窄</option><option value="standard">标准</option><option value="wide">宽</option></select></label>
     <label>背景 <select data-web-theme><option value="system">跟随工作台</option><option value="light">白天</option><option value="paper">纸张</option><option value="dark">夜间</option></select></label>
    </div>
    <div class="web-reader-notes">
     <h3>网页标注</h3><p class="web-reader-hint">选中正文后可高亮、保存笔记，或保存为研究笔记。</p>
     <textarea aria-label="阅读笔记" maxlength="1200" rows="2" placeholder="写下一条阅读笔记…"></textarea>
     <div class="web-reader-note-actions">
      <button type="button" class="secondary" data-web-highlight>高亮所选</button>
      <button type="button" class="secondary" data-web-excerpt>保存为研究笔记</button>
      <button type="button" class="primary" data-web-save>保存笔记</button>
     </div>
     <div class="web-reader-mark-list"></div>
    </div>
   </aside>
  </div>`;
  $('readerContent').replaceChildren(shell);
  const get=selector=>shell.querySelector(selector),initial=getWebCheckpoint(record,profileId);
  const session={id:record.id,profileId,shell,prefs:webReaderPrefs(profileId),articleScroll:initial.scroll,mode:null,
   snapshot,article:get('.web-reader-article'),scroll:get('.web-reader-scroll'),articleArea:get('.web-reader-scroll'),snapshotArea:get('.web-reader-snapshot'),
   frame:get('iframe'),articleMode:get('[data-web-article]'),snapshotMode:get('[data-web-snapshot]'),marksButton:get('[data-web-marks]'),
   markList:get('.web-reader-mark-list'),readButton:get('[data-web-done]'),highlighter:get('[data-web-highlight]'),excerptButton:get('[data-web-excerpt]'),exportButton:get('[data-web-export]'),selection:null};
  webReaderSession=session;
  const url=new URL(record.webArticle.url);
  get('.web-reader-header p').textContent=url.hostname;
  get('.web-reader-header h1').textContent=record.title;
  get('.web-reader-header small').textContent=[record.author,record.webArticle.capturedAt?.slice(0,10)].filter(Boolean).join(' · ');
  session.article.innerHTML=content;
  session.snapshotMode.disabled=!snapshotFile;
  get('.web-offline-status').title=snapshot?'正文和快照均可离线读取':'已保存的正文可离线读取';
  const live=get('[data-web-live]');
  live.hidden=!(location.origin==='https://yams-one.example'&&typeof openLiveWebPage==='function');
  live.onclick=()=>openLiveWebPage(record);
  session.articleMode.onclick=()=>selectWebReaderMode(session,'article');
  session.snapshotMode.onclick=async()=>{
   if(session.snapshot){selectWebReaderMode(session,'snapshot');return}
   if(!snapshotFile)return;
   session.snapshotMode.disabled=true;
   try{
    const blob=await readBlob(snapshotFile.id,profileId,{fromSync:true});
    const html=safeCapturedHtml(await blob.text(),{snapshot:true});
    if(session!==webReaderSession||profileId!==appState.activeId)return;
    session.snapshot=html;
    selectWebReaderMode(session,'snapshot');
   }catch(error){if(session===webReaderSession)toast(error.message)}
   finally{session.snapshotMode.disabled=false}
  };
  session.exportButton.onclick=()=>{
   const isSnapshot=session.mode==='snapshot',label=isSnapshot?'离线快照':'正文阅读';
   const html=isSnapshot?session.snapshot:exportWebArticle(record,content);
   downloadBlob(safeFileName(record.title).slice(0,66)+'-'+label+'.html',new Blob([html],{type:'text/html;charset=utf-8'}));
  };
  session.marksButton.onclick=()=>{
   const side=get('.web-reader-side');side.hidden=!side.hidden;
   session.marksButton.setAttribute('aria-expanded',String(!side.hidden));
   get('.web-reader-layout').classList.toggle('web-reader-side-hidden',side.hidden);
  };
  setWebReadLabel(session);
  session.readButton.onclick=async()=>{
   session.readButton.disabled=true;
   try{
    await updateWebRecord(session.id,session.profileId,note=>{
     note.status=note.status==='已读'?'在读':'已读';
     note.webReading=checkpointWebReading(session);note.updatedAt=new Date().toISOString();
    });
    setWebReadLabel(session);
   }catch(error){toast(error.message)}finally{session.readButton.disabled=false}
  };
  const size=get('[data-web-size]'),width=get('[data-web-width]'),theme=get('[data-web-theme]'),sizeLabel=get('output');
  size.value=session.prefs.size;width.value=session.prefs.width;theme.value=session.prefs.theme;
  sizeLabel.textContent=session.prefs.size+' px';
  size.oninput=()=>{session.prefs.size=Number(size.value);sizeLabel.textContent=size.value+' px';setWebReaderPrefs(session)};
  width.onchange=()=>{session.prefs.width=width.value;setWebReaderPrefs(session)};
  theme.onchange=()=>{session.prefs.theme=theme.value;setWebReaderPrefs(session)};
  setWebReaderPrefs(session);
  const noteInput=get('textarea'),saveButton=get('[data-web-save]');
  session.article.addEventListener('pointerdown',()=>{session.selection=null});
  session.article.addEventListener('pointerup',()=>{session.selection=selectedWebText(session)});
  session.article.addEventListener('keyup',()=>{session.selection=selectedWebText(session)});
  const rememberSelection=()=>{const selected=selectedWebText(session);if(selected)session.selection=selected};
  noteInput.addEventListener('pointerdown',rememberSelection);
  session.highlighter.addEventListener('pointerdown',rememberSelection);
  saveButton.addEventListener('pointerdown',rememberSelection);
  async function addMark(withNote){
   const selection=session.mode==='article'?(selectedWebText(session)||session.selection):null;
   if(selection?.tooLong){toast('请选择不超过 2,000 字的正文。');return}
   const note=withNote?noteInput.value.trim():'';
   if(!selection&&!note){toast(withNote?'请选中文字或输入阅读笔记。':'请先在正文中选中文字。');return}
   saveButton.disabled=true;session.highlighter.disabled=true;
   try{
    await saveWebAnnotation(session.id,{id:crypto.randomUUID(),mode:'article',quote:'',start:0,end:0,before:'',after:'',
     ...selection,note,createdAt:new Date().toISOString()});
    if(withNote)noteInput.value='';
    session.selection=null;getSelection()?.removeAllRanges();
   }catch(error){toast(error.message)}
   finally{saveButton.disabled=false;session.highlighter.disabled=session.mode!=='article'}
  }
  session.highlighter.onclick=()=>addMark(false);saveButton.onclick=()=>addMark(true);
  session.excerptButton.onclick=async()=>{
   session.excerptButton.disabled=true;
   try{await saveWebExcerpt(session)}catch(error){toast(error.message)}
   finally{session.excerptButton.disabled=session.mode!=='article'}
  };
  session.scroll.onscroll=()=>{
   if(session.mode!=='article')return;
   const max=session.scroll.scrollHeight-session.scroll.clientHeight;
   session.articleScroll=max>0?Math.max(0,Math.min(1,session.scroll.scrollTop/max)):0;
   checkpointWebReading(session);
  };
  reader.showModal();
  selectWebReaderMode(session,snapshot&&initial.mode==='snapshot'?'snapshot':'article');
  renderWebAnnotations(session);
  const focus=pendingWebFocus;
  pendingWebFocus=null;
  if(focus?.recordId===session.id)focusWebQuote(session,focus);
 }catch(error){
  reader.classList.remove('web-reader');download.hidden=false;
  toast('无法打开网页：'+error.message);
 }
}
$('reader').addEventListener('close',()=>{
 const session=webReaderSession;
 if(!session)return;
 webReaderSession=null;
 $('reader').classList.remove('web-reader');$('readerDownload').hidden=false;
 CSS.highlights?.delete('web-article-mark');
 CSS.highlights?.delete('web-article-focus');
 persistWebReading(session).then(()=>{if(!$('reader').open&&ready)render()});
});
