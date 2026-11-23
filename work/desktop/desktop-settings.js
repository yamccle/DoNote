/**
 * [INPUT]: 读取桌面设置控件、宿主消息和当前浮窗。
 * [OUTPUT]: 在鼠标和键盘操作下切换设置层级，并传递设置命令。
 * [POS]: 桌面设置控制器，设置面板可在阅读预览上方打开。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
 const panel=document.getElementById('desktopSettings'),header=panel.querySelector('header'),title=document.getElementById('desktopSettingsTitle');
 const get=selector=>panel.querySelector(selector),root=document.createElement('div'),pages=new Map();
 root.className='settings-root';
 const groups=[
  ['appearance','外观与阅读',['.desktop-palette-row:has(#desktopPalette)','.desktop-palette-row:has(#desktopThemeMode)','#desktopSplashToggle','#desktopPdfInvertToggle','[data-control="openVideoCaptionSettings"]']],
  ['workspace','用户与栏目',['[data-control="usersBtn"]','[data-control="categoriesBtn"]']],
  ['services','翻译与模型',['[data-control="openTranslationSettings"]','[data-control="openTranslateLangDialog"]','[data-control="openSpeechModelSettings"]','[data-control="openAiModelSettings"]','[data-control="openAiManager"]']],
  ['storage','资料与备份',['[data-control="backupBtn"]','[data-control="openTrash"]','[data-command="view-data-folder"]','[data-command="choose-data-folder"]']],
  ['about','更新与关于',['[data-command="install-update"]','[data-control="aboutDoNote"]']]
 ];
 const exit=get('[data-command="exit-desktop"]'),footer=document.createElement('footer');footer.append(exit);
 for(const [id,label,selectors]of groups){
  const page=document.createElement('section');page.id='desktopSettingsPage-'+id;page.dataset.settingsPage=id;page.className='desktop-settings-submenu';page.setAttribute('popover','manual');page.setAttribute('aria-label',label);
  const back=document.createElement('button');
  back.type='button';back.className='desktop-settings-submenu-back';back.textContent='‹ 返回设置';
  back.setAttribute('aria-label','返回设置');back.onclick=()=>closeSubmenu(true);
  page.append(back);
  for(const selector of selectors){const node=get(selector);if(node)page.append(node)}
  pages.set(id,page);const button=document.createElement('button');button.type='button';button.dataset.settingsGroup=id;button.setAttribute('aria-controls',page.id);button.setAttribute('aria-expanded','false');button.innerHTML='<span>'+label+'</span><span aria-hidden="true">›</span>';root.append(button);
 }
 panel.replaceChildren(header,root,...pages.values(),footer);
 let activeId='',hoverTimer,leaveTimer;
 const itemsIn=page=>[...page.querySelectorAll('button:enabled,select:enabled')].filter(item=>item.getClientRects().length);
 const clearTimers=()=>{clearTimeout(hoverTimer);clearTimeout(leaveTimer)};
 const closeSubmenu=(focus=false)=>{
  clearTimers();const previous=activeId;activeId='';
  delete panel.dataset.submenuSide;
  for(const page of pages.values())if(page.matches(':popover-open'))page.hidePopover();
  root.querySelectorAll('[data-settings-group]').forEach(button=>button.setAttribute('aria-expanded','false'));
  if(focus&&previous)root.querySelector('[data-settings-group="'+previous+'"]')?.focus({preventScroll:true});
 };
 const placeSubmenu=()=>{
  const page=pages.get(activeId),button=root.querySelector('[data-settings-group="'+activeId+'"]');
  if(!page||!button||!page.matches(':popover-open'))return;
  const mainRect=panel.getBoundingClientRect(),rowRect=button.getBoundingClientRect();
  const gap=6,edge=8;
  const width=page.getBoundingClientRect().width;
  let x=mainRect.right+gap,side='right';
  if(x+width>innerWidth-edge){x=mainRect.left-width-gap;side='left'}
  if(x<edge){x=Math.min(mainRect.left,innerWidth-width-edge);side='stack'}
  x=Math.max(edge,x);
  panel.dataset.submenuSide=page.dataset.side=side;
  page.style.left=x+'px';
  const height=page.getBoundingClientRect().height;
  page.style.top=Math.max(edge,Math.min(side==='stack'?mainRect.top:rowRect.top-5,innerHeight-height-edge))+'px';
 };
 const showSubmenu=(id,focus=false)=>{
  clearTimers();if(!panel.matches(':popover-open'))return;
  const page=pages.get(id);if(!page)return;
  if(activeId!==id)closeSubmenu();activeId=id;
  const button=root.querySelector('[data-settings-group="'+id+'"]');button.setAttribute('aria-expanded','true');
  if(!page.matches(':popover-open'))page.showPopover();
  placeSubmenu();if(focus)itemsIn(page)[0]?.focus({preventScroll:true});
 };
 const scheduleLeave=()=>{
  clearTimeout(leaveTimer);
  leaveTimer=setTimeout(()=>{
   const page=pages.get(activeId);
   if(!panel.matches(':hover')&&!page?.matches(':hover')&&!page?.contains(document.activeElement))closeSubmenu();
  },350);
 };
 panel.addEventListener('click',event=>{
  const group=event.target.closest('[data-settings-group]');
  if(group){event.stopImmediatePropagation();showSubmenu(group.dataset.settingsGroup,true)}
 });
 root.querySelectorAll('[data-settings-group]').forEach(button=>{
  button.addEventListener('pointerenter',event=>{
   clearTimers();
   if(event.pointerType==='mouse'&&innerWidth>=690)hoverTimer=setTimeout(()=>showSubmenu(button.dataset.settingsGroup),160);
  });
  button.addEventListener('keydown',event=>{
   if(event.key==='ArrowRight'){event.preventDefault();showSubmenu(button.dataset.settingsGroup,true)}
   else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();const buttons=[...root.querySelectorAll('button')],i=buttons.indexOf(button),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();closeSubmenu();
   }else if(event.key==='Escape'&&activeId){event.preventDefault();event.stopPropagation();closeSubmenu(true)}
  });
 });
 for(const page of pages.values()){
  page.addEventListener('pointerenter',clearTimers);page.addEventListener('pointerleave',scheduleLeave);
  page.addEventListener('keydown',event=>{
   if(event.target.matches('select')&&event.key!=='Escape')return;
   if(event.key==='ArrowLeft'||event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSubmenu(true)}
   else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();const items=itemsIn(page),i=items.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(i+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
   }
  });
 }
 panel.addEventListener('pointerleave',scheduleLeave);
 panel.addEventListener('pointerenter',()=>clearTimeout(leaveTimer));
 panel.addEventListener('beforetoggle',event=>{if(event.target===panel)closeSubmenu()});
 window.addEventListener('resize',placeSubmenu);
 panel.addEventListener('scroll',placeSubmenu);
 window.addEventListener('blur',()=>closeSubmenu());
 root.hidden=footer.hidden=false;title.textContent='设置';
 const mode=document.getElementById('desktopThemeMode');
 mode.value=document.documentElement.dataset.themeMode||'system';mode.onchange=()=>window.DoNoteAppearance.applyTheme(mode.value,true);
 window.addEventListener('donote-theme-change',()=>{mode.value=document.documentElement.dataset.themeMode||'system'});
 get('[data-control="openAiModelSettings"]')?.querySelector('span')?.replaceChildren('阅读 AI 模型');
  get('[data-control="openAiManager"]')?.querySelector('span')?.replaceChildren('外部助手授权');

}
{
 const about=document.getElementById('aboutDoNote'),version=document.getElementById('aboutVersion');
 const dialog=document.getElementById('analogFlashcard'),flip=document.getElementById('flashcardFlip');
 const save=document.getElementById('flashcardSave');
 const cards=[{kind:'analog-v1',number:'001',title:'信号路径',image:'analog-flashcard.png'}];
 const capacity=10;
 let clicks=0,lastClick=0,unlocking=false;
 const collectible=()=>records.find(note=>note.flashcardKind==='analog-v1');
 const unlockedCards=()=>cards.filter(card=>records.some(note=>note.flashcardKind===card.kind)).sort((a,b)=>Number(a.number)-Number(b.number));
 const refresh=()=>{save.textContent=collectible()?'查看成就殿宇':unlocking?'正在解锁…':'重试解锁';save.disabled=unlocking};
 const showHall=()=>{if(dialog.open)dialog.close();switchView('pinned');tab='achievements';render()};
 const unlock=async()=>{
  if(collectible()||unlocking){refresh();return}
  if(!ready){toast('资料库尚未就绪，稍后可重试解锁。');refresh();return}
  unlocking=true;refresh();
  try{
   await put({id:crypto.randomUUID(),type:'custom-achievement',title:'设计闪卡 001 · 信号路径',date:today(),body:'先理解信号路径，再优化每个指标。\n从输入到输出，标出增益、带宽、噪声与反馈。每次改动，都回到这条路径验证。',tags:[],status:'已解锁',pinned:false,attachments:[],flashcardKind:'analog-v1'});
   render();toast('已解锁成就闪卡 001。',{label:'查看殿宇',run:showHall});
  }catch(error){toast('解锁失败：'+error.message)}finally{unlocking=false;refresh()}
 };
 const open=()=>{if(about.open)about.close();flip.setAttribute('aria-pressed','false');dialog.showModal();refresh();void unlock()};
 version.addEventListener('selectstart',event=>event.preventDefault());
 flip.addEventListener('dragstart',event=>event.preventDefault());
 version.addEventListener('click',()=>{const now=Date.now();clicks=now-lastClick>4000?1:clicks+1;lastClick=now;if(clicks>=5){clicks=0;open()}});
 dialog.querySelectorAll('[data-close-flashcard]').forEach(button=>button.addEventListener('click',()=>dialog.close()));
 flip.addEventListener('click',()=>flip.setAttribute('aria-pressed',String(flip.getAttribute('aria-pressed')!=='true')));
 save.addEventListener('click',()=>{if(collectible())showHall();else void unlock()});
 window.openAnalogFlashcard=open;
 window.renderAchievementHall=()=>{
  const unlocked=unlockedCards();
  const host=document.getElementById('records');
  host.classList.toggle('achievement-display',view==='pinned'&&tab==='achievements');
  document.querySelector('.searchrow').hidden=view==='pinned'&&tab==='achievements';
  if(view!=='pinned'||tab!=='achievements')return;
  document.getElementById('libraryPager').hidden=true;
  host.innerHTML='<section class="achievement-hall" aria-label="成就殿宇"><div class="achievement-hall-heading"><div><span>DONOTE · ACHIEVEMENTS</span><h3>成就殿宇</h3><p>每张卡记录一次值得珍藏的发现。</p></div><strong>已解锁 '+unlocked.length+' / '+capacity+'</strong></div><div class="achievement-grid">'+unlocked.map(card=>'<button type="button" class="achievement-tile" data-achievement="'+card.kind+'" aria-label="打开成就闪卡 '+card.number+' '+card.title+'"><img src="'+card.image+'" draggable="false" alt=""><span>NO. '+card.number+'</span><strong>'+card.title+'</strong></button>').join('')+'</div></section>';
  host.querySelectorAll('[data-achievement]').forEach(button=>button.addEventListener('click',open));
 };
}
{
 const select=document.getElementById('desktopPalette');
 if(select&&window.DoNoteAppearance){select.value=document.documentElement.dataset.palette||'default';select.onchange=()=>window.DoNoteAppearance.applyPalette(select.value,true)}
}
{
 const host=location.origin==='https://yams-one.example'&&window.chrome?.webview;
 if(host){
  const gear=document.getElementById('desktopSettingsButton');
  const panel=document.getElementById('desktopSettings');
  const splash=document.getElementById('desktopSplashToggle');
  const invert=document.getElementById('desktopPdfInvertToggle');
  const themeValue=document.getElementById('desktopThemeValue');
  const about=document.getElementById('aboutDoNote');
  const speechDialog=document.getElementById('speechModelSettings');
  const speechSelect=document.getElementById('speechModelSelect');
  const speechPath=document.getElementById('speechModelPath');
  const speechLabels={base:'轻量 · base',small:'轻量 · small','large-v3-turbo':'均衡 · large-v3-turbo','large-v3':'高准确 · large-v3'};
  const speechRoot='models\\asr';
  const refreshSpeechPath=()=>{speechPath.textContent=speechRoot+'\\'+speechSelect.value+'　·　'+speechLabels[speechSelect.value]};
  const captionDialog=document.getElementById('videoCaptionSettings');
  const captionKey='donote.video.subtitle.appearance.v1';
  const captionDefaults={size:24,opacity:100,font:'sans-serif',color:'#ffffff'};
  const captionValue=()=>{try{return {...captionDefaults,...JSON.parse(localStorage.getItem(captionKey)||'{}')}}catch{return {...captionDefaults}}};
  const setCaptionFields=()=>{
   const value=captionValue();
   document.getElementById('captionSize').value=value.size;
   document.getElementById('captionOpacity').value=value.opacity;
   document.getElementById('captionFont').value=value.font;
   document.getElementById('captionColor').value=value.color;
   document.getElementById('captionSizeValue').textContent=value.size+'px';
   document.getElementById('captionOpacityValue').textContent=value.opacity+'%';
  };
  const saveCaptionFields=()=>{
   const value={size:Number(document.getElementById('captionSize').value),opacity:Number(document.getElementById('captionOpacity').value),font:document.getElementById('captionFont').value,color:document.getElementById('captionColor').value};
   try{localStorage.setItem(captionKey,JSON.stringify(value))}catch{}
   setCaptionFields();
   window.dispatchEvent(new CustomEvent('donote-video-caption-change'));
  };
  const updateTheme=()=>{themeValue.textContent=document.documentElement.dataset.theme==='dark'?'夜间':'白天'};
  const place=()=>{
   panel.style.top='6px';
   panel.style.left=innerWidth<690?'8px':'34px';
  };
  let focusBeforeSettings;
  // A modal makes every element outside it inert, even in a popover.
  document.addEventListener('beforetoggle',event=>{
   if(event.newState==='closed'&&event.target===panel.parentElement&&panel.matches(':popover-open'))panel.hidePopover();
  },true);
  gear.hidden=false;
  gear.addEventListener('click',event=>{
   event.preventDefault();
   const parent=topWorkspaceModal()||document.body;
   if(panel.matches(':popover-open')){
    panel.hidePopover();
    if(panel.parentElement===parent)return;
   }
   if(panel.parentElement!==parent)parent.append(panel);
   focusBeforeSettings=document.activeElement;
   panel.showPopover();
   panel.querySelector('[data-settings-group]')?.focus({preventScroll:true});
  });
  panel.addEventListener('keydown',event=>{
   if(event.key!=='Escape'||event.defaultPrevented)return;
   event.preventDefault();
   event.stopPropagation();
   panel.hidePopover();
   if(focusBeforeSettings?.isConnected&&focusBeforeSettings.getClientRects().length)
    focusBeforeSettings.focus({preventScroll:true});
  });
  panel.addEventListener('beforetoggle',event=>{
   const open=event.newState==='open';
   gear.setAttribute('aria-expanded',String(open));
   if(open){place();updateTheme()}
  });
  window.addEventListener('resize',()=>{if(panel.matches(':popover-open'))place()});
  panel.addEventListener('click',event=>{
   const button=event.target.closest('button');
   if(!button||button.disabled)return;
   const {control,command}=button.dataset;
   if(control==='themeToggle'){
    document.getElementById(control).click();updateTheme();
   }else if(command==='toggle-startup'){
    splash.disabled=true;host.postMessage(command);
   }else if(command==='toggle-pdf-invert'){
    invert.disabled=true;host.postMessage(command);
   }else if(control==='aboutDoNote'){
    panel.hidePopover();about.showModal();
   }else{
    panel.hidePopover();
    if(control)document.getElementById(control).click();
    else if(command)host.postMessage(command);
   }
  });
  document.getElementById('openSpeechModelSettings').onclick=()=>{
   try{speechSelect.value=localStorage.getItem('donote-asr-model')||'small'}catch{speechSelect.value='small'}
   refreshSpeechPath();speechDialog.showModal();
  };
  speechSelect.onchange=refreshSpeechPath;
  document.getElementById('openAsrModelFolder').onclick=()=>host.postMessage('models:open-asr');
  speechDialog.querySelectorAll('[data-close-speech-model]').forEach(button=>button.addEventListener('click',()=>speechDialog.close()));
  document.getElementById('speechModelSettingsForm').onsubmit=event=>{
   event.preventDefault();
   try{localStorage.setItem('donote-asr-model',speechSelect.value)}catch{}
   speechDialog.close();toast('默认语音识别模型已保存：'+speechLabels[speechSelect.value]);
  };
  document.getElementById('openVideoCaptionSettings').onclick=()=>{setCaptionFields();captionDialog.showModal()};
  captionDialog.querySelectorAll('[data-close-caption-settings]').forEach(button=>button.addEventListener('click',()=>captionDialog.close()));
  for(const id of ['captionSize','captionOpacity','captionFont','captionColor'])document.getElementById(id).addEventListener('input',saveCaptionFields);
  document.getElementById('captionReset').onclick=()=>{
   try{localStorage.setItem(captionKey,JSON.stringify(captionDefaults))}catch{}
   setCaptionFields();window.dispatchEvent(new CustomEvent('donote-video-caption-change'));
  };
  document.getElementById('videoCaptionSettingsForm').onsubmit=event=>{event.preventDefault();saveCaptionFields();captionDialog.close()};
  about.querySelectorAll('[data-close-about]').forEach(button=>button.addEventListener('click',()=>about.close()));
  host.addEventListener('message',event=>{
   if(event.data?.type!=='yams-one-preferences')return;
   splash.setAttribute('aria-checked',String(event.data.splashEnabled));
   splash.disabled=false;
   invert.setAttribute('aria-checked',String(!!event.data.pdfInvert));
   document.documentElement.dataset.pdfInvert=event.data.pdfInvert?'on':'off';
   invert.disabled=false;
  });
  host.postMessage('startup-ready');
 }
}
