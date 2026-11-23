/**
 * [INPUT]: 读取播放器进度、字幕行和用户选择。
 * [OUTPUT]: 提供字幕显示模式、搜索和相邻句跳转。
 * [POS]: 字幕面板工具条，独立于识别任务。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
// Learning controls are independent of the speech-recognition backend.
function installVideoLearningControls(root,video,getCues,signal){
 const current=root.querySelector('.video-subtitles-current'),list=root.querySelector('.video-subtitles-list');
 if(!current||!list)return;
 const controls=document.createElement('div');controls.className='video-learning-controls';
 controls.innerHTML='<label>字幕显示 <select aria-label="字幕显示"><option value="both">中英双语</option><option value="en">仅英文</option><option value="zh">仅中文</option><option value="none">隐藏字幕</option></select></label><button type="button" data-learning="previous">上一句</button><button type="button" data-learning="next">下一句</button><label class="video-learning-search">搜索字幕 <input type="search" placeholder="搜索英文或中文" aria-label="搜索字幕"></label><span class="video-learning-count" role="status"></span>';
 (current.closest('.video-subtitles-playhead')||current).before(controls);
 const mode=controls.querySelector('select'),search=controls.querySelector('input'),count=controls.querySelector('.video-learning-count');
 function display(){
  const children=current.children;
  if(children[0])children[0].hidden=mode.value==='zh'||mode.value==='none';
  if(children[1])children[1].hidden=mode.value==='en'||mode.value==='none';
  current.hidden=mode.value==='none';
 }
 function filter(){
  const needle=search.value.trim().toLocaleLowerCase();let matches=0,total=0;
  for(const row of list.querySelectorAll('.video-subtitle-row')){
   const matchesSearch=!needle||Array.from(row.querySelectorAll('textarea')).some(el=>el.value.toLocaleLowerCase().includes(needle));
   row.hidden=!matchesSearch;total++;if(matchesSearch)matches++;
  }
  count.textContent=needle?`找到 ${matches} / ${total} 条`:'';
 }
 function seek(direction){
  const cues=getCues().filter(cue=>Number.isFinite(cue.start)).slice().sort((a,b)=>a.start-b.start);
  if(!cues.length)return;
  const pos=video.currentTime;
  const found=direction<0?[...cues].reverse().find(c=>c.start<pos-0.15):cues.find(c=>c.start>pos+0.15);
  if(found)video.currentTime=found.start;
 }
 controls.querySelector('[data-learning="previous"]').addEventListener('click',()=>seek(-1),{signal});
 controls.querySelector('[data-learning="next"]').addEventListener('click',()=>seek(1),{signal});
 mode.addEventListener('change',display,{signal});search.addEventListener('input',filter,{signal});
 list.addEventListener('input',filter,{signal});
 list.addEventListener('donote-video-cues-changed',()=>{if(search.value.trim())filter()},{signal});
 const observer=new MutationObserver(display);
 observer.observe(current,{childList:true});
 signal.addEventListener('abort',()=>observer.disconnect(),{once:true});display();filter();
}
