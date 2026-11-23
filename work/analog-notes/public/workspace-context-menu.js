/**
 * [INPUT]: 读取工作台和资料的当前状态。
 * [OUTPUT]: 提供当前对象的右键操作。
 * [POS]: 工作台情境菜单，复用栏目导航提供的新建入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
let workspaceMenu=null,workspaceMenuFocus=null,workspaceMenuBusy=false;
function closeWorkspaceMenu(restore=false){
 if(workspaceMenu){workspaceMenu.hidden=true;workspaceMenu.replaceChildren()}
 if(restore&&workspaceMenuFocus?.isConnected)workspaceMenuFocus.focus({preventScroll:true});
 workspaceMenuFocus=null;
}
function showWorkspaceMenu(event,items){
 event.preventDefault();hideFolderContextMenu();closeWorkspaceMenu();
 if(!workspaceMenu){workspaceMenu=document.createElement('div');workspaceMenu.id='workspaceContextMenu';workspaceMenu.className='context-menu';workspaceMenu.setAttribute('role','menu')}
 const host=event.target.closest('dialog[open]')||document.body;host.append(workspaceMenu);
 workspaceMenuFocus=event.target.closest('[tabindex],button,input')||document.activeElement;
 const profile=appState.activeId;
 for(const item of items){
  if(!item){const sep=document.createElement('span');sep.className='context-menu-sep';sep.setAttribute('role','separator');workspaceMenu.append(sep);continue}
  const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=item.label;
  if(item.danger)button.classList.add('context-menu-danger');
  button.onclick=async e=>{e.stopPropagation();if(workspaceMenuBusy)return;closeWorkspaceMenu();if(profile!==appState.activeId)return;workspaceMenuBusy=true;try{await item.run()}catch(error){toast(error.message||'操作失败，请重试。')}finally{workspaceMenuBusy=false}};
  workspaceMenu.append(button);
 }
 workspaceMenu.hidden=false;workspaceMenu.style.maxHeight='calc(100vh - 16px)';workspaceMenu.style.overflowY='auto';
 const rect=workspaceMenu.getBoundingClientRect(),anchor=event.target.getBoundingClientRect();
 const x=event.clientX||anchor.left+12,y=event.clientY||anchor.bottom;
 workspaceMenu.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+'px';workspaceMenu.style.top=Math.max(8,Math.min(y,innerHeight-rect.height-8))+'px';
 workspaceMenu.querySelector('button')?.focus({preventScroll:true});
}
function contextRecordTarget(note){
 const ids=librarySelectionMode&&selectedLibraryIds.has(note.id)?[...selectedLibraryIds]:[note.id];
 return {profile:appState.activeId,versions:new Map(ids.map(id=>[id,records.find(n=>n.id===id)?.updatedAt]))};
}
function checkedContextRecords(target){
 if(target.profile!==appState.activeId)throw new Error('用户已切换，请重新打开菜单。');
 const notes=[...target.versions].map(([id,version])=>{const n=records.find(n=>n.id===id);if(!n||n.updatedAt!==version)throw new Error('记录已变化，请重新打开菜单。');return n});
 return notes;
}
async function changeContextRecords(target,change,{logCompletedPlans=false}={}){
 checkedContextRecords(target);
 const next=structuredClone(appState),profile=next.profiles.find(p=>p.id===target.profile),now=new Date().toISOString();
 const notes=profile.records.filter(note=>target.versions.has(note.id));
 let logs=0;
 for(const note of notes){
  change(note);note.updatedAt=now;
  if(!validate(note))throw new Error('修改无效，请检查记录。');
  if(logCompletedPlans&&addCompletedPlanLog(profile,note))logs++;
 }
 await commitState(next);render();if($('detail').open&&target.versions.has(current))showDetail(current);
 return logs;
}
async function moveContextRecords(target){
 const notes=checkedContextRecords(target),scope=folderScope(notes[0].type);
 if(notes.some(n=>folderScope(n.type)!==scope))throw new Error('请选择同一栏目的记录。');
 const dialog=document.createElement('dialog');dialog.className='compact-dialog';dialog.setAttribute('aria-label','移动记录');
 dialog.innerHTML='<div class="modalhead"><h2>移动到文件夹</h2></div><div class="modalbody"><label>目标文件夹<select aria-label="目标文件夹"><option value="">未归档</option>'+recordFolderOptions(scope)+'</select></label><p class="tiny">移动 '+notes.length+' 条记录，保留原文件。</p></div><div class="modalfoot"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="primary" data-save>移动</button></div>';
 dialog.querySelector('select').value=notes[0].folderId||'';
 dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
 dialog.querySelector('[data-save]').onclick=async e=>{e.target.disabled=true;try{const id=dialog.querySelector('select').value;if(id&&!scopedFolderId(notes[0].type,id))throw new Error('文件夹已变化。');await changeContextRecords(target,n=>{if(id)n.folderId=id;else delete n.folderId});dialog.close();toast('已移动 '+notes.length+' 条记录')}catch(error){toast(error.message)}finally{e.target.disabled=false}};
 dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
}
function recordContextItems(note){
 const target=contextRecordTarget(note),count=target.versions.size,many=count>1,label=many?'所选 '+count+' 条记录':note.title;
 const one=()=>checkedContextRecords(target)[0];
 const items=many?[]:[{label:note.type==='resource'?'打开资料':'查看详情',run:()=>note.type==='resource'?openResource(one().id):showDetail(one().id)},
  {label:'编辑记录',run:()=>{const n=one();if($('detail').open)$('detail').close();openEditor(n.type,n)}}];
 const statuses=note.type==='resource'?['待读','在读','已读']:(statusOptions[note.type]||[]);
 for(const status of statuses)items.push({label:(many?'全部标记为':note.status===status?'✓ 当前状态：':'标记为')+status,run:async()=>{
  const logs=await changeContextRecords(target,n=>{n.status=status},{logCompletedPlans:status==='已完成'});
  toast(logs?'已标记为'+status+'，并写入 '+logs+' 条日志。':'已标记为'+status);
 }});
 items.push(null,{label:note.pinned?'取消置顶收藏':'置顶收藏',run:()=>changeContextRecords(target,n=>{n.pinned=!note.pinned})},{label:'移动到文件夹…',run:()=>moveContextRecords(target)});
 if(!many&&libraryNoteType(note))items.push({label:'补全文献信息 / 翻译',run:()=>openLiteratureDialog(one())});
 if(libraryNoteType(note))items.push({label:'批量整理 / 标签 / 阅读清单…',run:()=>{checkedContextRecords(target);selectedLibraryIds.clear();for(const id of target.versions.keys())selectedLibraryIds.add(id);librarySelectionMode=true;render();openLibraryOrganization()}});
 if(!many)items.push({label:'复制标题',run:()=>navigator.clipboard.writeText(one().title)});
 items.push(null,{label:many?'将所选记录移到回收站':'移到回收站',danger:true,run:async()=>{checkedContextRecords(target);if(!await confirmWorkspaceDeletion('将「'+label+'」移到回收站？可在 30 天内恢复。'))return;checkedContextRecords(target);await removeWorkspaceRecords(new Set(target.versions.keys()));if($('detail').open&&target.versions.has(current))$('detail').close();render();toast('已移到回收站')}});
 return items;
}
document.addEventListener('contextmenu',event=>{
 if(event.defaultPrevented){closeWorkspaceMenu();return}
 const el=event.target instanceof Element?event.target:event.target.parentElement;
 if(!el||!ready)return;
 if(el.closest('input,textarea,[contenteditable="true"],select')){closeWorkspaceMenu();return}
 const selection=getSelection()?.toString().trim();
 if(selection&&el.closest('.rich-content,.detail-body,.reader-content')){showWorkspaceMenu(event,[{label:'复制所选文字',run:()=>navigator.clipboard.writeText(selection)}]);return}
 const fileRow=el.closest('#detailFiles .file-row');
 if(fileRow){const id=fileRow.querySelector('[data-download-attachment]')?.dataset.downloadAttachment,note=records.find(n=>n.id===current),file=note?.attachments?.find(a=>a.id===id);if(file)showWorkspaceMenu(event,[{label:'预览 / 打开附件',run:()=>openAttachment(file)},{label:'下载原文件',run:async()=>downloadBlob(file.name,await readBlob(file.id))},{label:'复制文件名',run:()=>navigator.clipboard.writeText(file.name)},{label:'编辑附件…',run:()=>{$('detail').close();openEditor(note.type,note)}}]);return}
 const card=el.closest('#records .card[data-id],[data-widget-plan],[data-journal-plan],#pending [data-id]');
 const id=card?.dataset.id||card?.dataset.widgetPlan||card?.dataset.journalPlan;
 const note=records.find(n=>n.id===(id||(el.closest('#detailContent')?current:null)));
 if(note){showWorkspaceMenu(event,recordContextItems(note));return}
 const reminder=el.closest('#reminderList li')?.querySelector('[data-reminder-done]');
 if(reminder){const id=reminder.dataset.reminderDone,item=activeProfile().reminders?.find(r=>r.id===id);if(item)showWorkspaceMenu(event,[{label:item.done?'恢复待办':'标记已完成',run:()=>updateReminders(items=>{const r=items.find(r=>r.id===id);if(r)r.done=!item.done})},{label:'删除提醒',danger:true,run:()=>updateReminders(items=>{const i=items.findIndex(r=>r.id===id);if(i>=0)items.splice(i,1)})}]);return}
 const trash=el.closest('[data-trash-id]');
 if(trash){showWorkspaceMenu(event,[{label:'恢复记录',run:async()=>{await restoreTrashRecords([trash.dataset.trashId]);renderTrashDialog()}},{label:'彻底删除…',danger:true,run:async()=>{if(await confirmWorkspaceDeletion('彻底删除此记录和独占附件？此操作无法恢复。')){await deleteTrashPermanently([trash.dataset.trashId]);renderTrashDialog()}}}]);return}
 // Reader selections have their own translation/annotation menu. Blank reader areas should not show browser printing tools.
 if(el.closest('#reader')){event.preventDefault();closeWorkspaceMenu();return}
 const nav=el.closest('[data-nav]');
 if(nav){const type=nav.dataset.nav;showWorkspaceMenu(event,[{label:'打开'+(names[type]||'栏目'),run:()=>nav.click()},...(type in templates?[{label:'在此栏目新建记录',run:()=>openEditor(type)}]:[])]);return}
 if(el.closest('.dashboard-card,#remindersWidget,#quickStartWidget')){showWorkspaceMenu(event,[{label:'自定义总览组件…',run:()=>$('dashboardCustomize').click()}]);return}
 const link=el.closest('a[href]');
 if(link){showWorkspaceMenu(event,[{label:'打开链接',run:()=>link.click()},{label:'复制链接',run:()=>navigator.clipboard.writeText(link.href)}]);return}
 if(el.closest('main')&&!el.closest('dialog'))showWorkspaceMenu(event,[{label:'新建记录',run:openNewWorkspaceRecord},{label:'刷新当前列表',run:()=>render()},{label:'打开回收站',run:()=>openTrashDialog()}]);
 else {event.preventDefault();closeWorkspaceMenu()}
});
document.addEventListener('pointerdown',event=>{if(workspaceMenu&&!workspaceMenu.contains(event.target))closeWorkspaceMenu()},true);
document.addEventListener('keydown',event=>{
 if(!workspaceMenu||workspaceMenu.hidden)return;
 const buttons=[...workspaceMenu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeWorkspaceMenu(true)}
 else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus()}
 else if(event.key==='Tab')closeWorkspaceMenu();
},true);
window.addEventListener('scroll',event=>{if(!(event.target instanceof Node)||!workspaceMenu?.contains(event.target))closeWorkspaceMenu()},true);
window.addEventListener('resize',()=>closeWorkspaceMenu());
window.addEventListener('blur',()=>closeWorkspaceMenu());
