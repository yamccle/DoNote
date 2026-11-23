'use strict';

const MAX_REMINDERS=200;
let reminderSaving=false;

function validReminders(items){
 return Array.isArray(items)&&items.length<=MAX_REMINDERS&&items.every(item=>item&&typeof item.id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(item.id)&&typeof item.text==='string'&&item.text.trim()&&item.text.length<=240&&typeof item.done==='boolean')&&new Set(items.map(item=>item.id)).size===items.length;
}

function renderReminders(){
 const items=activeProfile()?.reminders||[],pending=items.filter(item=>!item.done).length;
 $('reminderCount').textContent=pending+' 项待办';
 $('reminderList').innerHTML=items.length?[...items].sort((a,b)=>Number(a.done)-Number(b.done)).map(item=>
  '<li><label><input type="checkbox" data-reminder-done="'+esc(item.id)+'" '+(item.done?'checked':'')+'><span>'+esc(item.text)+'</span></label><button type="button" class="icon-button" data-reminder-remove="'+esc(item.id)+'" aria-label="删除提醒 '+esc(item.text)+'">×</button></li>'
 ).join(''):'<li class="section-note">还没有临时事项。</li>';
}

async function updateReminders(change){
 if(reminderSaving||!ensureReady()){renderReminders();return false}
 reminderSaving=true;$('reminderStatus').textContent='';
 try{
  const next=structuredClone(appState),profile=next.profiles.find(item=>item.id===next.activeId);
  profile.reminders??=[];change(profile.reminders);
  await commitState(next);return true;
 }catch(error){$('reminderStatus').textContent=error.message;return false}
 finally{reminderSaving=false;renderReminders()}
}

$('reminderForm').onsubmit=async event=>{
 event.preventDefault();const input=$('reminderInput'),text=input.value.trim();if(!text)return;
 if(await updateReminders(items=>{
  if(items.length>=MAX_REMINDERS)throw new Error('最多保留 '+MAX_REMINDERS+' 项提醒，请先清理已完成的事项。');
  items.unshift({id:crypto.randomUUID(),text,done:false});
 })){if(input.value.trim()===text)input.value='';input.focus()}
};
$('reminderList').onchange=event=>{
 const id=event.target.dataset.reminderDone,done=event.target.checked;if(!id)return;
 updateReminders(items=>{const item=items.find(entry=>entry.id===id);if(item)item.done=done});
};
$('reminderList').onclick=event=>{
 const id=event.target.closest('[data-reminder-remove]')?.dataset.reminderRemove;if(!id)return;
 updateReminders(items=>{const index=items.findIndex(item=>item.id===id);if(index>=0)items.splice(index,1)});
};
