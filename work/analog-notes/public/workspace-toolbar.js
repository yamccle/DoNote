/**
 * [INPUT]: 读取现有搜索、筛选和栏目操作控件。
 * [OUTPUT]: 在同一工具栏布置常用操作，显示已应用的筛选数量。
 * [POS]: 保留控件的 ID 和事件，复用资料库的原生浮层。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const workspaceToolbar=document.querySelector('.searchrow');
const workspaceToolbarButtons=document.createElement('div');
const workspaceToolbarPopovers=new Map();
let workspaceToolbarView;

function positionToolbarPopover(button,panel){
 const anchor=button.getBoundingClientRect(),gap=6,margin=8;
 const below=innerHeight-anchor.bottom-gap-margin,above=anchor.top-gap-margin;
 panel.style.maxHeight='';
 const opensBelow=below>=panel.getBoundingClientRect().height||below>=above;
 panel.style.maxHeight=Math.max(32,Math.min(430,opensBelow?below:above))+'px';
 const {width,height}=panel.getBoundingClientRect();
 panel.style.left=Math.max(margin,Math.min(anchor.left,innerWidth-width-margin))+'px';
 panel.style.top=Math.max(margin,opensBelow?anchor.bottom+gap:anchor.top-height-gap)+'px';
}

function bindToolbarPopover(button,panel){
 workspaceToolbarPopovers.set(button,panel);
 panel.addEventListener('toggle',event=>{
  if(event.newState==='open'&&panel.matches(':popover-open'))positionToolbarPopover(button,panel);
 });
}

function addToolbarPopover(id,label){
 const button=document.createElement('button'),panel=document.createElement('div');
 button.type='button';button.id=id+'Toggle';button.className='secondary';
 button.textContent=label+' ▾';button.setAttribute('popovertarget',id);
 panel.id=id;panel.className='library-toolbar-popup';panel.setAttribute('popover','');
 panel.setAttribute('aria-label',label);
 workspaceToolbarButtons.append(button,panel);
 bindToolbarPopover(button,panel);
 return panel;
}

function makeToolbarFilter(label,control){
 const field=document.createElement('label');
 field.className='workspace-toolbar-field';field.textContent=label;
 if(control)field.append(control);
 return field;
}

function styleToolbarMenuItem(button){
 button.classList.remove('primary','secondary');
 button.classList.add('library-toolbar-action');
 return button;
}

workspaceToolbar.classList.add('workspace-toolbar');
workspaceToolbar.setAttribute('role','group');
workspaceToolbar.setAttribute('aria-label','记录工具');
workspaceToolbarButtons.className='workspace-toolbar-buttons';
workspaceToolbar.append(workspaceToolbarButtons,$('libraryControls'));
workspaceToolbar.after($('libraryBatchActions'));
$('records').before($('resultCount'));
for(const id of ['recordTools','recordFolderBar'])$(id).classList.add('workspace-toolbar-source');

const workspaceFiltersPanel=addToolbarPopover('workspaceFilters','筛选');
const workspaceSortField=makeToolbarFilter('排序',$('sort'));
const librarySortField=makeToolbarFilter('排序');
const workspaceFolderField=makeToolbarFilter('文件夹',$('recordFolderFilter'));
const workspaceWeekField=makeToolbarFilter('周次',$('meetingWeek'));
const workspaceIssueField=makeToolbarFilter('问题归属',$('issueTrackFilter'));
const workspaceWeeklyOnly=$('weeklyFilterLabel');
workspaceWeeklyOnly.classList.add('workspace-toolbar-checkbox');
workspaceFiltersPanel.append(workspaceFolderField,workspaceWeekField,workspaceWeeklyOnly,workspaceIssueField,workspaceSortField);
$('libraryFilters').insertBefore(librarySortField,$('workspaceTopics'));
for(const id of ['workWeeklyBtn','studyWeeklyBtn','currentRecordFolderActions']){
 workspaceToolbarButtons.append($(id));
}

const workspaceMorePanel=addToolbarPopover('workspaceMore','更多');
const workspaceSearchAction=styleToolbarMenuItem($('openPdfSearch'));
workspaceMorePanel.append(...['importGrokPlan','importExisting','weeklyBtn','createRecordFolder','openFolderManager'].map(id=>styleToolbarMenuItem($(id))),workspaceSearchAction);
workspaceMorePanel.addEventListener('click',event=>{
 if(event.target.closest('button')&&workspaceMorePanel.matches(':popover-open'))workspaceMorePanel.hidePopover();
});
$('libraryMore').prepend(styleToolbarMenuItem(researchEntry));
for(const id of ['libraryAdd','libraryFilters','libraryMore'])bindToolbarPopover($(id+'Toggle'),$(id));

function repositionToolbarPopovers(){
 for(const [button,panel] of workspaceToolbarPopovers){
  if(!panel.matches(':popover-open'))continue;
  const anchor=button.getBoundingClientRect();
  if(anchor.bottom<=0||anchor.top>=innerHeight)panel.hidePopover();
  else positionToolbarPopover(button,panel);
 }
}
window.addEventListener('resize',repositionToolbarPopovers);
document.addEventListener('scroll',repositionToolbarPopovers,{passive:true});

function renderToolbarFilterStatus(toggle,controls){
 const count=controls.filter(Boolean).length;
 const label=count?'筛选 · '+count:'筛选';
 toggle.textContent=label+' ▾';
 toggle.setAttribute('aria-label',count?'筛选，已应用 '+count+' 项':'筛选');
 toggle.dataset.activeFilters=String(count);
}

function renderWorkspaceToolbar(){
 const achievement=view==='pinned'&&tab==='achievements';
 workspaceToolbar.hidden=achievement;
 $('resultCount').hidden=achievement;
 const location=view+'/'+tab;
 if(workspaceToolbarView!==location){
  for(const panel of workspaceToolbarPopovers.values())if(panel.matches(':popover-open'))panel.hidePopover();
  workspaceToolbarView=location;
 }
 const archive=$('planArchiveToggle');
 if(archive&&archive.parentElement!==workspaceToolbarButtons)workspaceToolbarButtons.insertBefore(archive,$('workspaceMoreToggle'));
 const library=view==='resource',hasFolders=!$('recordFolderBar').hidden;
 workspaceToolbarButtons.hidden=library;
 workspaceFolderField.hidden=!hasFolders;
 workspaceWeekField.hidden=$('meetingWeek').hidden;
 workspaceIssueField.hidden=$('issueTrackFilter').hidden;
 for(const id of ['importExisting','createRecordFolder','openFolderManager'])$(id).hidden=!hasFolders;
 const sortField=library?librarySortField:workspaceSortField;
 if($('sort').parentElement!==sortField)sortField.append($('sort'));
 const morePanel=library?$('libraryMore'):workspaceMorePanel;
 if(workspaceSearchAction.parentElement!==morePanel)morePanel.prepend(workspaceSearchAction);
 if(library){
  renderToolbarFilterStatus($('libraryFiltersToggle'),[
   $('libraryKind').value,$('libraryStatus').value,$('readingListFilter').value,topic,$('sort').value!=='date'
  ]);
 }else{
  renderToolbarFilterStatus($('workspaceFiltersToggle'),[
   hasFolders&&$('recordFolderFilter').value,!workspaceWeekField.hidden&&$('meetingWeek').value,
   !workspaceWeeklyOnly.hidden&&$('weeklyOnly').checked,!workspaceIssueField.hidden&&$('issueTrackFilter').value,
   $('sort').value!=='date'
  ]);
 }
}

renderWorkspaceToolbar();
