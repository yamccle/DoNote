'use strict';
// Native text tracks remain visible in the video element's own fullscreen mode.
function installVideoSubtitleOverlay(root,video,getCues,signal){
 const list=root.querySelector('.video-subtitles-list');
 if(!list||!video.addTextTrack||typeof VTTCue==='undefined')return;
 const key='donote.video.subtitle.appearance.v1';
 let stored={};try{stored=JSON.parse(localStorage.getItem(key)||'{}')||{}}catch{}
 const validFont=new Set(['sans-serif','serif','monospace','Arial','Microsoft YaHei']);
 const settings={size:Math.max(12,Math.min(64,Number(stored.size)||24)),opacity:Math.max(20,Math.min(100,Number(stored.opacity)||100)),font:validFont.has(stored.font)?stored.font:'sans-serif',color:/^#[0-9a-f]{6}$/i.test(stored.color)?stored.color:'#ffffff'};
 const style=document.createElement('style');document.head.append(style);
 const track=video.addTextTrack('subtitles','DoNote 双语字幕','zh');track.mode='hidden';
 function applySettings(){
  try{const latest=JSON.parse(localStorage.getItem(key)||'{}')||{};if(Number.isFinite(Number(latest.size)))settings.size=Math.max(12,Math.min(64,Number(latest.size)));if(Number.isFinite(Number(latest.opacity)))settings.opacity=Math.max(20,Math.min(100,Number(latest.opacity)));if(validFont.has(latest.font))settings.font=latest.font;if(/^#[0-9a-f]{6}$/i.test(latest.color))settings.color=latest.color}catch{}
  const hex=settings.color,r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16),a=settings.opacity/100;
  const family=settings.font==='Microsoft YaHei'?'"Microsoft YaHei"':settings.font;
  style.textContent=`#libraryVideo::cue{font-size:${settings.size}px;color:rgba(${r},${g},${b},${a});font-family:${family};background-color:rgba(0,0,0,${(a*.65).toFixed(2)});text-shadow:0 1px 3px rgba(0,0,0,${a})}`;
  try{localStorage.setItem(key,JSON.stringify(settings))}catch{}
 }
 const mode=root.querySelector('.video-learning-controls select');
 const escape=value=>String(value||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const captionCues=new Map();
 function updateCaption(index, cue, display){
  const start=Number(cue.start),end=Number(cue.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)return;
  const parts=display==='en'?[cue.en]:display==='zh'?[cue.zh]:[cue.en,cue.zh];
  const text=parts.filter(value=>typeof value==='string'&&value.trim()).map(escape).join('\n');
  const existing=captionCues.get(index);
  if(existing){
   if(text){existing.text=text;return}
   track.removeCue(existing);captionCues.delete(index);
  }
  if(text){
   const caption=new VTTCue(start,end,text);
   track.addCue(caption);captionCues.set(index,caption);
  }
 }
 function updateTrack(changed){
  const display=mode?.value||'both';
  if(changed&&display!=='none'){
   const cues=getCues();
   for(const index of changed)updateCaption(index,cues[index],display);
   return;
  }
  track.mode='hidden';
  for(const cue of captionCues.values())track.removeCue(cue);
  captionCues.clear();
  if(display!=='none')getCues().forEach((cue,index)=>updateCaption(index,cue,display));
  track.mode=display==='none'?'disabled':'showing';
 }
 mode?.addEventListener('change',()=>updateTrack(),{signal});
 list.addEventListener('donote-video-cues-changed',event=>updateTrack(event.detail),{signal});
 window.addEventListener('donote-video-caption-change',applySettings,{signal});
 signal.addEventListener('abort',()=>{track.mode='disabled';style.remove()},{once:true});
 applySettings();updateTrack();
}
