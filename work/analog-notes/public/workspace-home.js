/**
 * [INPUT]: 读取当前工作台的计划、保存网页和附件阅读进度。
 * [OUTPUT]: 显示最近阅读位置和最先到期的未完成计划。
 * [POS]: 总览首屏复用阅读器和计划详情入口。阅读位置以附件为单位。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

function latestHomeReading(profile){
 const reading=profile.reading||{};
 let latest=null;
 function consider(record,file,openedAt,label){
  const timestamp=Date.parse(openedAt);
  if(Number.isFinite(timestamp)&&(!latest||timestamp>latest.timestamp)){
   latest={record,file,timestamp,label};
  }
 }
 for(const record of profile.records){
  if(record.type!=='resource')continue;
  const finished=record.status==='已读';
  if(record.webArticle){
   if(finished)continue;
   const saved=getWebCheckpoint(record,profile.id);
   if(record.attachments?.some(file=>file.webRole==='article')){
    consider(record,null,saved.updatedAt,saved.mode==='snapshot'?'网页快照':'网页 · 已读 '+Math.round(saved.scroll*100)+'%');
   }
   continue;
  }
  const files=(record.attachments||[]).filter(file=>fileIsPdf(file)||fileIsVideo(file)||fileIsPresentation(file));
  if(!files.length||(finished&&files.length===1))continue;
  const legacy=loadReadingCheckpoint(profile.id,record.id,reading[record.id]||record.readerProgress);
  const legacyFile=finished||record.attachments.some(file=>reading[file.id])?null:legacyReadingAttachment(record,legacy);
  for(const file of files){
   const saved=loadReadingCheckpoint(profile.id,file.id,reading[file.id])||(legacyFile?.id===file.id?legacy:null);
   if(!saved||saved.finished)continue;
   const kindLabel=saved.kind==='video'?'视频':saved.kind==='presentation'||fileIsPresentation(file)?'PPT':'PDF';
   const label=[kindLabel,files.length>1?file.name:'',progressLabel(saved)].filter(Boolean).join(' · ');
   consider(record,file,saved.lastOpened,label);
  }
 }
 return latest;
}

function homeReadingMarkup(latest){
 if(!latest)return '<p class="home-empty">暂无可继续阅读的资料。</p>'
  +'<button type="button" class="home-link" data-home-library>打开资料库 <span aria-hidden="true">→</span></button>';
 const {record,file,label}=latest;
 return '<button type="button" class="home-resume-entry" title="'+esc(record.title)+'" data-home-resume="'+esc(record.id)+'" data-home-file="'+esc(file?.id||'')+'">'
  +'<span class="home-resume-text"><strong>'+esc(record.title)+'</strong><small>'+esc(label)+'</small></span>'
  +'<span class="home-resume-arrow" aria-hidden="true">→</span></button>';
}

function homePlanMarkup(plans){
 const day=today();
 return '<ul class="home-plan-list">'+plans.map(plan=>{
  const remaining=countdownDays(plan.planEnd,day);
  const date=plan.planEnd.slice(5).replace('-','/');
  const deadline=remaining<0?'已逾期':remaining===0?'今天截止':date+' 截止';
  const title=esc(plan.title);
  return '<li><button type="button" class="home-plan-entry" title="'+title+'" data-home-plan="'+esc(plan.id)+'">'
   +'<span class="home-plan-name">'+title+'</span>'
   +'<time datetime="'+esc(plan.planEnd)+'"'+(remaining<0?' class="home-overdue"':'')+'>'+deadline+'</time></button></li>';
 }).join('')+'</ul>';
}

function renderWorkspaceHome(){
 const home=$('workspaceHome'),profile=activeProfile();
 home.hidden=view!=='all'||!profile;
 if(home.hidden)return;
 const latest=latestHomeReading(profile);
 $('homeResume').innerHTML='<h2>'+svg('book')+'继续阅读</h2>'+homeReadingMarkup(latest);
 const upcoming=$('homePlans');
 upcoming.hidden=!activeCategory('plan');
 if(upcoming.hidden)return;
 const plans=profile.records.filter(plan=>plan.type==='plan'&&!archivedPlan(plan)&&validPlanDates(plan.planStart,plan.planEnd))
  .sort((a,b)=>a.planEnd.localeCompare(b.planEnd)||a.planStart.localeCompare(b.planStart)).slice(0,3);
 upcoming.innerHTML='<div class="home-plan-heading"><h2>接下来</h2>'
  +(plans.length?'<button type="button" class="home-link" data-home-all-plans>全部计划 <span aria-hidden="true">→</span></button>':'')
  +'</div>'+(plans.length?homePlanMarkup(plans):'<p class="home-empty">暂无待完成的计划。</p>'
   +'<button type="button" class="home-link" data-home-create-plan>新建计划 <span aria-hidden="true">→</span></button>');
}

$('workspaceHome').addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!ready)return;
 if(button.hasAttribute('data-home-library')){switchView('resource');return}
 if(button.hasAttribute('data-home-all-plans')){switchView('plan');return}
 if(button.hasAttribute('data-home-create-plan')){openNewWorkspaceRecord('plan');return}
 if(button.dataset.homePlan){showDetail(button.dataset.homePlan);return}
 const record=records.find(note=>note.id===button.dataset.homeResume&&note.type==='resource');
 if(!record)return;
 if(record.webArticle){void openSavedWebpage(record);return}
 const file=record.attachments?.find(item=>item.id===button.dataset.homeFile);
 if(file)void openAttachment(file);
});
if(ready)renderWorkspaceHome();
