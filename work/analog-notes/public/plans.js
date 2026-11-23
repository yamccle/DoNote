'use strict';

function validPlanTrack(value){return value===undefined||['','journal','study'].includes(value)}
function validPlanDates(start,end){return validWidgetDate(start)&&validWidgetDate(end)&&start<=end}
function planEndFor(start,preset){
 if(!validWidgetDate(start))return '';
 const date=new Date(start+'T00:00:00Z');
 if(preset==='week')date.setUTCDate(date.getUTCDate()+6);
 else if(preset==='month'){
  const day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+1);
  const last=new Date(date);last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
  date.setUTCDate(Math.min(day,last.getUTCDate()));date.setUTCDate(date.getUTCDate()-1);
 }
 return date.toISOString().slice(0,10);
}
function setupPlanFields(type,note){
 $('planFields').hidden=type!=='plan';
 for(const field of $('editorMetadata').querySelectorAll('[data-plan-option]'))field.hidden=type!=='plan';
 $('recordDateField').hidden=type==='plan';$('date').disabled=type==='plan';
 if(type!=='plan')return;
 $('planTrack').value=note?.planTrack||(['journal','study'].includes(view)?view:'');
 $('planPeriod').value=note?'custom':'week';
 $('planStart').value=note?.planStart||today();
 $('planEnd').value=note?.planEnd||planEndFor($('planStart').value,'week');
}
function updatePlanEnd(){
 const period=$('planPeriod').value;if(period!=='custom')$('planEnd').value=planEndFor($('planStart').value,period);
}
$('planPeriod').onchange=$('planStart').onchange=updatePlanEnd;
$('planEnd').oninput=()=>{$('planPeriod').value='custom'};
function planBadge(note){
 return note.type==='plan'&&validPlanDates(note.planStart,note.planEnd)
  ?'<span class="meeting-badge">'+esc(note.planStart)+' 至 '+esc(note.planEnd)+(note.planTrack?' · '+esc(names[note.planTrack]||({journal:'工作日志',study:'学习日志'}[note.planTrack])):'')+'</span>':'';
}
const recordTimelineDate=note=>note.type==='plan'?note.planStart:note.date;
let planArchiveMode=false,planArchiveProfile=null;
const journalPlanSelection=new Map();
const archivedPlan=note=>note.type==='plan'&&note.status==='已完成';
function addCompletedPlanLog(profile,plan){
 const track=plan.planTrack;
 if(!archivedPlan(plan)||!['journal','study'].includes(track))return false;
 const linked=note=>note.planSourceId===plan.id;
 if(profile.records.some(linked)||trashOf(profile).some(entry=>linked(entry.record)))return false;
 const now=new Date().toISOString();
 const title=('完成计划 · '+plan.title).slice(0,240);
 const body=('来自计划：'+plan.title+'\n'+plan.planStart+' 至 '+plan.planEnd+'\n'+plan.body).slice(0,150000);
 profile.records.push({id:crypto.randomUUID(),type:track,title,body,date:today(),createdAt:now,updatedAt:now,
  tags:[...plan.tags],status:'已记录',author:plan.author||'',relatedResources:[...(plan.relatedResources||[])],
  attachments:[],pinned:false,planSourceId:plan.id,journalKind:'daily'});
 return true;
}
function renderPlanArchiveControl(){
 if(planArchiveProfile!==appState.activeId){planArchiveProfile=appState.activeId;planArchiveMode=false;journalPlanSelection.clear()}
 if(view!=='plan')planArchiveMode=false;
 let button=$('planArchiveToggle');
 if(!button){button=document.createElement('button');button.id='planArchiveToggle';button.type='button';button.className='secondary';$('recordFolderBar').append(button);
  button.onclick=()=>{planArchiveMode=!planArchiveMode;libraryPage=1;render()};
 }
 button.hidden=view!=='plan';
 button.setAttribute('aria-pressed',String(planArchiveMode));
 const count=records.filter(archivedPlan).length;
 button.textContent=planArchiveMode?'返回未完成计划':'已完成归档（'+count+'）';
 if(view==='plan'){
  $('listTitle').textContent=planArchiveMode?'已完成归档':names.plan;
  $('listTitle').closest('.section-heading').hidden=!planArchiveMode;
 }
}
function renderJournalPlans(){
 const section=$('journalPlans'),linked=['journal','study'].includes(view)
  ?records.filter(note=>note.type==='plan'&&note.planTrack===view&&!archivedPlan(note)).sort((a,b)=>Number(b.status==='进行中')-Number(a.status==='进行中')||b.planStart.localeCompare(a.planStart)):[];
 section.hidden=!linked.length;
 section.classList.toggle('plan-stack-multiple',linked.length>1);
 if(!linked.length){section.replaceChildren();return}
 const key=appState.activeId+'/'+view;
 const selected=journalPlanSelection.get(key),index=Math.max(0,linked.findIndex(n=>n.id===selected)),note=linked[index];
 journalPlanSelection.set(key,note.id);
 section.innerHTML='<h2>本栏目计划 <span class="tiny">'+linked.length+' 项</span></h2><div class="plan-stack-slide" aria-live="polite"><button type="button" class="quick" data-journal-plan="'+esc(note.id)+'"><span><b>'+esc(note.title)+'</b><small>'+esc(note.planStart)+' 至 '+esc(note.planEnd)+' · '+esc(note.status)+'</small></span><span class="arrow">↗</span></button></div>'
  +(linked.length>1?'<div class="plan-stack-controls"><span class="tiny">'+(index+1)+' / '+linked.length+'</span><button type="button" class="secondary" data-plan-step="-1" aria-label="上一个栏目计划">‹</button><button type="button" class="secondary" data-plan-step="1" aria-label="下一个栏目计划">›</button></div>':'');
 section.onclick=event=>{
  const step=event.target.closest('[data-plan-step]');
  if(step){journalPlanSelection.set(key,linked[(index+Number(step.dataset.planStep)+linked.length)%linked.length].id);renderJournalPlans();section.querySelector('[data-plan-step="'+step.dataset.planStep+'"]')?.focus({preventScroll:true});return}
  const id=event.target.closest('[data-journal-plan]')?.dataset.journalPlan;if(id)showDetail(id);
 };
}

function planMarkdown(text,{extractTitle=false}={}){
 const source=String(text||'').replace(/\r\n?/g,'\n').trim();
 if(source.length>150000)throw new Error('计划原文最多 150,000 字符。');
 const lines=source.split('\n');
 let fence='',titleIndex=-1,title='',weekly=false;
 const formatted=lines.map((line,index)=>{
  const marker=/^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  if(marker){
   if(!fence)fence=marker;
   else if(marker[0]===fence[0]&&marker.length>=fence.length&&/^\s*[`~]+\s*$/.test(line))fence='';
   return line;
  }
  if(fence)return line;
  const heading=line.match(/^\s{0,3}#{1,6}\s+(.+)$/)?.[1];
  const bold=line.match(/^\s*\*\*(.+?)\*\*(?:\s*[（(].*[）)])?\s*\\?\s*$/);
  const display=line.trim().replace(/^#{1,6}\s+/,'').replace(/\*\*/g,'').replace(/\\$/,'').trim();
  const week=/^W\d+\s*(?:[·.：:–—-]|\s)/i.test(display);
  if(extractTitle&&(week&&!weekly||!title&&heading)){
   titleIndex=index;title=display.slice(0,240);weekly=week;
  }
  if(bold)return '## '+display;
  return line;
 });
 if(titleIndex>=0)formatted[titleIndex]='';
 const html=safeRichHtml(marked.parse(formatted.join('\n'),{gfm:true,breaks:true}));
 return {title:title||'Grok 学习计划',weekly,html};
}
function currentPlanMonday(){
 const now=new Date();now.setDate(now.getDate()-(now.getDay()+6)%7);return today(now);
}
function linkExistingPlanResources(html){
 const content=document.createElement('template');content.innerHTML=html;
 const urls=new Set();
 for(const link of content.content.querySelectorAll('a[href]'))try{urls.add(canonicalWebArticleUrl(link.href))}catch{}
 for(const note of records){
  if(note.type!=='resource'||selectedResourceLinks.size>=100)continue;
  try{if(urls.has(canonicalWebArticleUrl(note.webArticle?.url||note.url)))selectedResourceLinks.add(note.id)}catch{}
 }
 renderResourceChoices();
}
$('importGrokPlan').onclick=()=>{
 if(!ensureReady())return;
 $('grokPlanForm').reset();$('grokPlanMessage').textContent='';$('grokPlanDialog').showModal();$('grokPlanText').focus();
};
$('grokPlanChooseFile').onclick=()=>$('grokPlanFile').click();
$('grokPlanFile').onchange=async event=>{
 const file=event.target.files[0];if(!file)return;
 try{
  if(file.size>600000)throw new Error('Markdown 或文本文件过大。');
  const text=await file.text();if(text.length>150000)throw new Error('计划原文最多 150,000 字符。');
  $('grokPlanText').value=text;$('grokPlanMessage').textContent='';
 }catch(error){$('grokPlanMessage').textContent=error.message}
 finally{event.target.value=''}
};
$('grokPlanForm').onsubmit=event=>{
 event.preventDefault();
 const source=$('grokPlanText').value;if(!source.trim())return;
 try{
  const {title,weekly,html}=planMarkdown(source,{extractTitle:true});
  if(!richPlainText(html).trim())throw new Error('请粘贴包含正文的计划。');
  $('grokPlanDialog').close();openEditor('plan');
  $('title').value=title;$('richBody').innerHTML=html;syncRichBody();
  if(weekly){$('planStart').value=currentPlanMonday();updatePlanEnd()}
  linkExistingPlanResources(html);
  const file=new File([source],safeFileName(title).slice(0,65)+'-原文.md',{type:'text/markdown'});
  const attachment=attachmentFromFile(file);draftAttachments.push(attachment);stagedFiles.set(attachment.id,file);
  renderDraftAttachments();setEditorMode(true);queueDraft();
  $('formMessage').textContent=weekly?'已识别周计划，默认从本周一开始。请确认日期后保存。':'请确认计划日期后保存。';
 }catch(error){$('grokPlanMessage').textContent=error.message}
};
