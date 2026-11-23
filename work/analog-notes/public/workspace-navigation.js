/**
 * [INPUT]: 读取当前栏目、账户、导航历史和输入方式。
 * [OUTPUT]: 更新快捷导航，处理栏目的切换和工作台快捷键。
 * [POS]: 工作台导航层，切换记录视图后提供短暂反馈。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
const workspaceHistory=['all'];
let workspaceHistoryIndex=0;
function rememberWorkspaceView(next){
 workspaceHistory.splice(workspaceHistoryIndex+1,workspaceHistory.length,next);
 workspaceHistoryIndex=workspaceHistory.length-1;
}
function moveWorkspaceView(direction){
 for(let i=workspaceHistoryIndex+direction;i>=0&&i<workspaceHistory.length;i+=direction){
  const target=workspaceHistory[i];
  if(!Object.hasOwn(names,target)||target===view)continue;
  workspaceHistoryIndex=i;switchView(target,{fromHistory:true});return;
 }
}
$('navBack').onclick=()=>moveWorkspaceView(-1);
$('navForward').onclick=()=>moveWorkspaceView(1);
function renderWorkspaceRail(items){
 const rail=$('workspaceRail'),focused=document.activeElement?.dataset.railView;
 const profile=activeProfile(),label=profile?.name||'我的工作台';
 const signature=JSON.stringify([label,profile?.role,items.map(([id,icon,count])=>[id,icon,count,names[id]])]);
 if(rail.dataset.signature!==signature){
  hideWorkspaceRailTip();rail.replaceChildren();rail.dataset.signature=signature;
  for(const [id,icon,count] of items){
   const button=document.createElement('button');button.type='button';button.className='icon-button';button.dataset.railView=id;button.dataset.nav=id;
   button.setAttribute('aria-label',names[id]);
   bindWorkspaceRailTip(button,id,count);
   button.innerHTML=svg(icon);
   const labelNode=document.createElement('span');labelNode.className='rail-label';labelNode.textContent=names[id];
   button.append(labelNode);
   button.onclick=()=>{
    hideWorkspaceRailTip();
    if(id!==view)switchView(id);
   };
   rail.append(button);
  }
  const spacer=document.createElement('div');spacer.className='rail-spacer';rail.append(spacer);
  const avatar=document.createElement('button');avatar.type='button';avatar.className='icon-button rail-avatar';avatar.dataset.railView='account';
  const initial=document.createElement('span');initial.className='rail-initial';initial.textContent=Array.from(label)[0]||'A';
  const accountName=document.createElement('span');accountName.className='rail-label';accountName.textContent=label;
  avatar.append(initial,accountName);
  avatar.title=label+(profile?.role?' · '+profile.role:'')+'（点击切换账户）';
  avatar.setAttribute('aria-label','当前账户：'+label+'，点击切换账户');
  avatar.onclick=()=>{const users=$('usersBtn');if(users)users.click()};
  rail.append(avatar);
 }
 for(const button of rail.querySelectorAll('[data-rail-view]')){
  if(button.dataset.railView===view)button.setAttribute('aria-current','page');
  else button.removeAttribute('aria-current');
  if(button.dataset.railView===focused)button.focus({preventScroll:true});
 }
 const valid=target=>target!==view&&Object.hasOwn(names,target);
 $('navBack').disabled=!workspaceHistory.slice(0,workspaceHistoryIndex).some(valid);
 $('navForward').disabled=!workspaceHistory.slice(workspaceHistoryIndex+1).some(valid);
 publishDesktopChrome();
}
const SIDEBAR_TOPIC_LIMIT=5;
function sidebarTopicHistoryKey(){return 'donote-recent-topics/'+activeProfile()?.id}
function readSidebarTopicHistory(){
 try{const history=JSON.parse(localStorage.getItem(sidebarTopicHistoryKey())||'[]');return Array.isArray(history)?history.filter(tag=>typeof tag==='string'):[]}
 catch{return []}
}
function writeSidebarTopicHistory(history){
 try{localStorage.setItem(sidebarTopicHistoryKey(),JSON.stringify([...new Set(history)].slice(0,SIDEBAR_TOPIC_LIMIT)))}catch{}
}
function chooseSidebarTopic(tag){
 if(tag===topic){topic='';render();return}
 topic=tag;writeSidebarTopicHistory([tag,...readSidebarTopicHistory()]);render();
}
function renderSidebarTopics(){
 const tags=activeProfile()?.topics||[],recent=readSidebarTopicHistory().filter(tag=>tags.includes(tag));
 const visible=[...new Set([...recent,...tags])].slice(0,SIDEBAR_TOPIC_LIMIT);
 const list=$('sideTags'),picker=$('allSidebarTopics'),focused=document.activeElement?.dataset.topic;
 list.replaceChildren();
 for(const tag of visible){
  const button=document.createElement('button');button.type='button';button.textContent=tag;button.dataset.topic=tag;
  button.classList.toggle('active',tag===topic);button.setAttribute('aria-pressed',String(tag===topic));
  button.onclick=()=>chooseSidebarTopic(tag);list.append(button);
  if(tag===focused)button.focus({preventScroll:true});
 }
 picker.hidden=tags.length<=SIDEBAR_TOPIC_LIMIT;
 picker.replaceChildren(new Option('全部标签',''),...tags.map(tag=>new Option(tag,tag)));
 picker.onchange=()=>{const tag=picker.value;if(tag)chooseSidebarTopic(tag)};
}
let workspaceRailTipTimer;
function hideWorkspaceRailTip(){
 clearTimeout(workspaceRailTipTimer);
 const tip=$('workspaceRailTip');
 if(tip.anchor)tip.anchor.removeAttribute('aria-describedby');
 tip.anchor=null;tip.hidden=true;
}
function bindWorkspaceRailTip(button,id,count){
 button.onpointerenter=()=>showWorkspaceRailTip(button,id,count,360);
 button.onpointerleave=button.onblur=hideWorkspaceRailTip;
 button.onfocus=()=>{if(button.matches(':focus-visible'))showWorkspaceRailTip(button,id,count,0)};
}
function showWorkspaceRailTip(button,id,count,delay){
 hideWorkspaceRailTip();
 workspaceRailTipTimer=setTimeout(()=>{
  if(!button.isConnected)return;
  const tip=$('workspaceRailTip'),bounds=button.getBoundingClientRect();
  const name=document.createElement('strong');
  name.textContent=id==='all'?names[id]:id==='plan'?names[id]+' · '+count+' 项未完成':names[id]+' · 近14天新增 '+count;
  const description=navDescription(id);
  tip.replaceChildren(name);
  if(description){const line=document.createElement('span');line.textContent=description;tip.append(line)}
  tip.hidden=false;tip.style.left=Math.max(6,Math.min(bounds.right+9,innerWidth-tip.offsetWidth-6))+'px';
  tip.style.top=Math.max(6,Math.min(bounds.top+(bounds.height-tip.offsetHeight)/2,innerHeight-tip.offsetHeight-6))+'px';
  button.setAttribute('aria-describedby',tip.id);tip.anchor=button;
 },delay);
}
window.addEventListener('resize',hideWorkspaceRailTip);
const workspaceRail=$('workspaceRail');
workspaceRail.addEventListener('scroll',hideWorkspaceRailTip);
workspaceRail.addEventListener('keydown',event=>{
 if(event.altKey||event.ctrlKey||event.metaKey||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
 const buttons=[...workspaceRail.querySelectorAll('button[data-rail-view]')];
 const current=buttons.indexOf(event.target);
 if(current<0)return;
 event.preventDefault();
 const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:
  (current+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
 buttons[next].focus();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')hideWorkspaceRailTip()});

let workspaceViewMotion;
function animateWorkspaceView(){
 workspaceViewMotion?.cancel();
 const heading=$('pageTitle');
 if(!heading||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 workspaceViewMotion=heading.animate([
  {opacity:.56,translate:'0 3px'},
  {opacity:1,translate:'0 0'}
 ],{duration:150,easing:'cubic-bezier(.2, 0, 0, 1)'});
}


function publishDesktopChrome(){
 const web=window.chrome?.webview;
 if(!web)return;
 const surface=getComputedStyle(document.documentElement).getPropertyValue('--surface-soft').trim();
 const hex=/^#[0-9a-f]{6}$/i.test(surface)?surface.toLowerCase():'';
 web.postMessage('chrome:'+document.documentElement.dataset.theme+':'+encodeURIComponent($('crumb').textContent)+(hex?':'+hex:''));
}
new MutationObserver(publishDesktopChrome).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});

// Keyboard entry points: Ctrl/Cmd+F jumps to search, Ctrl/Cmd+N starts a record,
// and "/" focuses search when the user is not typing somewhere else.
document.addEventListener('keydown',event=>{
 if(event.defaultPrevented||event.altKey)return;
 const target=event.target,typing=target&&(target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(target.tagName));
 if(document.querySelector('dialog[open]')||$('desktopSettings')?.matches(':popover-open'))return;
 const primary=event.ctrlKey||event.metaKey,key=String(event.key).toLowerCase();
 if(primary&&key==='f'){event.preventDefault();const search=$('search');if(search){search.focus();search.select()}}
 else if(primary&&key==='n'){event.preventDefault();openNewWorkspaceRecord()}
 else if(!primary&&key==='/'){if(typing)return;event.preventDefault();$('search')?.focus()}
});
