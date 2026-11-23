'use strict';

const bridgeSubtitleOperations=new Set(['subtitle-read','subtitle-translate','subtitle-append']);
const subtitleCueRevision=cue=>fileDigest(new Blob([JSON.stringify([cue.start,cue.end,cue.en||'',cue.zh||''])]));

async function applyBridgeSubtitleTask(task,profileId){
 const {id:recordId,fileId}=task.record;
 const key=profileId+'/'+fileId;
 const getVideo=()=>{
  if(profileId!==appState.activeId)throw new Error('工作台已切换，请稍后重试。');
  const note=records.find(item=>item.id===recordId);
  const file=note?.attachments?.find(item=>item.id===fileId&&fileIsVideo(item));
  if(!file)throw new Error('目标视频已删除或已移动。');
  return {note,cues:note.videoSubtitles?.[fileId]||[]};
 };

 await readingSaveQueue.catch(()=>{});
 const {cues}=getVideo();
 if(task.operation==='subtitle-read'){
  const {offset,limit}=task.record;
  const page=[];
  let bytes=0;
  for(let index=offset;index<Math.min(offset+limit,cues.length);index++){
   const {start,end,en='',zh=''}=cues[index];
   const row={index,start,end,en,zh,revision:await subtitleCueRevision(cues[index])};
   bytes+=new TextEncoder().encode(JSON.stringify(row)).length;
   if(bytes>430*1024&&page.length)break;
   if(bytes>430*1024)throw new Error('单条字幕过长，无法通过助手读取。');
   page.push(row);
  }
  const next=offset+page.length;
  return {recordId,subtitleResult:{recordId,fileId,total:cues.length,offset,
   nextOffset:next<cues.length?next:null,cues:page}};
 }

 const work=async()=>{
  const existing=activeProfile().aiApplied?.[task.id];
  if(existing)return existing.recordId;
  const job=videoSubtitleJobs.get(key);
  const editing=()=>document.activeElement?.matches('.video-subtitle-texts textarea')&&
   readingSession?.profileId===profileId&&readingSession?.file.id===fileId;
  if(job?.kind||editing())throw new Error('此视频正在编辑字幕或生成字幕，请稍后同步。');
  const before=getVideo().cues;
  const after=structuredClone(before);
  if(task.operation==='subtitle-translate'){
   for(const row of task.record.cues){
    const cue=after[row.index];
    if(!cue||await subtitleCueRevision(cue)!==row.revision)
     throw new Error('字幕已变化，请助手重新读取后提交。');
    if(!task.record.replaceExisting&&cue.zh?.trim())
     throw new Error('该行已有译文，请保留或按用户要求明确替换。');
    cue.zh=row.zh;
   }
  }else if(task.operation==='subtitle-append'){
   if(after.length!==task.record.expectedCount)throw new Error('字幕行数已变化，请重新读取。');
   for(const cue of task.record.cues){
    if(cue.start<(after.at(-1)?.end??0))throw new Error('新字幕必须按时间顺序追加，且不能重叠。');
    after.push(cue);
   }
  }
  if((await bridgeApi('/v1/tasks/'+task.id)).state!=='pending')return null;
  const latest=getVideo();
  if(workspaceEditorActive()||videoSubtitleJobs.get(key)?.kind||editing())throw new Error('正在编辑，请稍后同步。');
  if(JSON.stringify(latest.cues)!==JSON.stringify(before))
   throw new Error('字幕已变化，请助手重新读取后提交。');
  const next=structuredClone(appState),profile=next.profiles.find(item=>item.id===profileId);
  const saved=profile.records.find(item=>item.id===recordId);
  saved.videoSubtitles??={};saved.videoSubtitles[fileId]=after;
  profile.aiApplied??={};profile.aiApplied[task.id]={recordId,at:new Date().toISOString()};
  await commitState(next);
  const view=videoSubtitleJobs.get(key);
  if(view){
   view.cues=structuredClone(after);
   videoSubtitleJobStatus(view,'外部助手已写入字幕。',100);
  }
  return recordId;
 };
 const operation=readingSaveQueue.catch(()=>{}).then(work);
 readingSaveQueue=operation.catch(()=>{});
 return operation;
}
