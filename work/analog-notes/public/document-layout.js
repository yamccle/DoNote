'use strict';
let selectedInlineImage=null,documentImageEpoch=0;
const documentImageUrls=new Map();
function setEditorMode(full){$('editor').classList.toggle('document-page',full);$('editorModeBtn').textContent=full?'切换为浮窗':'展开为整页'}
$('editorModeBtn').onclick=()=>setEditorMode(!$('editor').classList.contains('document-page'));
function releaseDocumentImages(){documentImageEpoch++;for(const url of documentImageUrls.values())URL.revokeObjectURL(url);documentImageUrls.clear();selectedInlineImage=null;$('imageTools').hidden=true}
$('editor').addEventListener('close',releaseDocumentImages);
$('detail').addEventListener('close',()=>{for(const [key,url] of documentImageUrls)if(key.startsWith('detail/')){URL.revokeObjectURL(url);documentImageUrls.delete(key)}});
function slotMetadata(slot){return {id:slot.dataset.imageId,width:Math.min(100,Math.max(10,Number(slot.dataset.width)||70)),align:['left','right','center'].includes(slot.dataset.align)?slot.dataset.align:'center'}}
function selectInlineImage(slot){
 richEditor.querySelectorAll('.inline-media.selected').forEach(n=>n.classList.remove('selected'));selectedInlineImage=slot;
 if(!slot){$('imageTools').hidden=true;return}
 slot.classList.add('selected');$('imageTools').hidden=false;const meta=slotMetadata(slot),a=draftAttachments.find(a=>a.id===meta.id);$('imageToolName').textContent=a?.name||'图片排版';$('imageWidth').value=String(Math.round(meta.width));
 document.querySelectorAll('[data-image-align]').forEach(b=>b.classList.toggle('active',b.dataset.imageAlign===meta.align));
}
function applyImageWidth(slot,width){slot.dataset.width=String(Math.min(100,Math.max(10,width)));slot.style.width=slot.dataset.width+'%';syncRichBody()}
async function hydrateDocumentImages(container,note,editable){
 if(!container)return;if(editable){releaseDocumentImages()}
 const epoch=documentImageEpoch,files=editable?draftAttachments:(note?.attachments||[]),profileId=appState?.activeId;
 for(const slot of container.querySelectorAll('[data-image-id]')){
  const meta=slotMetadata(slot),file=files.find(a=>a.id===meta.id);slot.className='inline-media';slot.contentEditable='false';slot.style.width=meta.width+'%';slot.dataset.align=meta.align;slot.replaceChildren();
  const loading=document.createElement('span');loading.className='image-loading';loading.textContent='正在读取原图…';slot.append(loading);
  try{
   if(!file||!fileIsImage(file))throw new Error('图片附件不可用');
   const raw=editable&&stagedFiles.has(file.id)?stagedFiles.get(file.id):await readBlob(file.id,profileId);
   if(epoch!==documentImageEpoch||!slot.isConnected)continue;
   const key=(editable?'editor/':'detail/')+file.id;let url=documentImageUrls.get(key);if(!url){url=URL.createObjectURL(new Blob([raw],{type:file.mime}));documentImageUrls.set(key,url)}
   const image=document.createElement('img');image.src=url;image.alt=file.name;image.draggable=false;slot.replaceChildren(image);
   slot.ondblclick=e=>{e.preventDefault();e.stopPropagation();openInlineOriginal(file,editable)};
   if(editable){
    slot.onclick=e=>{e.stopPropagation();selectInlineImage(slot)};
    const handle=document.createElement('button');handle.type='button';handle.className='image-resize';handle.title='拖动缩放图片，原文件保持不变';handle.setAttribute('aria-label','缩放图片');slot.append(handle);
    handle.onpointerdown=e=>{
     e.preventDefault();e.stopPropagation();selectInlineImage(slot);handle.setPointerCapture(e.pointerId);
     const original=slot.getBoundingClientRect(),available=richEditor.clientWidth-parseFloat(getComputedStyle(richEditor).paddingLeft)-parseFloat(getComputedStyle(richEditor).paddingRight),startX=e.clientX,startY=e.clientY;
     richEditor.classList.add('image-resizing');
     const move=event=>{const dx=event.clientX-startX,dy=(event.clientY-startY)*(image.naturalWidth/Math.max(1,image.naturalHeight)),delta=Math.abs(dx)>Math.abs(dy)?dx:dy;applyImageWidth(slot,Math.round((original.width+delta)/available*100));$('imageWidth').value=slot.dataset.width};
     const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);richEditor.classList.remove('image-resizing');syncRichBody()};
     handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    };
   }
  }catch(e){loading.textContent='图片不可用，请检查附件或从备份恢复。'}
 }
}
async function openInlineOriginal(file,editable){
 if(editable&&stagedFiles.has(file.id)){try{await showOriginalBlob(file,stagedFiles.get(file.id))}catch(e){toast(e.message)}}else openAttachment(file);
}
async function showOriginalBlob(file,blob){
 discardMinimizedWorkspaceDialog('reader');
 if(readerUrl)URL.revokeObjectURL(readerUrl);readerFile={id:file.id,name:file.name,blob};readerUrl=URL.createObjectURL(new Blob([blob],{type:file.mime}));$('readerTitle').textContent=file.name+' · 原图';$('readerContent').replaceChildren();
 const wrap=document.createElement('div');wrap.id='imagePreview';const image=document.createElement('img');image.src=readerUrl;image.alt=file.name;wrap.append(image);const link=document.createElement('a');link.href=readerUrl;link.target='_blank';link.rel='noopener';link.textContent='在新窗口打开原图 ↗';link.className='reader-native-link';wrap.append(link);$('readerContent').append(wrap);$('reader').showModal();
}
richEditor.addEventListener('click',e=>{if(!e.target.closest('[data-image-id]'))selectInlineImage(null)});
$('imageWidth').onchange=()=>{if(selectedInlineImage){applyImageWidth(selectedInlineImage,Number($('imageWidth').value)||70);$('imageWidth').value=selectedInlineImage.dataset.width}};
document.querySelectorAll('[data-image-align]').forEach(b=>b.onclick=()=>{if(selectedInlineImage){selectedInlineImage.dataset.align=b.dataset.imageAlign;selectInlineImage(selectedInlineImage);syncRichBody()}});
$('imageOriginal').onclick=()=>{const a=draftAttachments.find(a=>a.id===selectedInlineImage?.dataset.imageId);if(a)openInlineOriginal(a,true)};
$('removeInlineImage').onclick=()=>{if(selectedInlineImage){selectedInlineImage.remove();selectInlineImage(null);syncRichBody();toast('已移出正文，原图仍保存在附件中')}};
function removeInlineReference(id){richEditor.querySelectorAll('[data-image-id]').forEach(n=>{if(n.dataset.imageId===id)n.remove()});selectInlineImage(null);syncRichBody()}
$('insertInlineImage').onclick=()=>{rememberBodyRange();$('inlineImageInput').click()};
async function insertOriginalImages(files){
 try{
  if(!files.length)return;if(files.some(f=>!fileIsImage({mime:f.type})))throw new Error('正文支持 PNG、JPG、WebP、GIF 和 BMP 图片。');
  if(files.some(f=>f.size>MAX_FILE)||files.length+draftAttachments.length>MAX_ATTACHMENTS)throw new Error('请检查文件大小；每条记录最多保存 '+MAX_ATTACHMENTS+' 个附件。');
  const range=restoreBodyRange();
  let content='';for(const f of files){const a={id:crypto.randomUUID(),name:f.name||'粘贴图片.png',mime:f.type,size:f.size,addedAt:new Date().toISOString(),inlineImage:true};draftAttachments.push(a);stagedFiles.set(a.id,f);content+='<span class="inline-media" data-image-id="'+a.id+'" data-width="70" data-align="center"></span><br>'}
  document.execCommand('insertHTML',false,content);rememberBodyRange();renderDraftAttachments();await hydrateDocumentImages(richEditor,null,true);syncRichBody();const slots=richEditor.querySelectorAll('[data-image-id]');if(slots.length)selectInlineImage(slots[slots.length-1]);
 }catch(e){$('formMessage').textContent=e.message}
}
$('inlineImageInput').onchange=async e=>{await insertOriginalImages([...e.target.files]);e.target.value=''};
richEditor.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();rememberBodyRange();insertOriginalImages(files)}});
richEditor.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault()});
richEditor.addEventListener('drop',e=>{const files=[...(e.dataTransfer?.files||[])];if(files.length){e.preventDefault();rememberBodyRange();insertOriginalImages(files)}});
function offlineNoteHtml(note){
 let html=noteBodyHtml(note);const root=document.createElement('template');root.innerHTML=html;
 for(const slot of root.content.querySelectorAll('[data-image-id]')){
  const a=(note.attachments||[]).find(a=>a.id===slot.dataset.imageId);if(!a?.path){html=html.replace(slot.outerHTML,'[原图附件不可用]');continue}
  const meta=slotMetadata(slot),path=esc(a.path.split('/').map(encodeURIComponent).join('/')),layout=meta.align==='center'?'margin:14px auto;clear:both':meta.align==='left'?'float:left;margin:6px 18px 12px 0':'float:right;margin:6px 0 12px 18px';
  const markup='<span style="display:block;width:'+meta.width+'%;max-width:100%;'+layout+'"><a href="'+path+'" target="_blank" rel="noopener" title="点击打开原图"><img src="'+path+'" alt="'+esc(a.name)+'" style="display:block;width:100%;height:auto"></a></span>';
  html=html.replace(slot.outerHTML,()=>markup);
 }
 return html;
}
