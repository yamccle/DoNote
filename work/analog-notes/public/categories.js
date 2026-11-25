/**
 * [INPUT]: 读取当前工作台的栏目配置和记录。
 * [OUTPUT]: 同步栏目、记录类型和周报入口。
 * [POS]: 为导航和编辑器提供当前工作台可用的记录类型。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
const WORK_LOG_TEMPLATE='今天的工作\n\n进展与结果\n\n问题与待跟进\n\n下一步\n';
const BASE_CATEGORY_DATA=[{id:'paper',name:'文献阅读',icon:'book',template:templates.paper,statuses:['待读','在读','已读']},{id:'issue',name:'问题与课题',icon:'circuit',template:templates.issue,statuses:['待排查','进行中','已解决']},{id:'journal',name:'工作日志',icon:'pen',template:WORK_LOG_TEMPLATE,statuses:['已记录','进行中']},{id:'study',name:'学习日志',icon:'book',template:'学习主题\n\n资料与练习\n\n理解与疑问\n\n下一步学习计划\n',statuses:['已记录','进行中']}];
BASE_CATEGORY_DATA.push({id:'plan',name:'计划',icon:'pen',template:'目标\n\n阶段任务\n\n参考文献与视频\n\n代码及交付资料\n',statuses:['待开始','进行中','已完成']});
function upgradePlanCategory(profile){
 if(profile.planLayoutVersion===1)return false;
 profile.categories??=categoryDefaults();
 if(profile.categories.length>=30&&!profile.categories.some(c=>c.id==='plan'))return false;
 if(!profile.categories.some(c=>c.id==='plan'))profile.categories.push(structuredClone(BASE_CATEGORY_DATA.find(c=>c.id==='plan')));
 profile.planLayoutVersion=1;return true;
}
const LEGACY_JOURNAL_TEMPLATE=templates.journal;
const WEEKLY_LOGS={
 'study-weekly':{type:'study',label:'学习周志',tag:'学习周志',template:'本周学习目标\n\n按日期补充学习进展\n\n收获与练习\n\n待弄懂的问题\n\n下周学习计划\n'},
 'work-weekly':{type:'journal',label:'工作周报',tag:'工作周志',template:'本周目标\n\n按日期补充工作进展\n\n已完成事项\n\n待跟进与下周计划\n'},
 weekly:{type:'journal',label:'工作周报',tag:'周报',template:'本周工作进展\n\n阶段成果与关键图表（可插入图片或附上 PPT）\n\n问题总结与讨论反馈\n\n下周计划\n1. \n2. \n3. \n\n待跟进事项\n'}
};
function categoryDefaults(){return structuredClone(BASE_CATEGORY_DATA)}
function upgradeJournalCategories(profile){
 if(profile.journalLayoutVersion===1)return false;
 profile.categories??=categoryDefaults();
 const index=profile.categories.findIndex(c=>c.id==='journal'),work=profile.categories[index];
 if(work){
  if(work.name==='工作学习日志')work.name='工作日志';
  if(work.template===LEGACY_JOURNAL_TEMPLATE)work.template=WORK_LOG_TEMPLATE;
 }
 if(profile.categories.length<30&&!profile.categories.some(c=>c.id==='study'||c.name==='学习日志')){
  profile.categories.splice(index<0?profile.categories.length:index+1,0,structuredClone(BASE_CATEGORY_DATA.find(c=>c.id==='study')));
 }
 profile.journalLayoutVersion=1;return true;
}
function categoryList(){return activeProfile()?.categories||categoryDefaults()}
function defaultRecordType(){return categoryList()[0]?.id||'paper'}
function activeCategory(id){return categoryList().find(c=>c.id===id)}
const recordTypeName=type=>type==='resource'?'资料条目':names[type];
function validCategories(cats){return Array.isArray(cats)&&cats.length>0&&cats.length<=30&&new Set(cats.map(c=>c.id)).size===cats.length&&cats.every(c=>c&&/^(paper|issue|journal|study|plan|custom-[a-zA-Z0-9-]{1,64})$/.test(c.id)&&typeof c.name==='string'&&c.name.trim()&&c.name.length<=30&&typeof c.template==='string'&&c.template.length<=150000&&Array.isArray(c.statuses)&&c.statuses.length>0&&c.statuses.length<=20&&c.statuses.every(s=>typeof s==='string'&&s.length>0&&s.length<=30)&&['book','circuit','pen'].includes(c.icon))}
function syncCategoryConfig(){
 if(!appState)return;for(const p of appState.profiles){if(!p.categories)p.categories=categoryDefaults();if(!p.reading)p.reading={};if(!p.navLabels)p.navLabels={workspace:"工作台",overview:"总览",library:"文献与媒体库",pinned:"置顶收藏"}}
 for(const key of Object.keys(names))if(!['all','pinned'].includes(key))delete names[key];for(const key of Object.keys(templates))delete templates[key];for(const key of Object.keys(statusOptions))delete statusOptions[key];
 for(const c of categoryList()){names[c.id]=c.id==='paper'?'阅读笔记':c.name;templates[c.id]=c.template;statusOptions[c.id]=c.statuses}
 names.all=activeProfile().navLabels.overview;names.pinned=activeProfile().navLabels.pinned;names.resource=activeProfile().navLabels.library;templates.resource='资料摘要\n\n作者 / 来源\n\n阅读问题与思考\n';statusOptions.resource=['待读','在读','已读'];
}
const BUILTIN_CATEGORY_ICONS={issue:'navDesign',journal:'navWork',study:'navStudy',plan:'calendar'};
const categoryIcon=category=>BUILTIN_CATEGORY_ICONS[category.id]||category.icon;
const DEFAULT_NAV_DESCRIPTIONS={
 all:'把文献、工作记录和下一步安排放在一起。',
 issue:'记录现象、验证假设，让每一次排查都能复用。',
 journal:'记录日常工作，汇总本周进展、问题与下周安排。',
 study:'记录学到的知识、练习和仍待弄懂的问题。',
 plan:'安排接下来的任务、起止日期和参考资料。',
 resource:'收藏文献、网页和视频，随时继续阅读。',
 pinned:'把值得反复查看的记录放在随手可及的地方。'
};
function navDescription(id){
 return activeProfile()?.navDescriptions?.[id]||DEFAULT_NAV_DESCRIPTIONS[id]||'整理这个栏目里的资料与思考。';
}
function validNavDescriptions(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=33
  &&Object.entries(value).every(([id,text])=>/^(all|resource|pinned|paper|issue|journal|study|plan|custom-[a-z0-9-]{1,64})$/i.test(id)
   &&typeof text==='string'&&text.length<=160);
}
function loadNavDescription(){
 const id=$('navDescriptionCategory').value;
 $('navDescriptionText').value=activeProfile().navDescriptions?.[id]||'';
 $('navDescriptionText').placeholder=DEFAULT_NAV_DESCRIPTIONS[id]||'整理这个栏目里的资料与思考。';
}
function renderNavDescriptionChoices(){
 const select=$('navDescriptionCategory'),selected=select.value;
 const ids=['all',...categoryList().map(c=>c.id).filter(id=>id!=='paper'),'resource','pinned'];
 select.innerHTML=ids.map(id=>'<option value="'+esc(id)+'">'+esc(names[id])+'</option>').join('');
 select.value=ids.includes(selected)?selected:ids.includes(view)?view:'all';loadNavDescription();
}
$('navDescriptionCategory').onchange=loadNavDescription;
$('navDescriptionForm').onsubmit=async event=>{
 event.preventDefault();
 const id=$('navDescriptionCategory').value,text=$('navDescriptionText').value.trim(),message=$('navDescriptionStatus');
 try{
  const next=structuredClone(appState),p=next.profiles.find(profile=>profile.id===next.activeId);
  p.navDescriptions??={};if(text)p.navDescriptions[id]=text;else delete p.navDescriptions[id];
  if(!validNavDescriptions(p.navDescriptions))throw new Error('栏目说明最多 160 个字符。');
  await commitState(next);render();message.textContent='栏目说明已保存。';
 }catch(error){message.textContent=error.message}
};
function renderCategoryNavigation(){
 syncCategoryConfig();
 const cats=categoryList(),cutoff=Date.now()-14*24*60*60*1000;
 const recent=n=>{const added=Date.parse(n.createdAt||n.date+'T00:00:00');return Number.isFinite(added)&&added>=cutoff};
 const count=id=>records.filter(n=>!n.flashcardKind&&n.type===id&&(id==='plan'?!archivedPlan(n):recent(n))).length;
 const cutoff7d=Date.now()-7*24*60*60*1000;
 const recent7=n=>{const added=Date.parse(n.createdAt||n.attachments?.[0]?.addedAt||(n.date+'T00:00:00'));return Number.isFinite(added)&&added>=cutoff7d};
 const railBadgeFor=id=>{
  if(id==='plan')return records.filter(n=>!n.flashcardKind&&n.type==='plan'&&!archivedPlan(n)&&n.status==='进行中').length;
  if(id==='issue')return records.filter(n=>!n.flashcardKind&&n.type==='issue'&&n.status!=='已解决').length;
  if(id==='resource')return records.filter(n=>!n.flashcardKind&&(n.type==='resource'||n.type==='paper')&&recent7(n)).length;
  return 0;
 };
 $('crumb').textContent=names[view]||'总览';$('listTitle').textContent=view==='all'?'最近记录':names[view]||'记录';$('pageTitle').textContent=names[view]||'记录';
 $('listTitle').closest('.section-heading').hidden=view!=='all';
 const description=activeProfile().navDescriptions?.[view]||'';
 $('pageSub').textContent=description;$('pageSub').hidden=!description;
 const railItems=[
  ['all','navOverview',0,0],
  ...cats.filter(c=>c.id!=='paper').map(c=>[c.id,categoryIcon(c),count(c.id),railBadgeFor(c.id)]),
  ['resource','navLibrary',count('resource')+count('paper'),railBadgeFor('resource')],
  ['pinned','navPinned',records.filter(n=>!n.flashcardKind&&n.pinned&&recent(n)).length,0]
 ];
 renderWorkspaceRail(railItems);
 const showAchievements=view==='pinned'&&(window.DoNoteAchievements?.isEnabled?.()!==false);
 if(tab==='achievements'&&!showAchievements)tab='all';
 $('tabs').innerHTML='<button class="tab '+(tab==='all'?'active':'')+'" data-tab="all">全部记录</button>'+cats.filter(c=>c.id!=='paper').map(c=>'<button class="tab '+(tab===c.id?'active':'')+'" data-tab="'+c.id+'">'+esc(c.name)+'</button>').join('')+'<button class="tab '+(tab==='resource'?'active':'')+'" data-tab="resource">'+esc(names.resource)+'</button>'+(showAchievements?'<button id="achievementTab" class="tab '+(tab==='achievements'?'active':'')+'" data-tab="achievements">成就殿宇</button>':'');
 const type=$('type').value;
 $('type').replaceChildren(...[...cats.map(c=>c.id),'resource'].map(id=>new Option(recordTypeName(id),id)));
 $('type').value=statusOptions[type]?type:defaultRecordType();
 $('tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(b){tab=b.dataset.tab;render()}};
 if(typeof renderLibraryControls==='function')renderLibraryControls();
}
let categoryEditing=null;
let categoryManagerReady=false,categoryDragTarget=null;
function setupCategoryManager(){
 if(categoryManagerReady)return;categoryManagerReady=true;
 const body=$('categoriesDialog').querySelector('.modalbody'),list=$('categoryList'),form=$('categoryForm'),message=$('categoryMessage');
 const hidden=document.createElement('div');hidden.hidden=true;
 for(const id of ['navLabelsForm','navDescriptionForm'])hidden.append($(id));
 hidden.append($('categoryDestination').closest('.field'));
 body.replaceChildren();
 const hint=document.createElement('p');hint.className='section-note';hint.textContent='名称和页面说明在同一处编辑。拖动把手调整栏目顺序；总览、资料库和收藏为固定入口。';
 body.append(hint,list,form,message,hidden);
 form.querySelector('input').placeholder='输入新栏目名称';
}
async function editWorkspaceSection(id){
 const profileId=appState.activeId,name=names[id],description=activeProfile().navDescriptions?.[id]||'';
 const dialog=document.createElement('dialog');dialog.className='compact-dialog';
 dialog.innerHTML='<form><div class="modalhead"><h2>编辑栏目</h2></div><div class="modalbody"><div class="field"><label>栏目名称<input name="sectionName" maxlength="30" required></label></div><div class="field"><label>页面说明<textarea name="sectionDescription" maxlength="160" rows="3"></textarea></label><p class="tiny">留空使用默认说明。</p></div><p class="form-message" role="alert"></p></div><div class="modalfoot"><button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="primary">保存</button></div></form>';
 const form=dialog.querySelector('form');form.elements.sectionName.value=name;form.elements.sectionDescription.value=description;form.elements.sectionDescription.placeholder=navDescription(id);
 dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
 form.onsubmit=async event=>{
  event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
  try{
   if(profileId!==appState.activeId)throw new Error('用户已切换，请重新编辑。');
   const title=form.elements.sectionName.value.trim(),text=form.elements.sectionDescription.value.trim();
   if(!title||title.length>30||text.length>160)throw new Error('请检查名称和说明长度。');
   if(Object.entries(names).some(([key,value])=>key!==id&&key!=='paper'&&value===title))throw new Error('已有同名栏目或入口。');
   const next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId),labelKey={all:'overview',resource:'library',pinned:'pinned'}[id];
   if(labelKey)p.navLabels[labelKey]=title;else{const item=p.categories.find(c=>c.id===id);if(!item)throw new Error('栏目已变化。');item.name=title}
   p.navDescriptions??={};if(text)p.navDescriptions[id]=text;else delete p.navDescriptions[id];
   await commitState(next);render();renderCategoryManager();dialog.close();toast('栏目名称与说明已保存。');
  }catch(error){form.querySelector('[role=alert]').textContent=error.message}finally{button.disabled=false}
 };
 dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
}
async function reorderCategory(id,targetId,profileId=appState.activeId){
 if(profileId!==appState.activeId)throw new Error('用户已切换，请重新排序。');
 const next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId),from=p.categories.findIndex(c=>c.id===id),to=p.categories.findIndex(c=>c.id===targetId);
 if(from<0||to<0||from===to)return;
 const [item]=p.categories.splice(from,1);p.categories.splice(to,0,item);await commitState(next);render();renderCategoryManager();$('categoryMessage').textContent='顺序已保存。';
}
async function deleteManagedCategory(id){
 const profileId=appState.activeId,category=activeCategory(id);if(!category)return;
 if(categoryList().length===1)throw new Error('请至少保留一个栏目。');
 const affected=records.filter(n=>n.type===id),others=categoryList().filter(c=>c.id!==id&&c.id!=='paper');
 const dialog=document.createElement('dialog');dialog.className='compact-dialog';
 dialog.innerHTML='<div class="modalhead"><h2>删除栏目</h2></div><div class="modalbody"><p></p><label '+(affected.length?'':'hidden')+'>记录转移到<select aria-label="记录转移目标">'+others.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>').join('')+'</select></label></div><div class="modalfoot"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="danger" data-confirm>删除栏目</button></div>';
 dialog.querySelector('p').textContent='删除「'+category.name+'」？'+(affected.length?'其中 '+affected.length+' 条记录会转移到所选栏目，正文与附件会保留。':'此栏目没有记录。');
 dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
 const chosen=await new Promise(resolve=>{dialog.addEventListener('close',()=>{resolve(dialog.dataset.target||'');dialog.remove()},{once:true});dialog.querySelector('[data-confirm]').onclick=()=>{dialog.dataset.target=dialog.querySelector('select').value;dialog.close()};document.body.append(dialog);dialog.showModal()});
 if(!chosen)return;
 if(profileId!==appState.activeId||!activeCategory(id)||!activeCategory(chosen))throw new Error('栏目或用户已变化，请重试。');
 if(records.filter(n=>n.type===id).length!==affected.length)throw new Error('栏目记录已变化，请重试。');
 const next=structuredClone(appState),p=next.profiles.find(p=>p.id===profileId);
 p.categories=p.categories.filter(c=>c.id!==id);if(p.navDescriptions)delete p.navDescriptions[id];
 if(id!=='paper'&&p.folders)p.folders=p.folders.filter(folder=>folder.scope!==id);
 p.records=p.records.map(n=>n.type===id?{...n,type:chosen,...(chosen==='plan'?{planStart:today(),planEnd:planEndFor(today(),'week')}:{}),folderId:scopedFolderId(chosen,n.folderId,p)||undefined,status:statusOptions[chosen][0],updatedAt:new Date().toISOString()}:n);
 await commitState(next);syncCategoryConfig();if(view===id)view='all';render();renderCategoryManager();$('categoryMessage').textContent='栏目已删除'+(affected.length?'，记录已转移。':'。');
}
function renderCategoryManager(){
 setupCategoryManager();renderNavDescriptionChoices();
 const cats=categoryList().filter(c=>c.id!=='paper'),fixed=id=>({id,name:names[id],fixed:true});
 const entries=[fixed('all'),...cats,fixed('resource'),fixed('pinned')];
 $('categoryList').innerHTML=entries.map(c=>{
  const i=cats.findIndex(item=>item.id===c.id),count=records.filter(n=>n.type===c.id||c.id==='resource'&&n.type==='paper').length;
  return '<div class="manager-row category-sort-row" '+(!c.fixed?'data-category-id="'+esc(c.id)+'"':'data-fixed-category="'+c.id+'"')+'>'
   +(c.fixed?'<span class="category-fixed-icon" aria-hidden="true">•</span>':'<button type="button" class="icon-button category-drag-handle" draggable="true" aria-label="拖动排序 '+esc(c.name)+'" title="拖动调整顺序">⠿</button>')
   +'<span class="category-row-name">'+esc(c.name)+'<small class="tiny">'+(c.fixed?'固定入口':count+' 条记录')+'</small></span><div class="category-row-actions">'
   +(!c.fixed?'<button type="button" class="secondary" data-category-up="'+i+'" aria-label="上移 '+esc(c.name)+'" '+(i?'':'disabled')+'>↑</button><button type="button" class="secondary" data-category-down="'+i+'" aria-label="下移 '+esc(c.name)+'" '+(i===cats.length-1?'disabled':'')+'>↓</button>':'')
   +'<button type="button" class="secondary" data-category-edit="'+c.id+'">编辑</button>'+(!c.fixed?'<button type="button" class="danger" data-category-delete="'+c.id+'">删除</button>':'')+'</div></div>';
 }).join('');
 $('categoryDestination').innerHTML=cats.map(c=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join('');
 const action=fn=>async()=>{try{await fn()}catch(e){$('categoryMessage').textContent=e.message}};
 for(const button of $('categoryList').querySelectorAll('[data-category-up],[data-category-down]'))button.onclick=action(()=>{const i=Number(button.dataset.categoryUp??button.dataset.categoryDown),to=i+(button.dataset.categoryUp!==undefined?-1:1);return reorderCategory(cats[i].id,cats[to]?.id)});
 for(const button of $('categoryList').querySelectorAll('[data-category-edit]'))button.onclick=action(()=>editWorkspaceSection(button.dataset.categoryEdit));
 for(const button of $('categoryList').querySelectorAll('[data-category-delete]'))button.onclick=action(()=>deleteManagedCategory(button.dataset.categoryDelete));
 for(const row of $('categoryList').querySelectorAll('[data-category-id]')){
  row.querySelector('[draggable]').ondragstart=event=>{categoryDragTarget={id:row.dataset.categoryId,profile:appState.activeId};event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',row.dataset.categoryId);row.classList.add('category-dragging')};
  row.ondragover=event=>{if(categoryDragTarget&&categoryDragTarget.profile===appState.activeId){event.preventDefault();event.dataTransfer.dropEffect='move';row.classList.add('category-drop-target')}};
  row.ondragleave=()=>row.classList.remove('category-drop-target');
  row.ondrop=async event=>{event.preventDefault();const dragged=categoryDragTarget;categoryDragTarget=null;row.classList.remove('category-drop-target');if(!dragged)return;try{await reorderCategory(dragged.id,row.dataset.categoryId,dragged.profile)}catch(e){$('categoryMessage').textContent=e.message}};
  row.ondragend=()=>{categoryDragTarget=null;document.querySelectorAll('.category-dragging,.category-drop-target').forEach(el=>el.classList.remove('category-dragging','category-drop-target'))};
 }
}
function openCategoryManager(){if(!ensureReady())return;categoryEditing=null;renderNavLabelsForm();$('categoryForm').reset();$('categorySave').textContent='添加栏目';$('categoryMessage').textContent='';renderCategoryManager();$('categoriesDialog').showModal()}
$('categoriesBtn').onclick=openCategoryManager;
$('categoryForm').onsubmit=async e=>{e.preventDefault();try{const name=$('categoryName').value.trim();if(!name)return;if(Object.entries(names).some(([id,label])=>label===name&&id!==categoryEditing))throw new Error('已有同名栏目。');const next=structuredClone(appState),p=next.profiles.find(p=>p.id===next.activeId);if(categoryEditing)p.categories.find(c=>c.id===categoryEditing).name=name;else{if(p.categories.length>=30)throw new Error('最多保留 30 个栏目。');p.categories.push({id:'custom-'+crypto.randomUUID(),name,icon:'pen',template:'记录内容\n\n发现与思考\n\n下一步\n',statuses:['已记录','进行中','已完成']})}await commitState(next);categoryEditing=null;$('categoryForm').reset();$('categorySave').textContent='添加栏目';render();renderCategoryManager()}catch(error){$('categoryMessage').textContent=error.message}};
function getWeekKey(date){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));const y=d.getUTCFullYear(),first=new Date(Date.UTC(y,0,1));return y+'-W'+String(Math.ceil((((d-first)/86400000)+1)/7)).padStart(2,'0')}
function weeklyJournal(note){return Object.hasOwn(WEEKLY_LOGS,note.journalKind)&&WEEKLY_LOGS[note.journalKind].type===note.type}
function journalBadge(note){return weeklyJournal(note)?'<span class="meeting-badge">'+WEEKLY_LOGS[note.journalKind].label+' · '+getWeekKey(note.date)+'</span>':''}
function autoWeeklyTitle(title){return /^\d{4}-W\d{2} (组会周报|工作周志|工作周报|学习周志)$/.test(title)}
function chooseJournalFormat(){
 const defaultBody=templates[$('type').value];
 const kind=$('journalKind').value,format=WEEKLY_LOGS[kind],body=$('body').value.trim(),title=$('title');
 if(!body||[defaultBody,...Object.values(WEEKLY_LOGS).map(item=>item.template)].some(text=>text?.trim()===body)){
  $('body').value=format?.template||defaultBody;loadRichBody(null);
 }
 if(!title.value.trim()||autoWeeklyTitle(title.value))title.value=format?getWeekKey($('date').value||today())+' '+format.label:'';
}
function openWeeklyLog(kind){
 const type=WEEKLY_LOGS[kind].type;if(!activeCategory(type))return;
 openEditor(type);if(!$('editor').open)return;
 $('journalKind').value=kind;chooseJournalFormat();setEditorMode(true);queueDraft();
}
function openWeeklyMeeting(){openCurrentWorkReport()}
function openCurrentWeek(kind){
 const type=WEEKLY_LOGS[kind].type;
 if(!activeCategory(type))return;
 const week=getWeekKey(today());
 const existing=records.filter(note=>note.type===type&&note.journalKind===kind&&getWeekKey(note.date)===week).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')||records.indexOf(b)-records.indexOf(a))[0];
 if(existing){openEditor(type,existing);if($('editor').open)setEditorMode(true)}
 else openWeeklyLog(kind);
}
function openWorkWeek(){openCurrentWorkReport()}
function openStudyWeek(){openCurrentWeek('study-weekly')}

function openCurrentWorkReport(){
 if(!activeCategory('journal'))return;
 const week=getWeekKey(today()),existing=records.filter(n=>n.type==='journal'&&['weekly','work-weekly'].includes(n.journalKind)&&getWeekKey(n.date)===week).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')||records.indexOf(b)-records.indexOf(a))[0];
 if(existing){openEditor('journal',existing);if($('editor').open)setEditorMode(true)}
 else openWeeklyLog('weekly');
}
function renderWeeklyWorkEntry(){
 const button=$('workWeeklyBtn');button.textContent='本周周报';button.title='续写本周进展、问题总结、组会反馈和下周计划';button.onclick=openCurrentWorkReport;
 $('weeklyBtn').hidden=true;
}

function renderNavLabelsForm(){const n=activeProfile().navLabels;$('workspaceName').value=n.workspace;$('overviewName').value=n.overview;$('libraryName').value=n.library;$('pinnedName').value=n.pinned}
function validNavLabels(n){return n&&['workspace','overview','library','pinned'].every(k=>typeof n[k]==='string'&&n[k].trim()&&n[k].length<=30)}
$('navLabelsForm').onsubmit=async e=>{e.preventDefault();try{const labels={workspace:$('workspaceName').value.trim(),overview:$('overviewName').value.trim(),library:$('libraryName').value.trim(),pinned:$('pinnedName').value.trim()};if(!validNavLabels(labels))throw new Error('请填写导航名称。');const next=structuredClone(appState);next.profiles.find(p=>p.id===next.activeId).navLabels=labels;await commitState(next);render();$('categoryMessage').textContent='导航名称已保存。'}catch(error){$('categoryMessage').textContent=error.message}};
