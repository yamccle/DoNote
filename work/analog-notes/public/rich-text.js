'use strict';
const RICH_PALETTE=['#202932','#c43c39','#c36a23','#28745b','#2768b3','#7952b3'];
const richEditor=$('richBody');
const defaultRichFontSize=()=>String(Math.round(parseFloat(getComputedStyle(richEditor).fontSize)));
let savedBodyRange=null;
function cssColor(value){const node=document.createElement('span');node.style.color=value;return node.style.color.toLowerCase()}
const richColors=new Map(RICH_PALETTE.map(color=>[cssColor(color),color]));
function safeRichHtml(source){
 // Rebuild supported document markup; only validated styles and image references survive.
 const parsed=document.createElement('template'),output=document.createElement('div');parsed.innerHTML=String(source);
 const allowed=new Set(['SPAN','DIV','P','BR','B','STRONG','I','EM','SUB','SUP','SMALL','FONT','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','TABLE','THEAD','TBODY','TR','TH','TD','HR','A']);
 const discard=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','IMG','VIDEO','AUDIO','LINK','META','TEMPLATE','INPUT','BUTTON','TEXTAREA','SELECT']);
 function append(node,parent){
  if(node.nodeType===Node.TEXT_NODE){parent.append(document.createTextNode(node.data.replace(/\u200b/g,'')));return}
  if(node.nodeType!==Node.ELEMENT_NODE||discard.has(node.tagName))return;
  const imageId=node.getAttribute('data-image-id');
  if(node.tagName==='SPAN'&&imageId&&/^[a-zA-Z0-9-]{1,80}$/.test(imageId)){
   const slot=document.createElement('span');slot.className='inline-media';slot.dataset.imageId=imageId;
   slot.dataset.width=String(Math.min(100,Math.max(10,Number(node.getAttribute('data-width'))||70)));
   slot.dataset.align=['left','right','center'].includes(node.getAttribute('data-align'))?node.getAttribute('data-align'):'center';
   parent.append(slot);return;
  }
  if(!allowed.has(node.tagName)){for(const child of node.childNodes)append(child,parent);return}
  const target=document.createElement(node.tagName==='FONT'?'span':node.tagName.toLowerCase());
  if(node.tagName==='A'){
   let url;try{url=new URL(node.getAttribute('href')||'')}catch{}
   if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>4000){
    for(const child of node.childNodes)append(child,parent);return;
   }
   target.href=url.href;target.target='_blank';target.rel='noopener noreferrer';
  }
  if(node.tagName==='OL'&&/^\d{1,6}$/.test(node.getAttribute('start')||''))target.setAttribute('start',node.getAttribute('start'));
  const style=node.style;
  const rawSize=style.fontSize;
  if(/^\d+(?:\.\d+)?px$/.test(rawSize)){const px=Number.parseFloat(rawSize);if(px>=10&&px<=72)target.style.fontSize=px+'px'}
  if(style.fontWeight==='bold'||style.fontWeight==='700')target.style.fontWeight='700';
  if(style.fontWeight==='normal'||style.fontWeight==='400')target.style.fontWeight='400';
  if(['italic','normal'].includes(style.fontStyle))target.style.fontStyle=style.fontStyle;
  const color=richColors.get(cssColor(style.color||node.getAttribute('color')||''));if(color)target.style.color=color;
  for(const child of node.childNodes)append(child,target);
  parent.append(target);
 }
 for(const node of parsed.content.childNodes)append(node,output);
 return output.innerHTML;
}
function richPlainText(html){
 // Use the browser's rendered paragraph rules, including explicit blank lines.
 const root=document.createElement('div');root.className='rich-content';root.setAttribute('aria-hidden','true');
 root.style.cssText='position:fixed;left:-100000px;top:0;pointer-events:none;width:1000px;white-space:pre-wrap';
 root.innerHTML=html;document.body.append(root);const text=root.innerText;root.remove();
 return text.replace(/\u00a0/g,' ').replace(/\u200b/g,'');
}
function noteBodyHtml(note){return typeof note.bodyHtml==='string'?safeRichHtml(note.bodyHtml):esc(note.body||'').replace(/\n/g,'<br>')}
function normalizeRichNote(note){
 if(typeof note.bodyHtml!=='string')return note;
 const bodyHtml=safeRichHtml(note.bodyHtml);return {...note,bodyHtml,body:richPlainText(bodyHtml)};
}
function getRichHtml(){return safeRichHtml(richEditor.innerHTML)}
function syncRichBody(){$('body').value=richPlainText(getRichHtml())}
function loadRichBody(note){
 richEditor.innerHTML=note?noteBodyHtml(note):esc($('body').value).replace(/\n/g,'<br>');
 savedBodyRange=null;$('fontSize').value=defaultRichFontSize();$('richBold').setAttribute('aria-pressed','false');$('richItalic').setAttribute('aria-pressed','false');
 document.querySelectorAll('[data-color]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.color===RICH_PALETTE[0])));
 syncRichBody();
 if(typeof hydrateDocumentImages==='function')hydrateDocumentImages(richEditor,note,true);
}
function bodyRange(){const selection=window.getSelection();if(!selection||!selection.rangeCount)return null;const range=selection.getRangeAt(0);return richEditor.contains(range.startContainer)&&richEditor.contains(range.endContainer)?range:null}
function rememberBodyRange(){const range=bodyRange();if(range)savedBodyRange=range.cloneRange()}
function restoreBodyRange(){
 richEditor.focus();const selection=window.getSelection();let range=savedBodyRange;
 if(!range||!richEditor.contains(range.startContainer)||!richEditor.contains(range.endContainer)){range=document.createRange();range.selectNodeContents(richEditor);range.collapse(false)}
 selection.removeAllRanges();selection.addRange(range);return range;
}
function updateRichToolbar(){
 const range=bodyRange();if(!range)return;
 $('richBold').setAttribute('aria-pressed',String(document.queryCommandState('bold')));$('richItalic').setAttribute('aria-pressed',String(document.queryCommandState('italic')));
 const parent=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer:range.startContainer.parentElement;
 const style=getComputedStyle(parent);
 if(document.activeElement!==$('fontSize'))$('fontSize').value=String(Math.round(parseFloat(style.fontSize)||Number(defaultRichFontSize())));
 const color=richColors.get(cssColor(style.color));document.querySelectorAll('[data-color]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.color===color)));
}
document.addEventListener('selectionchange',()=>{if(!$('editor').open)return;rememberBodyRange();updateRichToolbar()});
richEditor.addEventListener('input',()=>{syncRichBody();rememberBodyRange();updateRichToolbar()});
richEditor.addEventListener('blur',rememberBodyRange);
function applyRichCommand(command,value=null){
 restoreBodyRange();document.execCommand('styleWithCSS',false,true);document.execCommand(command,false,value);syncRichBody();rememberBodyRange();updateRichToolbar();
}
function setRichFontSize(){
 const size=Number($('fontSize').value);
 if(!Number.isInteger(size)||size<10||size>72){toast('字号请输入 10–72 之间的整数。');return}
 const range=restoreBodyRange();
 if(range.collapsed){
  const token='rich-caret-'+crypto.randomUUID();
  document.execCommand('insertHTML',false,'<span id="'+token+'" style="font-size:'+size+'px">&#8203;</span>');
  const node=$(token);if(node){node.removeAttribute('id');const caret=document.createRange();caret.selectNodeContents(node);caret.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(caret)}
 }else{
  // fontSize creates a native editable selection; convert its temporary marker to px.
  document.execCommand('styleWithCSS',false,false);document.execCommand('fontSize',false,'7');
  richEditor.querySelectorAll('font[size="7"]').forEach(font=>{font.removeAttribute('size');font.style.fontSize=size+'px'});
 }
 document.execCommand('styleWithCSS',false,true);syncRichBody();rememberBodyRange();updateRichToolbar();
}
for(const button of document.querySelectorAll('.rich-toolbar button'))button.addEventListener('mousedown',e=>{rememberBodyRange();e.preventDefault()});
$('fontSize').addEventListener('pointerdown',rememberBodyRange);
$('fontSize').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();setRichFontSize()}});
$('applyFontSize').onclick=setRichFontSize;
$('richBold').onclick=()=>applyRichCommand('bold');$('richItalic').onclick=()=>applyRichCommand('italic');
document.querySelectorAll('[data-color]').forEach(button=>button.onclick=()=>applyRichCommand('foreColor',button.dataset.color));
$('clearRich').onclick=()=>{applyRichCommand('removeFormat');$('fontSize').value=defaultRichFontSize()};
richEditor.addEventListener('paste',e=>{
 if(e.clipboardData?.files.length)return;
 e.preventDefault();const html=e.clipboardData?.getData('text/html'),text=e.clipboardData?.getData('text/plain')||'';
 if((html?.length||0)>600000||text.length>150000){toast('粘贴内容过长，请分段粘贴。');return}
 const clean=html?safeRichHtml(html):esc(text).replace(/\n/g,'<br>');
 document.execCommand('insertHTML',false,clean);syncRichBody();rememberBodyRange();
});
richEditor.addEventListener('drop',e=>{if(!e.dataTransfer?.files.length){e.preventDefault();toast('可使用图片排版栏调整位置和文字环绕。')}});
