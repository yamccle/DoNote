'use strict';

/**
 * [INPUT]: PDF 阅读会话和阅读器控件。
 * [OUTPUT]: 安装菜单、侧栏键盘导航、批注与反向引用入口，暴露 session.showPdfPanel。
 * [POS]: 连接 PDF 阅读器的控件与当前会话。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
function installPdfToolbarPopover(popup,toggle,signal){
 const open=()=>popup.matches(':popover-open');
 const commands=()=>[...popup.querySelectorAll('button:not([disabled]):not([hidden])')];
 function position(){
  const bounds=toggle.getBoundingClientRect(),gap=6,margin=8;
  const below=innerHeight-bounds.bottom-gap-margin;
  const above=bounds.top-gap-margin;
  const placeAbove=below<170&&above>below;
  popup.style.left=Math.max(margin,Math.min(bounds.left,innerWidth-270-margin))+'px';
  popup.style.top=placeAbove?'auto':bounds.bottom+gap+'px';
  popup.style.bottom=placeAbove?innerHeight-bounds.top+gap+'px':'auto';
  popup.style.maxHeight=Math.max(0,placeAbove?above:below)+'px';
  popup.dataset.placement=placeAbove?'above':'below';
 }
 popup.addEventListener('beforetoggle',event=>{
  if(event.newState==='open')position();
 });
 window.addEventListener('resize',()=>{if(open())position()},{signal});
 toggle.addEventListener('keydown',event=>{
  if(!['ArrowDown','ArrowUp','Escape'].includes(event.key)||event.key==='Escape'&&!open())return;
  event.preventDefault();
  event.stopPropagation();
  if(event.key==='Escape'){
   popup.hidePopover();
   return;
  }
  if(!open())popup.showPopover();
  const items=commands();
  (event.key==='ArrowDown'?items[0]:items.at(-1))?.focus();
 });
 popup.addEventListener('keydown',event=>{
  const items=commands();
  if(event.key==='Escape'){
   event.preventDefault();
   event.stopPropagation();
   popup.hidePopover();
   toggle.focus({preventScroll:true});
   return;
  }
  if(!items.length||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();
  const index=items.indexOf(document.activeElement),step=event.key==='ArrowUp'?-1:1;
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:
   index<0?(step<0?items.length-1:0):(index+step+items.length)%items.length;
  items[next].focus();
 });
}

function installPdfTabs(tabs,activate){
 tabs.forEach((tab,index)=>{
  tab.onclick=()=>activate(tab);
  tab.onkeydown=event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();
   const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:
    (index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
   tabs[next].click();
   tabs[next].focus({preventScroll:true});
  };
 });
}

function installPdfSelectionMenu(session,scroller,actions){
 const reader=$('reader'),menu=document.createElement('div'),{signal}=session.controller;
 menu.className='pdf-selection-menu';menu.hidden=true;
 menu.setAttribute('role','menu');menu.setAttribute('aria-label','PDF 所选文字操作');
 reader.append(menu);
 const close=()=>{menu.hidden=true};
 const buttons=[
  ['翻译',picked=>actions.translate(picked)],
  ['高亮',()=>actions.mark('highlight'),'highlight'],
  ['下划线',()=>actions.mark('underline'),'underline'],
  ['删除线',()=>actions.mark('strike'),'strike'],
  ['添加批注',()=>actions.mark('comment')],
  ['保存为研究笔记',picked=>savePdfExcerpt(session,picked)],
  ['追加到已有记录',async picked=>{const id=await askPdfExcerptTarget();if(id)await appendPdfExcerpt(session,picked,id)}],
  ['复制',async picked=>{await navigator.clipboard.writeText(picked.quote);toast('已复制所选文字')}],
  ['询问 AI',picked=>actions.ask(picked)]
 ];
 scroller.addEventListener('contextmenu',event=>{
  const selection=getSelection();
  if(session.drawMode!=='select'||!selection?.rangeCount||selection.isCollapsed)return;
  const range=selection.getRangeAt(0),node=range.startContainer;
  const layer=(node.nodeType===Node.ELEMENT_NODE?node:node.parentElement)?.closest('.pdf-text-layer');
  if(!layer||!scroller.contains(layer)||!layer.contains(range.endContainer))return;
  const page=layer.closest('[data-pdf-page]');
  if(!page)return;
  session.activatePage?.(Number(page.dataset.pdfPage));
  const picked=capturePdfSelection(session);
  if(!picked?.rects.length)return;
  event.preventDefault();session.selectingText=false;
  menu.replaceChildren();
  for(const [label,run,kind] of buttons){
   const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');
   button.textContent=kind&&matchingPdfTextMarks(session,kind,picked).length?'取消'+label:label;
   button.onpointerdown=e=>e.preventDefault();
   button.onclick=async()=>{
    close();session.activatePage?.(picked.page);session.picked=picked;
    try{await run(picked)}catch(error){toast(error.message||'无法完成所选操作。')}
   };
   menu.append(button);
  }
  const rect=range.getBoundingClientRect(),keyboard=event.clientX===0&&event.clientY===0;
  menu.hidden=false;
  menu.style.left=Math.max(8,Math.min(keyboard?rect.left:event.clientX,innerWidth-menu.offsetWidth-8))+'px';
  menu.style.top=Math.max(8,Math.min(keyboard?rect.bottom:event.clientY,innerHeight-menu.offsetHeight-8))+'px';
  if(keyboard)menu.firstElementChild.focus({preventScroll:true});
 },{signal});
 reader.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))close()},{signal});
 reader.addEventListener('keydown',event=>{
  if(menu.hidden)return;
  if(event.key==='Escape'){event.preventDefault();const focused=menu.contains(document.activeElement);close();if(focused)scroller.focus({preventScroll:true});return}
  const items=[...menu.children],index=items.indexOf(document.activeElement);
  if(event.key==='Tab'){close();return}
  if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:index<0?(event.key==='ArrowUp'?items.length-1:0):(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;
  items[next].focus({preventScroll:true});
 },{signal});
 scroller.tabIndex=0;
 scroller.addEventListener('scroll',close,{signal});
 window.addEventListener('resize',close,{signal});
 signal.addEventListener('abort',()=>menu.remove(),{once:true});
}
function installPdfSidebarResize(session,layout,scroller){
 const {signal}=session.controller;
 const reader=$('reader');
 const panels=[
  {name:'outline',id:'pdfOutline',label:'调整目录栏宽度',initial:200,minimum:144,direction:1,hidden:'hide-outline'},
  {name:'side',id:'pdfSide',label:'调整右侧阅读栏宽度',initial:330,minimum:240,direction:-1,hidden:'hide-notes'},
 ];
 let drag=null,fitTimer,lastViewport=scroller.clientWidth;

 async function fitWidth(picked=capturePdfSelection(session)){
  if(readingSession!==session||!reader.open||drag||!scroller.clientWidth||lastViewport===scroller.clientWidth)return;
  lastViewport=scroller.clientWidth;
  if($('pdfZoom').value!=='fit')return;
  const {page,scroll}=session.pdfPosition();
  await session.showPage(page,scroll);
  if(readingSession===session&&session.page===page){session.picked??=picked;syncPdfTextMarkButtons(session)}
 }
 function scheduleFit(){
  clearTimeout(fitTimer);fitTimer=setTimeout(()=>fitWidth().catch(()=>{}),90);
 }
 function limits(panel){
  const {clientWidth:available}=layout;
  const other=panels.find(candidate=>candidate!==panel);
  const visible=!layout.classList.contains(other.hidden)&&!layout.classList.contains('pdf-focus-mode');
  const remaining=compactPdfLayout.matches?available-42:available-(visible?other.width||other.initial:0)-248;
  const maximum=Math.max(96,Math.min(available*.78,remaining));
  return {minimum:Math.min(panel.minimum,maximum),maximum};
 }
 function setWidth(panel,value,{minimum,maximum}=limits(panel)){
  panel.width=Math.round(Math.max(minimum,Math.min(maximum,value)));
  layout.style.setProperty('--pdf-'+panel.name+'-width',panel.width+'px');
  const divider=panel.divider;
  divider.setAttribute('aria-valuemin',String(Math.round(minimum)));
  divider.setAttribute('aria-valuemax',String(Math.round(maximum)));
  divider.setAttribute('aria-valuenow',String(panel.width));
 }
 function persist(panel){
  panel.preferred=panel.width;
  try{localStorage.setItem(panel.key,String(panel.width))}catch{}
 }
 function syncWidths(){
  for(const panel of panels)setWidth(panel,panel.preferred);
 }
 for(const panel of panels){
  panel.key='pdf-'+panel.name+'-width/'+session.profileId;
  try{panel.preferred=Number(localStorage.getItem(panel.key))||panel.initial}catch{panel.preferred=panel.initial}
  const divider=panel.divider=document.createElement('div');
  divider.className='pdf-panel-divider pdf-'+panel.name+'-divider';
  divider.tabIndex=0;
  divider.setAttribute('role','separator');
  divider.setAttribute('aria-orientation','vertical');
  divider.setAttribute('aria-controls',panel.id);
  divider.setAttribute('aria-label',panel.label);
  layout.append(divider);
  divider.onpointerdown=event=>{
   if(event.button!==0||drag)return;
   event.preventDefault();divider.focus({preventScroll:true});divider.setPointerCapture(event.pointerId);
   drag={panel,id:event.pointerId,x:event.clientX,width:panel.width,limits:limits(panel)};
   layout.classList.add('is-resizing-side');
  };
  divider.onpointermove=event=>{
   if(drag?.panel===panel&&drag.id===event.pointerId)
    setWidth(panel,drag.width+(event.clientX-drag.x)*panel.direction,drag.limits);
  };
  function finishDrag(event){
   if(drag?.panel!==panel||drag.id!==event.pointerId)return;
   const changed=drag.width!==panel.width;
   drag=null;
   layout.classList.remove('is-resizing-side');
   if(changed)persist(panel);
   scheduleFit();
  }
  divider.onpointerup=finishDrag;divider.onpointercancel=finishDrag;divider.onlostpointercapture=finishDrag;
  divider.onkeydown=event=>{
   const {minimum,maximum}=limits(panel),step=(event.shiftKey?8:24)*panel.direction;
   const values={ArrowLeft:panel.width-step,ArrowRight:panel.width+step,Home:minimum,End:maximum};
   if(!Object.hasOwn(values,event.key))return;
   event.preventDefault();setWidth(panel,values[event.key]);persist(panel);scheduleFit();
  };
 }
 let lastLayoutWidth=layout.clientWidth;
 const observer=new ResizeObserver(()=>{
  if(!reader.open||!layout.clientWidth)return;
  if(!drag&&lastLayoutWidth!==layout.clientWidth){lastLayoutWidth=layout.clientWidth;syncWidths()}
  scheduleFit();
 });
 syncWidths();lastViewport=scroller.clientWidth;
 observer.observe(layout);observer.observe(scroller);
 signal.addEventListener('abort',()=>{observer.disconnect();clearTimeout(fitTimer)},{once:true});
 return picked=>{syncWidths();return fitWidth(picked)};
}
const compactPdfLayout = matchMedia('(max-width: 850px)');

async function enhancePdfReader(session, bar, scroller) {
 session.annotations = await fileAnnotations(session.profileId, session.file);
 if (readingSession !== session) return;
 const {signal} = session.controller;
 $('reader').classList.add('reader-enhanced');
 session.markColor = MARK_COLORS[0];

 const panels = $('pdfReaderPanels').content.cloneNode(true);
 const tools = panels.querySelector('.pdf-tools');
 const layout = panels.querySelector('#pdfWorkspace');
 const outline = layout.querySelector('#pdfOutline');
 const outlineToggle = tools.querySelector('#togglePdfOutline');
 const focusButton = document.createElement('button');
 focusButton.type = 'button';
 focusButton.id = 'pdfFocusMode';
 focusButton.textContent = '专注';
 focusButton.title = '隐藏两侧栏，按 F 切换';
 focusButton.setAttribute('aria-pressed', 'false');
 outlineToggle.before(focusButton);
 const side = layout.querySelector('#pdfSide');
 outlineToggle.textContent = '目录';
 outlineToggle.title = '打开或收起目录、书签和查找';
 tools.querySelector('#pdfOcrMode').textContent = '识字';
 tools.querySelector('#openReaderAi').textContent = 'AI 问答';
 const navigationTools = document.createElement('div');
 navigationTools.className = 'pdf-toolbar-group pdf-navigation-tools';
 navigationTools.setAttribute('role', 'group');
 navigationTools.setAttribute('aria-label', '阅读导航');
 navigationTools.append(outlineToggle, focusButton);
 const annotationTools = document.createElement('div');
 annotationTools.className = 'pdf-toolbar-group pdf-annotation-tools';
 annotationTools.setAttribute('role', 'group');
 annotationTools.setAttribute('aria-label', '标注和识字');
 annotationTools.append(tools.querySelector('#pdfMarkToolsToggle'), tools.querySelector('#pdfMarkTools'), tools.querySelector('#pdfOcrMode'));
 const assistantTools = document.createElement('div');
 assistantTools.className = 'pdf-toolbar-group pdf-assistant-tools';
 assistantTools.setAttribute('role', 'group');
 assistantTools.setAttribute('aria-label', '阅读辅助');
 assistantTools.append(tools.querySelector('#togglePdfTranslation'), tools.querySelector('#togglePdfNotes'), tools.querySelector('#openReaderAi'));
 tools.replaceChildren(navigationTools, annotationTools, assistantTools);
 const toolbar = document.createElement('div');
 toolbar.className = 'pdf-unified-toolbar';
 bar.before(toolbar);
 toolbar.append(bar, tools);
 scroller.replaceWith(layout);
 outline.after(scroller);
 if (innerWidth < 1000) layout.classList.add('hide-outline', 'hide-notes');

 const navigationTabs = [...outline.querySelectorAll('[data-pdf-nav]')];
 const navigationPanes = [...outline.querySelectorAll('.pdf-nav-pane')];
 session.showPdfNavigation = name => {
  for (const tab of navigationTabs) {
   const active = tab.dataset.pdfNav === name;
   tab.setAttribute('aria-selected', String(active));
   tab.tabIndex = active ? 0 : -1;
  }
  for (const pane of navigationPanes) {
   pane.hidden = pane.id !== ({outline: 'pdfOutlinePane', bookmarks: 'pdfBookmarksPane', find: 'pdfFindPane'})[name];
  }
 };
 installPdfTabs(navigationTabs, tab => session.showPdfNavigation(tab.dataset.pdfNav));
 session.showPdfNavigation('outline');
 installPdfFind(session, outline);
 installReaderAi(session);
 installPdfReflow(session, bar, tools, layout);

 const syncSidebarWidth = installPdfSidebarResize(session, layout, scroller);
 const tabs = [...side.querySelectorAll('[data-pdf-panel-tab]')];
 const sections = side.querySelectorAll('[data-pdf-panel]');
 const panelButtons = tools.querySelectorAll('[data-pdf-panel-toggle]');
 const translation = installPdfTranslationPanel(session, side.querySelector('#pdfTranslationZone'), showPanel);
 let currentPanel = 'translation';
 let focusMode = false;

 function setFocusMode(enabled, picked = capturePdfSelection(session), refit = true) {
  focusMode = enabled;
  layout.classList.toggle('pdf-focus-mode', enabled);
  focusButton.setAttribute('aria-pressed', String(enabled));
  focusButton.textContent = enabled ? '退出专注' : '专注';
  if (refit) syncSidebarWidth(picked).catch(() => {});
 }
 focusButton.onclick = () => setFocusMode(!focusMode);
 $('reader').addEventListener('keydown', event => {
  if (layout.hidden || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.closest('input,textarea,select,[contenteditable="true"]') ||
      document.querySelector(':popover-open, .pdf-selection-menu:not([hidden]), dialog[open]:not(#reader):not(#detail)')) return;
  if (event.key.toLowerCase() === 'f' || (event.key === 'Escape' && focusMode)) {
   event.preventDefault();
   if (!focusMode && (outline.contains(document.activeElement) || side.contains(document.activeElement))) {
    focusButton.focus({preventScroll:true});
   }
   setFocusMode(event.key === 'Escape' ? false : !focusMode);
  }
 }, {signal});

 function updatePanelControls() {
  const visible = !layout.classList.contains('hide-notes');
  outlineToggle.setAttribute('aria-expanded', String(!layout.classList.contains('hide-outline')));
  for (const section of sections) section.hidden = section.dataset.pdfPanel !== currentPanel;
  for (const tab of tabs) {
   const active = tab.dataset.pdfPanelTab === currentPanel;
   tab.classList.toggle('active', active);
   tab.setAttribute('aria-selected', String(active));
   tab.tabIndex = active ? 0 : -1;
  }
  for (const button of panelButtons) {
   button.setAttribute('aria-expanded', String(visible && button.dataset.pdfPanelToggle === currentPanel));
  }
 }

 async function showPanel(mode, toggle = false, picked = capturePdfSelection(session)) {
  if (focusMode) {
   setFocusMode(false, picked, false);
   toggle = false;
  }
  const closing = toggle && mode === currentPanel && !layout.classList.contains('hide-notes');
  if (currentPanel !== mode) {
   const content = side.querySelector('[data-pdf-panel="' + mode + '"] .pdf-panel-scroll') || side;
   content.scrollTop = 0;
  }
  currentPanel = mode;
  layout.classList.toggle('hide-notes', closing);
  if (!closing && compactPdfLayout.matches) layout.classList.add('hide-outline');
  updatePanelControls();
  if (closing || mode !== 'translation') translation.cancelQueued();
  else translation.queueSelection(picked);
  await syncSidebarWidth(picked);
 }

 session.showPdfPanel = mode => showPanel(mode, false);
 session.editTextMark = async mark => {
  await showPanel('annotations');
  if (!signal.aborted) side.querySelector('[data-annotation-id="' + mark.id + '"] textarea')?.focus();
 };
 session.queueTranslation = picked => {
  if (focusMode || !translation.automaticEnabled || !picked?.quote) return;
  if (currentPanel !== 'translation' || layout.classList.contains('hide-notes')) {
   void showPanel('translation', false, picked);
  } else {
   translation.queueSelection(picked);
  }
 };

 installPdfTabs(tabs, tab => showPanel(tab.dataset.pdfPanelTab));
 for (const button of panelButtons) {
  button.onmousedown = event => {
   capturePdfSelection(session);
   event.preventDefault();
  };
  button.onclick = () => showPanel(button.dataset.pdfPanelToggle, true);
 }
 outlineToggle.onclick = () => {
  const picked = capturePdfSelection(session);
  const wasFocused = focusMode;
  if (wasFocused) setFocusMode(false, picked, false);
  const hidden = wasFocused ? (layout.classList.remove('hide-outline'), false) : layout.classList.toggle('hide-outline');
  if (!hidden && compactPdfLayout.matches) layout.classList.add('hide-notes');
  updatePanelControls();
  syncSidebarWidth(picked).catch(() => {});
 };
 updatePanelControls();
 compactPdfLayout.addEventListener('change', () => {
  if (!compactPdfLayout.matches || layout.classList.contains('hide-outline') || layout.classList.contains('hide-notes')) return;
  layout.classList.add('hide-outline');
  updatePanelControls();
  syncSidebarWidth().catch(() => {});
 }, {signal});

 installPdfAnnotationTools(session, tools);
 installPdfSelectionMenu(session, scroller, {
  translate: translation.openSelection,
  ask: async picked => {
   await showPanel('ai');
   if (signal.aborted) return;
   session.picked = picked;
   $('readerAiContext').value = 'selection';
   $('readerAiQuestion').focus();
  },
  mark: kind => tools.querySelector('[data-pdf-mark="' + kind + '"]').click()
 });

 scroller.addEventListener('pointerdown', event => {
  const page = event.target.closest('.pdf-page');
  if (event.button !== 0 || !page || session.drawMode !== 'select') return;
  session.activatePage?.(Number(page.dataset.pdfPage));
  session.selectingText = true;
  session.picked = null;
  translation.cancelQueued();
  syncPdfTextMarkButtons(session);
 }, {signal});
 document.addEventListener('selectionchange', () => {
  if (!$('reader').open) return;
  const previous = session.picked;
  const picked = capturePdfSelection(session);
  syncPdfTextMarkButtons(session);
  if (!session.selectingText && picked && picked !== previous) session.queueTranslation(picked);
 }, {signal});
 document.addEventListener('pointerup', () => {
  if (!session.selectingText) return;
  session.selectingText = false;
  session.queueTranslation(capturePdfSelection(session));
 }, {signal});
 document.addEventListener('pointercancel', () => {
  session.selectingText = false;
 }, {signal});

 renderPdfSidebar(session); installPdfBacklinks(session, side);
 void loadPdfOutline(session, outline.querySelector('#pdfOutlineList'));
}

async function loadPdfOutline(session, host) {
 const {signal} = session.controller;
 function clearActive() {
  const current = host.querySelector('.pdf-outline-entry.active');
  current?.classList.remove('active');
  current?.removeAttribute('aria-current');
 }
 document.addEventListener('pdf-page-change', event => {
  if (event.detail?.session === session) clearActive();
 }, {signal});

 function addEntries(nodes, parent = host, depth = 0) {
  for (const item of nodes) {
   const group = document.createElement('div');
   group.className = 'pdf-outline-group';
   const row = document.createElement('div');
   row.className = 'pdf-outline-row';
   row.style.paddingInlineStart = (4 + Math.min(depth, 8) * 12) + 'px';
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'pdf-outline-entry';
   button.textContent = item.title || '未命名章节';
   const hasChildren = !!item.items?.length;
   let toggle;
   if (hasChildren) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pdf-outline-expand';
    toggle.setAttribute('aria-label', '展开 ' + (item.title || '未命名章节'));
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '›';
    row.append(toggle);
   } else {
    const spacer = document.createElement('span');
    spacer.className = 'pdf-outline-spacer';
    row.append(spacer);
   }
   row.append(button);
   group.append(row);
   if (hasChildren) {
    const children = document.createElement('div');
    children.className = 'pdf-outline-children';
    children.hidden = true;
    toggle.onclick = () => {
     children.hidden = !children.hidden;
     toggle.setAttribute('aria-expanded', String(!children.hidden));
     toggle.setAttribute('aria-label', (children.hidden ? '展开 ' : '折叠 ') + (item.title || '未命名章节'));
    };
    addEntries(item.items, children, depth + 1);
    group.append(children);
   }
   button.onclick = async () => {
    if (!item.dest && toggle) { toggle.click(); return; }
    if (!item.dest || !await session.followPdfDestination(item.dest) || signal.aborted) return;
    clearActive();
    button.classList.add('active');
    button.setAttribute('aria-current', 'location');
   };
   parent.append(group);
  }
 }

 try {
  const outline = await session.pdf.getOutline();
  if (signal.aborted) return;
  host.replaceChildren();
  if (outline?.length) {
   addEntries(outline);
   return;
  }
  host.textContent = '此 PDF 未内嵌目录，可按页码跳转：';
  for (let page = 1; page <= Math.min(500, session.pdf.numPages); page++) {
   const button = document.createElement('button');
   button.textContent = '第 ' + page + ' 页';
   button.onclick = () => session.showPage(page);
   host.append(button);
  }
 } catch {
  if (!signal.aborted) host.textContent = '目录暂不可用，请使用页码跳转。';
 }
}

$('reader').addEventListener('close', () => $('reader').classList.remove('reader-enhanced'));
