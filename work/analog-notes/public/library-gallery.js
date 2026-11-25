/**
 * [INPUT]: 读取资料库筛选结果、附件字节与缩略图缓存。
 * [OUTPUT]: 提供分页条、PDF/PPT/网页/图片/视频封面缩略图懒加载与资料库列表渲染。
 * [POS]: 文献与媒体库视图核心渲染层，在视口可见时按需生成并缓存首页封面图。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
let galleryEpoch=0,galleryObserver,galleryQueue=[],galleryWorkers=0;
const galleryUrls=new Set();
const selectedLibraryIds=new Set();
let librarySelectionMode=false,librarySelectionProfile=null,visibleLibraryIds=[],libraryDeleting=false;
function libraryPageSize(){return 20}
let libraryPage=1,libraryPageSignature='';
function libraryFilterSignature(){
 const value=id=>{const node=$(id);if(!node)return '';return node.type==='checkbox'?String(node.checked):String(node.value)};
 return [view,view==='plan'?planArchiveMode:'',tab,topic,value('search'),value('libraryStatus'),value('libraryKind'),value('sort'),value('meetingWeek'),value('weeklyOnly'),value('issueTrackFilter'),value('recordFolderFilter')].join('\u0001');
}
function libraryPageSlice(list){
 const signature=libraryFilterSignature();
 if(signature!==libraryPageSignature){libraryPageSignature=signature;libraryPage=1}
 const pages=Math.max(1,Math.ceil(list.length/libraryPageSize()));
 libraryPage=Math.min(Math.max(1,libraryPage),pages);
 return {items:list.slice((libraryPage-1)*libraryPageSize(),libraryPage*libraryPageSize()),total:list.length,pages};
}
function setLibraryPage(next){
 libraryPage=Math.max(1,Math.round(Number(next))||1);render();
 const target=$('records');
 if(target)target.scrollIntoView({block:'start'});
}
function renderLibraryPager(total){
 const pager=$('libraryPager');if(!pager)return;
 const pages=Math.max(1,Math.ceil(total/libraryPageSize()));
 if(total<=libraryPageSize()){pager.hidden=true;pager.replaceChildren();return}
 const from=(libraryPage-1)*libraryPageSize()+1,to=Math.min(total,libraryPage*libraryPageSize());
 pager.hidden=false;
 pager.innerHTML='<button type="button" class="secondary" data-page="1" aria-label="第一页"'+(libraryPage===1?' disabled':'')+'>«</button>'
  +'<button type="button" class="secondary" data-page="'+(libraryPage-1)+'"'+(libraryPage===1?' disabled':'')+'>上一页</button>'
  +'<span class="library-pager-info">'+from+'–'+to+' / 共 '+total+' 条</span>'
  +'<label class="library-pager-jump">第 <input id="libraryPageInput" type="number" min="1" max="'+pages+'" value="'+libraryPage+'" inputmode="numeric" aria-label="跳转到第几页"> / '+pages+' 页</label>'
  +'<button type="button" class="secondary" data-page="'+(libraryPage+1)+'"'+(libraryPage===pages?' disabled':'')+'>下一页</button>'
  +'<button type="button" class="secondary" data-page="'+pages+'" aria-label="最后一页"'+(libraryPage===pages?' disabled':'')+'>»</button>';
 pager.querySelectorAll('[data-page]').forEach(button=>{button.onclick=()=>setLibraryPage(button.dataset.page)});
 const input=$('libraryPageInput');
 const jump=()=>{const value=Math.round(Number(input.value));if(Number.isFinite(value)&&value>0)setLibraryPage(value);else input.value=libraryPage};
 input.onchange=jump;
 input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();jump()}};
}
const galleryThumbnailPrefix=(profileId,fileId)=>'thumbnail/v1/'+profileId+'/'+fileId+'/';
function galleryProgress(note){const p=note.readerProgress;if(note.status==='已读'||p?.finished)return 100;if(!p)return 0;return Math.min(99,Math.max(0,Math.round(p.kind==='video'?(p.time/Math.max(1,p.duration))*100:(p.page/Math.max(1,p.pages))*100)))}
function videoSubtitleStatus(note,file){
 if(!file||!fileIsVideo(file))return '';
 const cues=note.videoSubtitles?.[file.id];if(!Array.isArray(cues))return '';
 const english=cues.filter(cue=>typeof cue?.en==='string'&&cue.en.trim());
 const translated=english.filter(cue=>typeof cue.zh==='string'&&cue.zh.trim());
 if(english.length&&translated.length===english.length)return '双语字幕';
 if(translated.length)return '部分翻译';
 if(english.length)return '英文字幕';
 return cues.some(cue=>typeof cue?.zh==='string'&&cue.zh.trim())?'中文字幕':'';
}
function clearGallery(){galleryEpoch++;galleryObserver?.disconnect();galleryQueue=[];for(const url of galleryUrls)URL.revokeObjectURL(url);galleryUrls.clear()}
async function webCoverImage(blob,{snapshot=false}={}){
 const fragment=captureTemplate(await blob.text()).content;
 const selector=snapshot?'main img, article img, [role="main"] img':'img';
 const images=[...fragment.querySelectorAll(selector)].filter(img=>{
  const src=img.getAttribute('src')||'',alt=img.getAttribute('alt')||'';
  return WEB_CAPTURE_IMAGE.test(src)&&!/(?:avatar|favicon|\blogo\b|头像|网站标志)/i.test(alt);
 }).slice(0,8);
 for(const image of images){
  try{
   const bitmap=await createImageBitmap(await (await fetch(image.getAttribute('src'))).blob());
   try{
    if(bitmap.width<140||bitmap.height<80||bitmap.width/bitmap.height>5||bitmap.height/bitmap.width>3)continue;
    const canvas=document.createElement('canvas'),scale=Math.min(1,480/Math.max(bitmap.width,bitmap.height));
    canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    return await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.88));
   }finally{bitmap.close()}
  }catch{}
 }
 return null;
}
async function thumbnail(file,profileId,snapshot){
 if(requiresExternalReader(file)||fileIsPdf(file)&&file.size>MAX_DOCUMENT_PREVIEW)return null;
 const key=galleryThumbnailPrefix(profileId,file.id)+file.size,tx=database.transaction('workspace'),cached=await reqResult(tx.objectStore('workspace').get(key));if(cached instanceof Blob)return cached;
 const original=await readBlob(file.id,profileId);let blob;
 if(file.webRole==='article'){
  blob=await webCoverImage(original);
  if(!blob&&snapshot)blob=await webCoverImage(await readBlob(snapshot.id,profileId),{snapshot:true});
 }else if(fileIsPdf(file)){
  if(original.size>MAX_DOCUMENT_PREVIEW)return null;
  const task=await localPdfTask(await pdfLibrary(),original);let doc;
  try{doc=await task.promise;const page=await doc.getPage(1),base=page.getViewport({scale:1}),viewport=page.getViewport({scale:320/base.width}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.min(700,Math.ceil(viewport.height));await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;blob=await new Promise(r=>canvas.toBlob(r,'image/png'))}finally{await task.destroy().catch(()=>{})}
 }else if(fileIsImage(file)){
  const bitmap=await createImageBitmap(original);try{const canvas=document.createElement('canvas');canvas.width=Math.min(400,bitmap.width);canvas.height=Math.max(1,Math.round(bitmap.height*canvas.width/bitmap.width));const bounded=Math.min(canvas.height,700);canvas.height=bounded;canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,bitmap.height*canvas.width/bitmap.width);blob=await new Promise(r=>canvas.toBlob(r,'image/png'))}finally{bitmap.close()}
 }else if(typeof fileIsPresentation==='function'&&fileIsPresentation(file)){
  if(original.size<=MAX_DOCUMENT_PREVIEW&&typeof renderFirstPresentationSlideBlob==='function'){
   blob=await renderFirstPresentationSlideBlob(original);
  }
 }else if(fileIsVideo(file)){
  const url=URL.createObjectURL(original),video=document.createElement('video');video.muted=true;video.preload='auto';video.src=url;
  try{blob=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),6000);video.onerror=()=>{clearTimeout(timer);resolve(null)};video.onloadeddata=()=>{video.currentTime=Math.min(.5,Number.isFinite(video.duration)?video.duration/3:0)};video.onseeked=()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=Math.max(1,Math.round((video.videoHeight||180)*320/(video.videoWidth||320)));canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);canvas.toBlob(result=>{clearTimeout(timer);resolve(result)},'image/png')}})}finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url)}
 }
 if(blob)await putWorkspaceForFile(profileId,file.id,key,blob).catch(()=>{});
 return blob;
}
function pumpGallery(){
 while(galleryWorkers<2&&galleryQueue.length){
  const job=galleryQueue.shift();galleryWorkers++;
  (async()=>{
   try{
    const blob=await thumbnail(job.file,job.profile,job.snapshot);
    if(!blob||job.epoch!==galleryEpoch||!job.node.isConnected)return;
    const url=URL.createObjectURL(blob);galleryUrls.add(url);
    const img=document.createElement('img');img.src=url;img.alt=job.file.webRole?'':job.file.name+' 预览';
    if(job.file.webRole)job.node.classList.add('web-cover-has-image');
    else job.node.querySelector('.cover-placeholder')?.remove();
    job.node.prepend(img);
   }catch{
    // Keep the file icon when the preview cannot be generated.
   }finally{galleryWorkers--;pumpGallery()}
  })();
 }
}
function renderLibraryGallery(list,allIds){
 clearGallery();const enabled=view==='resource',profileId=appState?.activeId;
 document.querySelector('main').classList.toggle('library-mode',enabled);$('records').classList.toggle('library-gallery',enabled);
 if(!enabled||librarySelectionProfile!==profileId){librarySelectionMode=false;selectedLibraryIds.clear()}
 librarySelectionProfile=profileId;visibleLibraryIds=enabled?(allIds||list).map(note=>note.id):[];
 const visible=new Set(visibleLibraryIds);
 for(const id of selectedLibraryIds)if(!visible.has(id))selectedLibraryIds.delete(id);
 if(!enabled){
  const byId=new Map(list.map(note=>[note.id,note]));
  for(const card of $('records').querySelectorAll('.card')){
   const note=byId.get(card.dataset.id);if(!note)continue;
   const statuses=(note.attachments||[]).map(file=>videoSubtitleStatus(note,file));
   const status=['双语字幕','部分翻译','英文字幕','中文字幕'].find(value=>statuses.includes(value));
   if(status){const badge=document.createElement('span');badge.className='video-subtitle-list-badge';badge.textContent='CC · '+status;badge.title='视频'+status;card.querySelector('.card-meta')?.append(badge)}
  }
  updateLibrarySelection();return
 }
 const epoch=galleryEpoch,profile=appState.activeId,byId=new Map(list.map(n=>[n.id,n]));
 galleryObserver=new IntersectionObserver(entries=>{
  for(const entry of entries){
   if(!entry.isIntersecting)continue;
   galleryObserver.unobserve(entry.target);
   const note=byId.get(entry.target.closest('.card').dataset.id);
   const file=note?.webArticle?note.attachments?.find(a=>a.webRole==='article'):note?.attachments?.[0];
   if(file){
    const snapshot=note.webArticle?note.attachments.find(a=>a.webRole==='snapshot'):null;
    galleryQueue.push({node:entry.target,file,snapshot,profile,epoch});pumpGallery();
   }
  }
 },{rootMargin:'150px'});
 for(const card of $('records').querySelectorAll('.card')){
  const n=byId.get(card.dataset.id),file=n.attachments?.[0],web=!!n.webArticle,video=file&&fileIsVideo(file),format=web?'网页':video?'视频':file&&fileIsPdf(file)?'PDF':file?.name.split('.').pop().toUpperCase()||(n.type==='paper'?'阅读笔记':'资料'),progress=galleryProgress(n);
  const source=web?webCaptureUrl(n.webArticle.url)?.hostname:'';
  const author=n.author||(n.literature?.needsReview?'作者待确认':'');
  const metadata=[format,author,source].filter(Boolean).map(value=>'<span>'+esc(value)+'</span>').join('');
  const preview='<div class="cover-placeholder" aria-hidden="true">'+svg(web?'navLibrary':'book')+'</div>';
  card.classList.toggle('web-resource-card',web);
  const progressBar=progress>0?'<div class="cover-progress" role="progressbar" aria-label="阅读进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+progress+'"><i style="width:'+progress+'%"></i></div>':'';
  const tags=n.tags.slice(0,3).map(tag=>'<span>'+esc(tag)+'</span>').join('');
  card.innerHTML='<div class="library-cover">'+preview+progressBar+'</div>'
   +'<div class="library-card-body"><h3 title="'+esc(n.title)+'">'+esc(n.title)+'</h3>'
   +'<div class="library-item-meta">'+metadata+'</div>'
   +(tags?'<div class="library-card-tags">'+tags+'</div>':'')
   +'<div class="library-card-foot"><span data-status="'+esc(n.status)+'">'+esc(n.status)+(n.readerProgress?' · '+esc(progressLabel(n.readerProgress)):'')+'</span>'
   +'<button class="gallery-details" aria-label="查看 '+esc(n.title)+' 的详情">详情</button></div></div>';
  const cover=card.querySelector('.library-cover'),foot=card.querySelector('.library-card-foot'),details=foot.querySelector('.gallery-details');
  const subtitleStatus=videoSubtitleStatus(n,file);
  if(subtitleStatus){
   const badge=document.createElement('span');badge.className='library-subtitle-status';badge.textContent=subtitleStatus;
   card.querySelector('.library-item-meta').append(badge);
  }

  const checkLabel=document.createElement('label'),check=document.createElement('input');
  checkLabel.className='gallery-select';checkLabel.title='选择此资料';check.type='checkbox';check.setAttribute('aria-label','选择 '+n.title);
  checkLabel.append(check);cover.append(checkLabel);checkLabel.onclick=e=>e.stopPropagation();check.onchange=()=>toggleLibraryItem(n.id);
  const actions=document.createElement('div'),remove=document.createElement('button');actions.className='gallery-card-actions';
  remove.className='danger gallery-delete';remove.textContent='删除';remove.setAttribute('aria-label','删除 '+n.title);
  foot.append(actions);actions.append(details,remove);
  const activate=()=>librarySelectionMode?toggleLibraryItem(n.id):n.type==='paper'||(!file&&!web)?showDetail(n.id):openResource(n.id);
  card.onclick=activate;card.onkeydown=e=>{if(e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();activate()}};
  details.onclick=e=>{e.stopPropagation();showDetail(n.id)};
  remove.onclick=e=>{e.stopPropagation();deleteLibraryItems([n.id])};
  if(!web&&file)galleryObserver.observe(cover);
 }
 updateLibrarySelection();
}
function updateLibrarySelection(){
 const count=selectedLibraryIds.size,selectAll=$('librarySelectAll');
 $('librarySelection').textContent=librarySelectionMode?'退出多选':'多选';
 $('librarySelection').setAttribute('aria-pressed',String(librarySelectionMode));
 $('librarySelection').disabled=libraryDeleting||(!librarySelectionMode&&!visibleLibraryIds.length);
 $('libraryBatchActions').hidden=!librarySelectionMode;
 $('librarySelectedCount').textContent='已选 '+count+' 份';
 selectAll.textContent=count&&count===visibleLibraryIds.length?'取消全选':'全选当前结果';
 selectAll.disabled=libraryDeleting||!visibleLibraryIds.length;$('libraryDeleteSelected').disabled=libraryDeleting||!count;
 updateLibraryOrganization();
 for(const card of $('records').querySelectorAll('.library-gallery .card')){
  const selected=selectedLibraryIds.has(card.dataset.id),check=card.querySelector('.gallery-select input');
  check.checked=selected;check.disabled=libraryDeleting;check.parentElement.hidden=!librarySelectionMode;
  card.classList.toggle('library-selected',librarySelectionMode&&selected);
  card.querySelector('.gallery-card-actions').hidden=librarySelectionMode;
  card.querySelector('.gallery-delete').disabled=libraryDeleting;
 }
}
function toggleLibraryItem(id){
 if(libraryDeleting)return;
 if(selectedLibraryIds.has(id))selectedLibraryIds.delete(id);else selectedLibraryIds.add(id);
 updateLibrarySelection();
}
async function deleteLibraryItems(ids){
 if(libraryDeleting||!ensureReady())return;
 const targets=new Set(ids),resources=records.filter(note=>['resource','paper'].includes(note.type)&&targets.has(note.id));
 if(!resources.length)return;
 libraryDeleting=true;updateLibrarySelection();
 try{if(await deleteWorkspaceRecords(resources.map(note=>note.id)))render()}
 catch(e){toast(e.message)}finally{libraryDeleting=false;updateLibrarySelection()}
}
$('librarySelection').onclick=()=>{librarySelectionMode=!librarySelectionMode;selectedLibraryIds.clear();updateLibrarySelection()};
$('librarySelectAll').onclick=()=>{
 const all=selectedLibraryIds.size===visibleLibraryIds.length;
 selectedLibraryIds.clear();if(!all)for(const id of visibleLibraryIds)selectedLibraryIds.add(id);
 updateLibrarySelection();
};
$('libraryDeleteSelected').onclick=()=>deleteLibraryItems([...selectedLibraryIds]);
