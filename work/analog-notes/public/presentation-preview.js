'use strict';

let presentationEnginePromise;
function presentationPictureAt(svg,image,event){
 const source=new DOMParser().parseFromString(svg,'image/svg+xml'),root=source.documentElement,ns='http://www.w3.org/2000/svg';
 const rect=image.getBoundingClientRect(),ratio=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight),width=image.naturalWidth*ratio,height=image.naturalHeight*ratio;
 const probe=document.createElementNS(ns,'svg');probe.setAttribute('viewBox',root.getAttribute('viewBox')||'0 0 '+image.naturalWidth+' '+image.naturalHeight);
 Object.assign(probe.style,{position:'fixed',left:rect.left+(rect.width-width)/2+'px',top:rect.top+(rect.height-height)/2+'px',width:width+'px',height:height+'px',opacity:'0',pointerEvents:'none'});
 const images=[];
 for(const original of source.querySelectorAll('image')){
  let parent=probe;const ancestors=[];for(let n=original.parentElement;n&&n!==root;n=n.parentElement)ancestors.unshift(n);
  for(const ancestor of ancestors){const g=document.createElementNS(ns,'g');if(ancestor.hasAttribute('transform'))g.setAttribute('transform',ancestor.getAttribute('transform'));parent.append(g);parent=g}
  const copy=document.importNode(original,true);parent.append(copy);images.push(copy);
 }
 $('reader').append(probe);
 try{
  for(const item of images.reverse()){
   const matrix=item.getScreenCTM();if(!matrix)continue;
   const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse()),x=item.x.baseVal.value,y=item.y.baseVal.value,w=item.width.baseVal.value,h=item.height.baseVal.value;
   const href=item.getAttribute('href')||item.getAttributeNS('http://www.w3.org/1999/xlink','href');
   if(point.x>=x&&point.x<=x+w&&point.y>=y&&point.y<=y+h&&/^data:image\//i.test(href||''))return href;
  }
 }finally{probe.remove()}
 return null;
}
function openPresentationPicture(src,title){
 const viewer=document.createElement('dialog');viewer.className='ppt-picture-viewer';viewer.setAttribute('aria-label',title);
 viewer.innerHTML='<div class="modalhead"><h2></h2><button type="button" class="icon-button" aria-label="关闭">✕</button></div><div class="ppt-picture-body"><img alt="幻灯片图片"></div>';
 viewer.querySelector('h2').textContent=title;viewer.querySelector('img').src=src;
 viewer.querySelector('button').onclick=()=>viewer.close();
 viewer.addEventListener('close',()=>viewer.remove(),{once:true});
 document.body.append(viewer);viewer.showModal();
}

function fileIsPresentation(file){
 return /\.pptx?$/i.test(file.name)||[
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
 ].includes(file.mime);
}

function presentationEngine(){
 if(!presentationEnginePromise){
  const embedded=$('embeddedPresentationEngine');
  const url=embedded
   ?URL.createObjectURL(new Blob([Uint8Array.from(atob(embedded.textContent),char=>char.charCodeAt(0))],{type:'text/javascript'}))
   :new URL('./ppt-preview-engine.mjs',document.baseURI).href;
  presentationEnginePromise=import(url).catch(error=>{
   presentationEnginePromise=null;
   throw error;
  }).finally(()=>{if(embedded)URL.revokeObjectURL(url)});
 }
 return presentationEnginePromise;
}

async function embedPresentationMedia(svg,signal){
 const reference=/(?:\b(?:href|src)\s*=\s*["']|\burl\(\s*["']?)(blob:[^\s"'()<>]+)/g;
 const urls=[...new Set([...svg.matchAll(reference)].map(match=>match[1]))];
 const replacements=new Map();
 for(const url of urls){
  const response=await fetch(url,{signal});
  if(!response.ok)throw new Error('幻灯片内的图片或字体无法读取。');
  const blob=await response.blob();
  const data=await new Promise((resolve,reject)=>{
   const reader=new FileReader();
   reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
   reader.readAsDataURL(blob);
  });
  replacements.set(url,data);
 }
 return svg.replace(reference,(match,url)=>match.slice(0,-url.length)+replacements.get(url));
}

async function openPresentationAttachment(file,blob){
 const dialog=$('reader'),content=$('readerContent'),controller=new AbortController();
 const {signal}=controller;
 let presentation,imageUrl,activePage=0,revision=0,slideSvg='',clickTimer;
 const toolbar=document.createElement('div');
 toolbar.className='reader-statusbar';
 toolbar.innerHTML='<button type="button" class="secondary" id="pptPrevious">上一页</button><input type="number" min="1" value="1" id="pptPageNumber" aria-label="幻灯片页码"><span id="pptPageCount" role="status">正在读取页数…</span><button type="button" class="secondary" id="pptNext">下一页</button><button type="button" class="secondary" id="pptExpand" aria-pressed="false">展开</button><span class="tiny ppt-navigation-hint">单击翻页 · 双击图片放大 · ← → 翻页</span>';
 const previous=toolbar.querySelector('#pptPrevious'),next=toolbar.querySelector('#pptNext'),pageNumber=toolbar.querySelector('#pptPageNumber'),count=toolbar.querySelector('#pptPageCount');
 previous.disabled=next.disabled=pageNumber.disabled=true;
 const stage=document.createElement('div'),status=document.createElement('p');
 stage.className='presentation-stage';
 status.className='section-note';status.setAttribute('role','status');status.textContent='正在打开幻灯片…';
 stage.append(status);content.replaceChildren(toolbar,stage);
 dialog.classList.add('reader-presentation');
 toolbar.querySelector('#pptExpand').onclick=event=>{const expanded=dialog.classList.toggle('reader-presentation-expanded');event.currentTarget.textContent=expanded?'还原浮窗':'展开';event.currentTarget.setAttribute('aria-pressed',String(expanded))};
 dialog.addEventListener('close',()=>{
  clearTimeout(clickTimer);controller.abort();dialog.classList.remove('reader-presentation','reader-presentation-expanded');
  presentation?.dispose?.();if(imageUrl)URL.revokeObjectURL(imageUrl);
 },{once:true});
 if(!dialog.open)dialog.showModal();
 try{
  const engine=await presentationEngine(),parsed=await engine.parse(blob);
  if(signal.aborted){parsed.dispose?.();return}
  presentation=parsed;
  if(!presentation.slides.length)throw new Error('文件中没有可预览的幻灯片。');
  pageNumber.disabled=false;pageNumber.max=String(presentation.slides.length);
  async function showSlide(index){
   if(signal.aborted)return;
   clearTimeout(clickTimer);
   activePage=Math.max(0,Math.min(presentation.slides.length-1,index));
   const slideNumber=activePage+1,version=++revision;
   pageNumber.value=String(slideNumber);count.textContent='/ '+presentation.slides.length+' 页';
   previous.disabled=activePage===0;next.disabled=slideNumber===presentation.slides.length;
   stage.setAttribute('aria-busy','true');
   let pendingUrl;
   try{
    const svg=engine.renderSlideToSvg(presentation,presentation.slides[activePage],{textMode:'svg'});
    const embedded=await embedPresentationMedia(svg,signal);
    if(signal.aborted||revision!==version)return;
    pendingUrl=URL.createObjectURL(new Blob([embedded],{type:'image/svg+xml;charset=utf-8'}));
    const image=new Image();
    image.alt=file.name+' · 第 '+slideNumber+' 页';image.src=pendingUrl;
    await image.decode();
    if(signal.aborted||revision!==version)return;
    stage.replaceChildren(image);slideSvg=embedded;
    if(imageUrl)URL.revokeObjectURL(imageUrl);
    imageUrl=pendingUrl;pendingUrl=null;
   }catch(error){
    if(!signal.aborted&&revision===version){
     status.textContent='这一页暂时无法预览。可翻到其他页，或打开同版式的 PDF。';stage.replaceChildren(status);
    }
   }finally{
    if(pendingUrl)URL.revokeObjectURL(pendingUrl);
    if(revision===version)stage.removeAttribute('aria-busy');
   }
  }
  previous.onclick=()=>showSlide(activePage-1);next.onclick=()=>showSlide(activePage+1);
  stage.tabIndex=0;stage.setAttribute('aria-label','幻灯片，单击下一页，方向键翻页，双击查看图片');
  stage.addEventListener('click',event=>{
   if(event.button!==0||event.detail>1||stage.getAttribute('aria-busy')==='true')return;
   clearTimeout(clickTimer);
   clickTimer=setTimeout(()=>{if(!signal.aborted)showSlide(activePage+1)},500);
  },{signal});
  stage.addEventListener('dblclick',event=>{
   event.preventDefault();clearTimeout(clickTimer);
   const image=stage.querySelector('img');if(!image||stage.getAttribute('aria-busy')==='true')return;
   const original=presentationPictureAt(slideSvg,image,event);
   openPresentationPicture(original||image.src,original?'幻灯片图片 · 原始图片':'幻灯片大图 · 第 '+(activePage+1)+' 页');
  },{signal});
  pageNumber.onchange=()=>showSlide((Math.round(Number(pageNumber.value))||1)-1);
  dialog.addEventListener('keydown',event=>{
   if(event.target.closest('input,textarea,select,[contenteditable="true"]')||event.key===' '&&event.target.closest('button')||event.altKey||event.ctrlKey||event.metaKey||!['ArrowLeft','ArrowRight','PageDown','PageUp','Home','End',' '].includes(event.key))return;
   event.preventDefault();showSlide(event.key==='Home'?0:event.key==='End'?presentation.slides.length-1:activePage+(['ArrowRight','PageDown',' '].includes(event.key)?1:-1));
  },{signal});
  await showSlide(0);
 }catch(error){
  if(signal.aborted)return;
  count.textContent='无法读取页数';
  status.textContent=error.name==='PasswordRequiredError'
   ?'此文件需要密码。可解密后重新导入，或导入由 PowerPoint 导出的 PDF。'
   :'无法预览这份演示文稿。可检查文件是否完整，或导入由 PowerPoint 导出的 PDF。';
 }
}
