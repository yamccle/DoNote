/**
 * [INPUT]: 读取当前栏目、已有记录、附件和草稿。
 * [OUTPUT]: 打开、保存与关闭记录编辑器。
 * [POS]: 连接编辑表单、记录存储与草稿存储。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const editorDialog=$('editor');
const recordForm=$('noteForm');

function updateRecordTypeFields(type,status){
 const statuses=statusOptions[type];
 $('status').replaceChildren(...statuses.map(value=>new Option(value,value)));
 if(statuses.includes(status))$('status').value=status;
 $('referenceFields').style.display=['paper','resource'].includes(type)?'block':'none';
 updateLibraryEditorType();
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
 const recordType=$('type').value;
 updateRecordTypeFields(recordType,note?.status);
 setupPlanFields(recordType,note);
 const scope=folderScope(type);
 setEditorFolder(recordType,note?note.folderId:scope===folderScope(view)?activeFolderFilter(scope):'');
 $('date').value=note?.date||today();
 $('title').value=note?.title||'';
 $('reference').value=note?.reference||'';
 $('url').value=note?.url||'';
 $('tagsInput').value=note?.tags.join(', ')||topic;
 $('body').value=note?.body??templates[type];
 $('pinned').checked=!!note?.pinned;
 resetAttachments(note);
 loadLibraryEditorFields(note);
 loadRichBody(note);
 $('formMessage').textContent='';
 $('editorTitle').textContent=note?'编辑记录':'新建'+names[type];
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
  const note={
   id:editing||crypto.randomUUID(),
   type:$('type').value,
   title:$('title').value.trim(),
   date:$('date').value,
   status:$('status').value,
   body:$('body').value,
   bodyHtml:getRichHtml(),
   tags:[...new Set($('tagsInput').value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean))],
   reference:$('reference').value,
   url:$('url').value,
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
  const previous=records.find(record=>record.id===editing);
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
 updateRecordTypeFields(type);
 setupPlanFields(type,null);
 setEditorFolder(type,$('recordFolder').value);
 $('editorTitle').textContent=editing?'编辑记录':'新建'+names[type];
 if(!$('body').value||Object.values(templates).includes($('body').value)){
  $('body').value=templates[type];
  loadRichBody(null);
 }
};
$('newBtn').onclick=openNewWorkspaceRecord;
document.querySelectorAll('[data-new]').forEach(button=>{
 button.onclick=()=>openEditor(button.dataset.new);
});
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
 if(busy){event.stopPropagation();return}
 void flushEditorDraft();
});
