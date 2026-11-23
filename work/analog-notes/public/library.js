'use strict';
let selectedResourceLinks=new Set();
function fileIsVideo(a){return /^video\//.test(a.mime)||/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(a.name)}
function fileIsAudio(a){return /^audio\//.test(a.mime)||/\.mp3$/i.test(a.name)}
function inferredMime(file){if(file.type)return file.type;const ext=file.name.split('.').pop().toLowerCase();return ({pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',mp4:'video/mp4',mp3:'audio/mpeg',webm:'video/webm',ogv:'video/ogg',mov:'video/quicktime',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'})[ext]||'application/octet-stream'}
function sanitizeReadingProgress(p){const number=(v,max)=>Math.min(max,Math.max(0,Number(v)||0));return {kind:p?.kind==='video'?'video':'pdf',page:Math.max(1,Math.round(number(p?.page,100000))),pages:Math.round(number(p?.pages,100000)),scroll:number(p?.scroll,1),time:number(p?.time,31536000),duration:number(p?.duration,31536000),finished:!!p?.finished,lastOpened:typeof p?.lastOpened==='string'?p.lastOpened:new Date().toISOString()}}
function progressLabel(p){if(p.kind==='video')return formatTime(p.time)+(p.duration?' / '+formatTime(p.duration):'');return '第 '+(p.page||1)+' / '+(p.pages||'?')+' 页'}
function formatTime(t){const seconds=Math.max(0,Math.floor(t||0));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')}
function renderLibraryControls(){
 $('importGrokPlan').hidden=view!=='plan';
 function setSortOptionLabel(value,label){const option=$('sort')?.querySelector('[value='+value+']');if(option)option.textContent=label}
 setSortOptionLabel('date',view==='plan'?'计划日期 ↓':'记录日期 ↓');
 setSortOptionLabel('old',view==='plan'?'最早计划 ↑':'最早记录 ↑');
 const journalView=['journal','study'].includes(view);
 $('studyWeeklyBtn').hidden=view!=='study';$('issueTrackFilter').hidden=view!=='issue';
 $('libraryControls').hidden=view!=='resource';$('recordTools').hidden=['all','pinned','resource'].includes(view);$('weeklyBtn').hidden=view!=='journal';$('workWeeklyBtn').hidden=view!=='journal';$('weeklyFilterLabel').hidden=!journalView;
 const weekSelect=$('meetingWeek');
 weekSelect.hidden=!journalView;
 if(journalView){
  const weeks=[...new Set(records.filter(n=>n.type===view&&weeklyJournal(n)).map(n=>getWeekKey(n.date)))].sort().reverse();
  const weekKey=view+':'+weeks.join('|');
  if(weekSelect.dataset.weeks!==weekKey){
   const selected=weekSelect.value;
   weekSelect.dataset.weeks=weekKey;
   weekSelect.replaceChildren(new Option('全部周次',''),...weeks.map(week=>new Option(week,week)));
   if(weeks.includes(selected))weekSelect.value=selected;
  }
 }
 renderWeeklyWorkEntry();
}
$('libraryKind').onchange=render;$('newReadingNote').onclick=()=>openEditor(activeCategory('paper')?'paper':defaultRecordType());$('libraryStatus').onchange=render;$('weeklyOnly').onchange=render;$('meetingWeek').onchange=render;$('weeklyBtn').onclick=openWeeklyMeeting;$('workWeeklyBtn').onclick=openWorkWeek;$('journalKind').onchange=chooseJournalFormat;
$('studyWeeklyBtn').onclick=openStudyWeek;$('issueTrackFilter').onchange=render;
function updateLibraryEditorType(){const type=$('type').value;$('authorField').hidden=!['paper','resource'].includes(type);$('journalKindField').hidden=!['journal','study'].includes(type);$('issueTrackField').hidden=type!=='issue';
 const kind=$('journalKind'),previous=kind.value;
 kind.innerHTML='<option value="daily">按日记录</option>'+Object.entries(WEEKLY_LOGS).filter(([id,format])=>format.type===type&&id!=='work-weekly').map(([id,format])=>'<option value="'+id+'">'+format.label+'</option>').join('');
 if([...kind.options].some(option=>option.value===previous))kind.value=previous}
function loadLibraryEditorFields(note){
 $('author').value=note?.author||'';
 $('journalKind').value=weeklyJournal(note||{})?(note.journalKind==='work-weekly'?'weekly':note.journalKind):'daily';
 $('issueTrack').value=issueTrack(note);
 selectedResourceLinks=new Set(note?.relatedResources||[]);
 $('resourceLinkSearch').value='';
 $('resourceLinkFolder').innerHTML='<option value="">全部文件夹</option><option value="'+FOLDER_ROOT+'">未归档</option>'+recordFolderOptions('resource');
 resourceLinkLimit=50;
 $('resourceLinkChoices').replaceChildren();
 updateEditorResourceCount();
 updateLibraryEditorType();
}
function updateEditorResourceCount(){
 $('editorResourceCount').textContent=selectedResourceLinks.size?'· '+selectedResourceLinks.size+' 项':'';
}
let resourceLinkLimit=50;
function renderResourceChoices(){
 updateEditorResourceCount();
 if(!$('editorResources').open)return;
 const q=$('resourceLinkSearch').value.trim().toLowerCase(),inFolder=recordFolderMatcher('resource',$('resourceLinkFolder').value);
 let list=records.filter(n=>n.id!==editing&&n.type==='resource'&&inFolder(n)&&[n.title,n.author||'',n.reference||''].join(' ').toLowerCase().includes(q));
 const recent=!q&&!$('resourceLinkFolder').value;
 if(recent){
  const lastLinked=new Map();
  for(const note of records)for(const id of note.relatedResources||[]){
   const date=note.updatedAt||note.date||'';if(date>(lastLinked.get(id)||''))lastLinked.set(id,date);
  }
  const lastUsed=note=>[lastLinked.get(note.id),note.webReading?.updatedAt,activeProfile()?.reading?.[note.id]?.lastOpened,note.readerProgress?.lastOpened]
   .filter(Boolean).sort().at(-1)||note.updatedAt||note.date||'';
  const ranked=list.map(note=>[note,lastUsed(note)]).sort((a,b)=>b[1].localeCompare(a[1]));
  list=[...ranked.filter(([note])=>selectedResourceLinks.has(note.id)),...ranked.filter(([note])=>!selectedResourceLinks.has(note.id)).slice(0,6)].map(([note])=>note);
 }
 const choices=$('resourceLinkChoices');
 const summary=()=> (recent?'最近使用 · 搜索或选择文件夹可查找更多':'匹配 '+list.length+' 份')+' · 已关联 '+selectedResourceLinks.size+' 份';
 choices.innerHTML='<p class="tiny">'+summary()+'</p>'+list.slice(0,resourceLinkLimit).map(n=>
  '<label><input type="checkbox" data-link-resource="'+esc(n.id)+'" '+(selectedResourceLinks.has(n.id)?'checked':'')+'><span>'+esc(n.title)+'<small class="tiny"> '+esc([n.author,folderPath(n.folderId,'resource')].filter(Boolean).join(' · '))+'</small></span></label>').join('')
  +(list.length>resourceLinkLimit?'<button type="button" class="secondary" id="moreResourceLinks">显示更多</button>':'');
 choices.onchange=event=>{
  const input=event.target.closest('[data-link-resource]');if(!input)return;
  if(input.checked)selectedResourceLinks.add(input.dataset.linkResource);else selectedResourceLinks.delete(input.dataset.linkResource);
  choices.querySelector('p').textContent=summary();
  updateEditorResourceCount();
 };
 $('moreResourceLinks')?.addEventListener('click',()=>{resourceLinkLimit+=50;renderResourceChoices()});
}
$('resourceLinkSearch').oninput=$('resourceLinkFolder').onchange=()=>{resourceLinkLimit=50;renderResourceChoices()};
$('editorResources').addEventListener('toggle',()=>{if($('editorResources').open)renderResourceChoices()});
function renderResourceLinks(note){
 const related=(note.relatedResources||[]).map(id=>records.find(n=>n.id===id&&n.type==='resource')).filter(Boolean),back=note.type==='resource'?records.filter(n=>n.relatedResources?.includes(note.id)):[];
 const panel=document.createElement('section');panel.className='inline-note-links';
 const path=folderPath(note.folderId,folderScope(note.type));
 if(note.type==='resource')panel.innerHTML='<h3>原始资料</h3><button class="primary" data-read-resource="'+note.id+'">'+(note.readerProgress?'从上次位置继续':'打开 / 阅读资料')+'</button><button class="secondary" data-new-reading="'+note.id+'" style="margin-left:8px">新建阅读笔记</button><p class="reading-status">'+esc(note.status)+(note.readerProgress?' · '+esc(progressLabel(note.readerProgress)):'')+'</p>';
 if(related.length)panel.innerHTML+='<h3>关联资料</h3>'+related.map(n=>'<div class="linked-resource"><span>'+esc(n.title)+'<small>'+esc(n.author||'')+' · '+esc(n.status)+(n.readerProgress?' · '+esc(progressLabel(n.readerProgress)):'')+'</small></span><button class="secondary" data-read-resource="'+n.id+'">阅读</button><button class="secondary" data-resource-details="'+n.id+'">详情</button></div>').join('');
 if(back.length)panel.innerHTML+='<h3 style="margin-top:20px">引用此资料的记录</h3>'+back.map(n=>'<button class="quick" data-resource-details="'+n.id+'">'+esc(n.title)+' ↗</button>').join('');
 if(path)panel.insertAdjacentHTML('afterbegin','<p class="tiny">文件夹 · '+esc(path)+'</p>');
 if(!panel.innerHTML)return;$('detailContent').append(panel);panel.querySelectorAll('[data-read-resource]').forEach(b=>b.onclick=()=>openResource(b.dataset.readResource));panel.querySelectorAll('[data-resource-details]').forEach(b=>b.onclick=()=>showDetail(b.dataset.resourceDetails));panel.querySelectorAll('[data-new-reading]').forEach(b=>b.onclick=()=>{const n=records.find(n=>n.id===b.dataset.newReading);$('detail').close();openEditor(activeCategory('paper')?'paper':defaultRecordType());$('title').value=n.title+' · 阅读笔记';$('author').value=n.author||'';selectedResourceLinks.add(n.id);renderResourceChoices();setEditorMode(true)});
}
async function openResource(id){const note=records.find(n=>n.id===id&&n.type==='resource');if(!note)return;if(note.webArticle)return openSavedWebpage(note);const file=(note.attachments||[]).find(fileIsPdf)||(note.attachments||[])[0];if(!file){toast('此资料尚未添加原文件。');return}return openAttachment(file)}
$('importResources').onclick=()=>$('resourceFileInput').click();
$('importResourceFolder').onclick=()=>$('resourceFolderInput').click();
$('resourceFileInput').onchange=$('resourceFolderInput').onchange=async e=>{
 const files=[...e.target.files],directory=e.target.id==='resourceFolderInput';if(!files.length||!ensureReady())return;
 const total=files.length;
 $('importResources').disabled=$('importResourceFolder').disabled=true;
 let imported=0,failed=0,processed=0;
 startImportProgress('共 '+total+' 份文件，准备导入…');
 try{
  const chunkSize=20;
  for(let start=0;start<files.length;start+=chunkSize){
   if(importProgressRequested())break;
   const chunk=files.slice(start,start+chunkSize);
   const next=structuredClone(appState),p=next.profiles.find(item=>item.id===next.activeId),writes=[],added=[];
   for(const file of chunk){
    if(file.size>MAX_FILE){failed+=1;continue}
    const a={id:crypto.randomUUID(),name:file.name,size:file.size,mime:inferredMime(file),addedAt:new Date().toISOString()};
    const note={id:crypto.randomUUID(),type:'resource',title:file.name.replace(/\.[^.]+$/,'').slice(0,240)||'未命名资料',author:'',reference:'',url:'',body:'',bodyHtml:'',date:today(),tags:[],status:'待读',pinned:false,attachments:[a],updatedAt:new Date().toISOString()};
    try{
     assignDefaultFolder(note);
     if(directory){
      const path=String(file.webkitRelativePath||'').split('/').slice(0,-1);
      const folderId=folderFromImportPath(p,'resource',path,note.folderId||'');
      if(folderId)note.folderId=folderId;else delete note.folderId;
     }
    }catch(error){failed+=1;continue}
    note.createdAt=new Date().toISOString();
    p.records.push(note);writes.push({key:fileKey(p.id,a.id),blob:file});added.push(note);imported+=1;
   }
   processed+=chunk.length;
   if(added.length){
    if(!validRecordFolders(p.folders)){
     for(const note of added)delete note.folderId;
     p.folders=(appState.profiles.find(item=>item.id===appState.activeId)?.folders||[]).map(item=>({...item}));
    }
    await commitState(next,writes);
    queueLiteratureRecognition(added,p.id);
   }
   setImportProgress(Math.min(processed,total),total,chunk[chunk.length-1]?.name||'');
   await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
  }
  const stopped=importProgressRequested()&&processed<total;
  const parts=['已导入 '+imported+' 份资料'];
  if(stopped)parts.push('已取消（剩余 '+(total-processed)+' 份未导入）');
  if(failed)parts.push(failed+' 份失败或超过大小限制');
  const message=parts.join('，');
  finishImportProgress(message);
  render();toast(message);
 }catch(error){finishImportProgress('导入中断：'+error.message);toast(error.message)}
 finally{$('importResources').disabled=$('importResourceFolder').disabled=false;e.target.value=''}
};
function validateInlineReferences(note){const root=document.createElement('template');root.innerHTML=note.bodyHtml||'';for(const slot of root.content.querySelectorAll('[data-image-id]'))if(!note.attachments.some(a=>a.id===slot.dataset.imageId&&fileIsImage(a)))throw new Error('正文中的图片缺少原图附件，请移除该图片或重新插入。')}
