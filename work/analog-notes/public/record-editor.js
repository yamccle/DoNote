/**
 * [INPUT]: 读取当前栏目、记录类型、已有记录和附件。
 * [OUTPUT]: 选择记录类型，打开、保存与关闭记录编辑器。
 * [POS]: 连接工作台的新建入口、编辑表单与草稿存储。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const editorDialog=$('editor');
const recordForm=$('noteForm');
const recordTypePicker=$('recordTypePicker');
const recordTypeChoices=$('recordTypeChoices');
const referenceRecordType=type=>type==='paper'||type==='resource';
let editorRecordType, defaultRecordBody, planFieldsInitialized;
const editorTypeFields=new Map();
const editorFolders=new Map();

function showRecordTypePicker(){
 const categories=[...categoryList(),{id:'resource',icon:'navLibrary'}];
 recordTypeChoices.replaceChildren(...categories.map(category=>{
  const button=document.createElement('button');
  button.type='button';
  button.className='secondary';
  button.dataset.recordType=category.id;
  const icon=document.createElement('span');
  icon.setAttribute('aria-hidden','true');
  icon.innerHTML=svg(categoryIcon(category));
  button.append(icon,recordTypeName(category.id));
  return button;
 }));
 recordTypePicker.showModal();
 recordTypeChoices.firstElementChild.focus({preventScroll:true});
}

function openNewWorkspaceRecord(preferredType){
 if(!ready){toast('记录库未连接，请先连接或登录。');return}
 if(editorDialog.open||resumeWorkspaceDialog(editorDialog)||recordTypePicker.open)return;
 const section=activeCategory(view)||view==='resource'?view:tab;
 const type=preferredType??(section==='resource'&&activeCategory('paper')?'paper':section);
 if(Object.hasOwn(templates,type))openEditor(type);
 else showRecordTypePicker();
}

recordTypeChoices.onclick=event=>{
 const button=event.target.closest('button[data-record-type]');
 if(!button)return;
 recordTypePicker.close();
 openEditor(button.dataset.recordType);
};

function updateRecordTypeFields(type,{status,journalKind}={}){
 const statuses=statusOptions[type];
 $('status').replaceChildren(...statuses.map(value=>new Option(value,value)));
 if(statuses.includes(status))$('status').value=status;
 $('referenceFields').hidden=!referenceRecordType(type);
 $('url').disabled=!referenceRecordType(type);
 updateLibraryEditorType();
 if(journalKind)$('journalKind').value=journalKind;
}

function openEditor(type='paper',note=null){
 if(!ready){toast('记录库未连接，请先连接或登录。');return}
 discardMinimizedWorkspaceDialog('editor');
 if(!statusOptions[type])type=defaultRecordType();
 editing=note?.id||null;
 recordForm.reset();
 for(const id of ['editorMetadata','editorResources','editorFormatting'])$(id).open=false;
 $('type').value=note?.type||type;
 $('type').disabled=!!note?.webArticle;
 editorRecordType=$('type').value;
 planFieldsInitialized=editorRecordType==='plan';
 editorTypeFields.clear();
 editorFolders.clear();
 updateRecordTypeFields(editorRecordType,{status:note?.status});
 setupPlanFields(editorRecordType,note);
 const scope=folderScope(editorRecordType);
 setEditorFolder(editorRecordType,note?note.folderId:scope===folderScope(view)?activeFolderFilter(scope):'');
 $('date').value=note?.date||today();
 $('title').value=note?.title||'';
 $('reference').value=note?.reference||'';
 $('url').value=note?.url||'';
 $('tagsInput').value=note?.tags.join(', ')||topic;
 $('body').value=note?.body??templates[editorRecordType];
 $('pinned').checked=!!note?.pinned;
 resetAttachments(note);
 loadLibraryEditorFields(note);
 loadRichBody(note);
 defaultRecordBody=note?null:getRichHtml();
 $('formMessage').textContent='';
 $('editorTitle').textContent=note?'编辑记录':'新建记录';
 setEditorMode(false);
 editorDialog.showModal();
 editorDialog.querySelector('.editor-body').scrollTop=0;
 $('title').focus({preventScroll:true});
 beginDraftSession();
}

async function saveRecordEditor(event){
 event.preventDefault();
 if(busy)return;
 busy=true;
 $('saveBtn').disabled=true;
 try{
  syncRichBody();
  const type=$('type').value;
  const previous=records.find(record=>record.id===editing);
  const hasReference=referenceRecordType(type);
  const note={
   id:editing||crypto.randomUUID(),
   type,
   title:$('title').value.trim(),
   date:$('date').value,
   status:$('status').value,
   body:$('body').value,
   bodyHtml:getRichHtml(),
   tags:[...new Set($('tagsInput').value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean))],
   reference:hasReference?$('reference').value:previous?.reference||'',
   url:hasReference?$('url').value:previous?.url||'',
   pinned:$('pinned').checked,
   attachments:draftAttachments,
   author:$('author').value.trim(),
   relatedResources:[...selectedResourceLinks],
   journalKind:$('journalKind').value||'daily'
  };
  if(note.type==='plan'){
   note.planStart=$('planStart').value;
   note.planEnd=$('planEnd').value;
   note.planTrack=$('planTrack').value;
   note.date=note.planStart;
   if(!validPlanDates(note.planStart,note.planEnd))throw new Error('请填写有效日期，结束日期须在开始日期当日或之后。');
  }
  const folderId=$('recordFolder').value;
  if(folderId)note.folderId=folderId;
  if(note.type==='issue')note.issueTrack=$('issueTrack').value;
  if(hasReference&&note.url&&!/^https?:\/\//i.test(note.url)){
   $('editorMetadata').open=true;
   $('url').focus();
   throw new Error('文献链接须以 http:// 或 https:// 开头。');
  }
  if(weeklyJournal(previous||{})||weeklyJournal(note)){
   note.tags=note.tags.filter(tag=>!/^\d{4}-W\d{2}$/.test(tag)&&tag!==WEEKLY_LOGS[previous?.journalKind]?.tag);
  }
  if(weeklyJournal(note)){
   const format=WEEKLY_LOGS[note.journalKind],week=getWeekKey(note.date);
   note.tags=[...new Set([...note.tags,format.tag,week])];
   if(!note.title||autoWeeklyTitle(note.title))note.title=week+' '+format.label;
  }
  validateInlineReferences(note);
  if(!validate(note))throw new Error('请检查标题、日期、标签或文献链接。');
  const deletions=(previous?.attachments||[])
   .filter(attachment=>!draftAttachments.some(draft=>draft.id===attachment.id))
   .map(attachment=>fileKey(appState.activeId,attachment.id));
  const writes=[...stagedFiles].map(([id,blob])=>({key:fileKey(appState.activeId,id),blob}));
  await put(note,writes,deletions);
  await clearSavedDraft();
  editorDialog.close();
  stagedFiles.clear();
  render();
  toast('记录与附件已保存');
 }catch(error){
  $('formMessage').textContent=error.message;
 }finally{
  busy=false;
  $('saveBtn').disabled=false;
 }
}

async function closeRecordEditor(){
 if(busy)return;
 if(!await flushEditorDraft()){toast('草稿尚未保存，请先保存记录。');return}
 if(!busy&&editorDialog.open)editorDialog.close();
}

$('type').onchange=()=>{
 const type=$('type').value;
 editorTypeFields.set(editorRecordType,{status:$('status').value,journalKind:$('journalKind').value});
 editorFolders.set(folderScope(editorRecordType),$('recordFolder').value);
 updateRecordTypeFields(type,editorTypeFields.get(type));
 setupPlanFields(type,null,{keepValues:planFieldsInitialized});
 if(type==='plan')planFieldsInitialized=true;
 setEditorFolder(type,editorFolders.get(folderScope(type)));
 editorRecordType=type;
 if(defaultRecordBody!==null&&getRichHtml()===defaultRecordBody){
  $('body').value=templates[type];
  loadRichBody(null);
  defaultRecordBody=getRichHtml();
 }else defaultRecordBody=null;
};
$('newBtn').onclick=$('quickStartNewRecord').onclick=()=>openNewWorkspaceRecord();
editorDialog.querySelectorAll('[data-close="editor"]').forEach(button=>{
 button.onclick=closeRecordEditor;
});
recordForm.onsubmit=saveRecordEditor;
recordForm.addEventListener('invalid',event=>{
 const details=event.target.closest('details');
 if(details)details.open=true;
},true);
recordForm.addEventListener('input',event=>{
 if(!richEditor.contains(event.target))queueDraft();
});
recordForm.addEventListener('change',queueDraft);
editorDialog.addEventListener('cancel',event=>{
 event.preventDefault();
 event.stopPropagation();
 void closeRecordEditor();
});
