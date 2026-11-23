'use strict';

const DASHBOARD_WIDGETS={
 paper:['文献阅读','book'],issue:['设计问题','navDesign'],journal:['工作日志','navWork'],study:['学习日志','navStudy'],
 week:['本周新增记录','calendar'],activity:['记录的足迹','navOverview'],unread:['待读资料','navLibrary'],
 pending:['待排查设计问题','navDesign'],pinned:['置顶收藏','navPinned'],
 reminders:['临时提醒','calendar'],quick:['快速开始','plus'],
 plansActive:['进行中的计划','calendar'],planDeadline:['最近计划截止','calendar'],plansWeek:['本周计划','calendar'],
 tapeout:['流片倒计时','navDesign'],test:['测试倒计时','calendar'],deadline:['自定义倒计时','calendar']
};
const DASHBOARD_ZONES={top:'总览上方',side:'右侧栏'};
const DASHBOARD_MAX=26;
const DASHBOARD_INTERACTIVE={reminders:'remindersWidget',quick:'quickStartWidget'};
let dashboardDraft=null,dashboardDragId=null,dashboardSaving=false;
let dashboardLayoutKey='';

function dashboardDefaults(){
 return ['paper','issue','journal','week','activity'].map(kind=>({id:'default-'+kind,kind,zone:kind==='activity'?'side':'top'}));
}
function dashboardWidgetsFor(profile){
 const widgets=profile.dashboardWidgets??dashboardDefaults();
 if(profile.dashboardWidgetLayoutVersion===1)return widgets;
 const used=new Set(widgets.map(widget=>widget.id));
 const added=Object.keys(DASHBOARD_INTERACTIVE).filter(kind=>!widgets.some(widget=>widget.kind===kind)).map(kind=>{
  let id='default-'+kind;
  while(used.has(id))id+='-1';
  used.add(id);return {id,kind,zone:'side'};
 });
 return [...added,...widgets];
}
function isCountdown(kind){return ['tapeout','test','deadline'].includes(kind)}
function validWidgetDate(value){
 if(typeof value!=='string'||!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function validDashboardWidgets(value){
 return Array.isArray(value)&&value.length<=DASHBOARD_MAX&&new Set(value.map(widget=>widget?.id)).size===value.length
  &&Object.keys(DASHBOARD_INTERACTIVE).every(kind=>value.filter(widget=>widget?.kind===kind).length<=1)
  &&value.every(widget=>widget&&typeof widget.id==='string'&&/^[a-z\d-]{1,80}$/i.test(widget.id)&&Object.hasOwn(DASHBOARD_WIDGETS,widget.kind)
   &&Object.hasOwn(DASHBOARD_ZONES,widget.zone)&&(!isCountdown(widget.kind)||(typeof widget.title==='string'
    &&widget.title.trim().length>0&&widget.title.length<=60&&validWidgetDate(widget.date))));
}
function widgetTitle(widget){
 if(widget.kind==='paper')return names.resource||'文献与媒体库';
 return isCountdown(widget.kind)?widget.title:(activeCategory(widget.kind)?.name||DASHBOARD_WIDGETS[widget.kind][0]);
}
function countdownDays(date,day=today()){
 return Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(day+'T00:00:00Z'))/86400000);
}
function countdownLabel(days){
 return days===0?'今天':days>0?days+' 天':'已过 '+(-days)+' 天';
}
function widgetActivity(counts,now){
 const days=[];
 for(let offset=55;offset>=0;offset--){
  const date=today(new Date(now.getFullYear(),now.getMonth(),now.getDate()-offset));
  days.push([date,counts.get(date)||0]);
 }
 return '<div class="activity" aria-label="近 8 周记录分布">'+days.map(([date,count])=>'<div class="cell '+(count?'l'+Math.min(count,3):'')
  +'" title="'+date+' · '+count+' 条记录"></div>').join('')+'</div><div class="heat-foot"><span>'
  +days.filter(([,count])=>count>0).length+' 天有记录</span><span>近 8 周</span></div>';
}
function widgetPlanLinks(plans){
 return '<div class="widget-plan-list">'+plans.slice(0,3).map(plan=>'<button type="button" data-widget-plan="'+esc(plan.id)+'" title="'+esc(plan.title)+'">'+esc(plan.title)+'</button>').join('')+'</div>';
}
function renderDashboardWidgets(){
 const shown=view==='all'&&!!activeProfile();
 $('dashboardWidgets').hidden=$('dashboardSide').hidden=!shown;
 if(!shown)return;
 const widgets=dashboardWidgetsFor(activeProfile()),now=new Date(),day=today(),counts=new Map();
 for(const {date,flashcardKind} of records)if(!flashcardKind)counts.set(date,(counts.get(date)||0)+1);
 const addedDay=record=>(record.createdAt||record.attachments?.[0]?.addedAt||record.date||'').slice(0,10);
 const currentWeek=getWeekKey(day),thisWeek=records.filter(record=>!record.flashcardKind&&addedDay(record)<=day&&getWeekKey(addedDay(record))===currentWeek);
 const plans=records.filter(record=>record.type==='plan'&&validPlanDates(record.planStart,record.planEnd))
  .sort((a,b)=>a.planEnd.localeCompare(b.planEnd)||a.planStart.localeCompare(b.planStart));
 const weekStart=currentPlanMonday(),weekEnd=planEndFor(weekStart,'week');
 function renderWidget(widget){
  const {kind}=widget,heading='<div class="widget-label">'+svg(DASHBOARD_WIDGETS[kind][1])+esc(widgetTitle(widget))+'</div>';
  const metric=(value,foot,attrs='')=>'<div class="widget-value" '+attrs+'>'+value+'</div><div class="widget-foot">'+foot+'</div>';
  let content;
  if(isCountdown(kind))content=metric(countdownLabel(countdownDays(widget.date)),esc(widget.date),'data-countdown="'+widget.date+'"');
  else if(kind==='activity')content=widgetActivity(counts,now);
  else if(kind==='week')content=metric(thisWeek.length,new Set(thisWeek.map(addedDay)).size+' 天有记录');
  else if(kind==='plansActive'){
   const active=plans.filter(plan=>plan.status==='进行中');
   content=metric(active.length,active.length?'项进行中':'暂无进行中的计划')+widgetPlanLinks(active);
  }else if(kind==='plansWeek'){
   const weekly=plans.filter(plan=>plan.planStart<=weekEnd&&plan.planEnd>=weekStart);
   content=metric(weekly.length,weekly.length?weekly.filter(plan=>plan.status==='已完成').length+' 项已完成':'本周暂无安排')+widgetPlanLinks(weekly);
  }else if(kind==='planDeadline'){
   const incomplete=plans.filter(plan=>plan.status!=='已完成');
   const next=incomplete.find(plan=>plan.planEnd>=day)||incomplete.at(-1);
   content=next?metric(countdownLabel(countdownDays(next.planEnd)),esc(next.planEnd),'data-countdown="'+next.planEnd+'"')+widgetPlanLinks([next]):metric('—','暂无未完成计划');
  }
  else if(kind==='unread')content=metric(records.filter(record=>record.type==='resource'&&record.status==='待读').length,'份资料');
  else if(kind==='pending')content=metric(records.filter(record=>record.type==='issue'&&record.status==='待排查').length,'个设计问题');
  else if(kind==='pinned')content=metric(records.filter(record=>!record.flashcardKind&&record.pinned).length,'条已置顶');
  else{
   const group=thisWeek.filter(record=>record.type===kind||kind==='paper'&&record.type==='resource');
   content=metric(group.length,'本周新增');
  }
  return '<article class="dashboard-card'+(kind==='activity'?' widget-activity':'')+'" data-widget="'+esc(widget.id)+'">'+heading+content+'</article>';
 }
 const key=JSON.stringify(widgets.map(({id,kind,zone})=>[id,kind,zone]));
 if(dashboardLayoutKey!==key){
  const parking=$('dashboardWidgetParking');
  for(const id of Object.values(DASHBOARD_INTERACTIVE))parking.append($(id));
  for(const [zone,id] of [['top','dashboardTop'],['side','dashboardSide']]){
   const container=$(id),items=widgets.filter(widget=>widget.zone===zone);
   container.innerHTML=items.map(widget=>Object.hasOwn(DASHBOARD_INTERACTIVE,widget.kind)
    ?'<div class="dashboard-interactive-slot" data-widget="'+esc(widget.id)+'"></div>':renderWidget(widget)).join('');
   for(const [index,widget] of items.entries()){
    if(Object.hasOwn(DASHBOARD_INTERACTIVE,widget.kind))container.children[index].append($(DASHBOARD_INTERACTIVE[widget.kind]));
   }
  }
  dashboardLayoutKey=key;
 }else{
  for(const widget of widgets){
   if(Object.hasOwn(DASHBOARD_INTERACTIVE,widget.kind))continue;
   const card=document.querySelector('.dashboard-card[data-widget="'+widget.id+'"]');
   if(card)card.outerHTML=renderWidget(widget);
  }
 }
 $('dashboardSide').hidden=!$('dashboardSide').childElementCount;
}
function moveDashboardWidget(id,zone,before){
 if(!dashboardDraft||id===before||!Object.hasOwn(DASHBOARD_ZONES,zone))return;
 const index=dashboardDraft.widgets.findIndex(widget=>widget.id===id);
 if(index<0)return;
 const [widget]=dashboardDraft.widgets.splice(index,1);
 widget.zone=zone;
 const target=dashboardDraft.widgets.findIndex(entry=>entry.id===before);
 if(target<0)dashboardDraft.widgets.push(widget);else dashboardDraft.widgets.splice(target,0,widget);
 renderDashboardEditor();
}
function renderDashboardEditor(){
 const widgets=dashboardDraft.widgets;
 for(const [zone,container] of [['top',$('widgetEditTop')],['side',$('widgetEditSide')]]){
  const group=widgets.filter(widget=>widget.zone===zone);
  container.innerHTML=group.map((widget,index)=>{
   const title=esc(widgetTitle(widget));
   const fields=isCountdown(widget.kind)?'<div class="widget-date-fields"><label>名称 <input data-widget-title maxlength="60" required value="'+esc(widget.title)
    +'"></label><label>目标日期 <input type="date" data-widget-date required value="'+esc(widget.date)+'"></label></div>':'';
   return '<div class="widget-edit-row" data-edit-widget="'+esc(widget.id)+'"><div class="widget-edit-line">'
    +'<span class="widget-grip" draggable="true" title="拖动组件" aria-hidden="true">⠿</span><strong>'+title+'</strong>'
    +'<button type="button" class="icon-button" data-widget-action="up" aria-label="上移 '+title+'" '+(!index?'disabled':'')+'>↑</button>'
    +'<button type="button" class="icon-button" data-widget-action="down" aria-label="下移 '+title+'" '+(index===group.length-1?'disabled':'')+'>↓</button>'
    +'<button type="button" class="secondary" data-widget-action="zone">'+(zone==='top'?'移到右侧':'移到上方')+'</button>'
    +'<button type="button" class="danger" data-widget-action="remove" aria-label="移除 '+title+'">移除</button></div>'+fields+'</div>';
  }).join('')||'<p class="section-note">可以把组件拖到这里。</p>';
 }
 const picker=$('widgetKind');
 for(const option of picker.options)option.disabled=Object.hasOwn(DASHBOARD_INTERACTIVE,option.value)&&widgets.some(widget=>widget.kind===option.value);
 if(picker.selectedOptions[0]?.disabled)picker.value=[...picker.options].find(option=>!option.disabled).value;
 $('widgetAdd').disabled=widgets.length>=DASHBOARD_MAX;
}
function initializeDashboardWidgets(){
 const dialog=$('dashboardWidgetDialog'),form=$('dashboardWidgetForm');
 for(const id of ['dashboardTop','dashboardSide'])$(id).addEventListener('click',event=>{
  const plan=event.target.closest('[data-widget-plan]')?.dataset.widgetPlan;
  if(plan)showDetail(plan);
 });
 $('widgetKind').innerHTML=Object.entries(DASHBOARD_WIDGETS).map(([kind,[title]])=>'<option value="'+kind+'">'+title+'</option>').join('');
 $('dashboardCustomize').onclick=()=>{
  if(!ensureReady())return;
  const profile=activeProfile();dashboardDraft={id:profile.id,widgets:structuredClone(dashboardWidgetsFor(profile))};
  $('widgetMessage').textContent='';renderDashboardEditor();dialog.showModal();
 };
 $('widgetAdd').onclick=()=>{
  if(dashboardSaving||dashboardDraft.widgets.length>=DASHBOARD_MAX)return;
  const kind=$('widgetKind').value,zone=$('widgetZone').value;
  if(Object.hasOwn(DASHBOARD_INTERACTIVE,kind)&&dashboardDraft.widgets.some(widget=>widget.kind===kind))return;
  const widget={id:crypto.randomUUID(),kind,zone};
  if(isCountdown(kind))Object.assign(widget,{title:DASHBOARD_WIDGETS[kind][0],date:''});
  dashboardDraft.widgets.push(widget);renderDashboardEditor();
  const row=form.querySelector('[data-edit-widget="'+widget.id+'"]');
  (row.querySelector('[data-widget-date]')||row.querySelector('[data-widget-action=zone]')).focus();
 };
 form.addEventListener('input',event=>{
  const row=event.target.closest('[data-edit-widget]');
  if(!row)return;
  const widget=dashboardDraft.widgets.find(entry=>entry.id===row.dataset.editWidget);
  if(event.target.matches('[data-widget-title]')){widget.title=event.target.value;row.querySelector('strong').textContent=widget.title}
  if(event.target.matches('[data-widget-date]'))widget.date=event.target.value;
 });
 form.addEventListener('click',event=>{
  const action=event.target.closest('[data-widget-action]')?.dataset.widgetAction;
  const id=event.target.closest('[data-edit-widget]')?.dataset.editWidget;
  if(!action||!id||dashboardSaving)return;
  const widgets=dashboardDraft.widgets,widget=widgets.find(entry=>entry.id===id);
  if(action==='remove'){dashboardDraft.widgets=widgets.filter(entry=>entry.id!==id);renderDashboardEditor();$('widgetAdd').focus();return}
  if(action==='zone')moveDashboardWidget(id,widget.zone==='top'?'side':'top');
  else{
   const group=widgets.filter(entry=>entry.zone===widget.zone),index=group.indexOf(widget);
   moveDashboardWidget(id,widget.zone,group[action==='up'?index-1:index+2]?.id);
  }
  form.querySelector('[data-edit-widget="'+id+'"] [data-widget-action=zone]')?.focus();
 });
 form.addEventListener('dragstart',event=>{
  const handle=event.target.closest('.widget-grip');
  if(!handle||dashboardSaving)return;
  dashboardDragId=handle.closest('[data-edit-widget]').dataset.editWidget;
  event.dataTransfer.setData('text/plain',dashboardDragId);event.dataTransfer.effectAllowed='move';
 });
 form.addEventListener('dragover',event=>{
  if(!dashboardDragId||!event.target.closest('[data-widget-zone]'))return;
  event.preventDefault();event.dataTransfer.dropEffect='move';
 });
 form.addEventListener('drop',event=>{
  const zone=event.target.closest('[data-widget-zone]');
  if(!zone||!dashboardDragId)return;
  event.preventDefault();
  const row=event.target.closest('[data-edit-widget]'),bounds=row?.getBoundingClientRect();
  const before=(bounds&&event.clientY>bounds.top+bounds.height/2?row.nextElementSibling:row)?.dataset.editWidget;
  moveDashboardWidget(dashboardDragId,zone.dataset.widgetZone,before);dashboardDragId=null;
 });
 form.addEventListener('dragend',()=>{dashboardDragId=null});
 form.onsubmit=async event=>{
  event.preventDefault();if(dashboardSaving)return;
  const message=$('widgetMessage'),button=$('widgetSave');
  if(!dashboardDraft||dashboardDraft.id!==appState.activeId){message.textContent='工作台已切换，请重新打开组件设置。';return}
  const widgets=dashboardDraft.widgets.map(widget=>isCountdown(widget.kind)?{...widget,title:widget.title.trim()}:widget);
  if(!validDashboardWidgets(widgets)){message.textContent='请填写倒计时名称和有效的目标日期。';return}
  dashboardSaving=true;button.disabled=true;
  try{
   const next=structuredClone(appState),profile=next.profiles.find(profile=>profile.id===next.activeId);
   profile.dashboardWidgets=widgets;profile.dashboardWidgetLayoutVersion=1;
   await commitState(next);dialog.close();renderDashboardWidgets();
  }catch(error){message.textContent=error.message}
  finally{dashboardSaving=false;button.disabled=false}
 };
 dialog.addEventListener('close',()=>{dashboardDraft=null;dashboardDragId=null});
 setInterval(()=>{for(const item of document.querySelectorAll('[data-countdown]'))item.textContent=countdownLabel(countdownDays(item.dataset.countdown))},60000);
}
initializeDashboardWidgets();
