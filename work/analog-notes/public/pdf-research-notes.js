'use strict';

function validPdfNoteSource(source){
 return source===undefined||(
  source && /^[a-zA-Z0-9-]{1,80}$/.test(source.recordId) &&
  /^[a-zA-Z0-9-]{1,80}$/.test(source.fileId) &&
  Number.isInteger(source.page) && source.page>0 && source.page<=100000 &&
  typeof source.recordId==='string'&&typeof source.fileId==='string'&&typeof source.fileName==='string' && source.fileName.length<=500 &&
  validPdfCoordinates(source.rects,4,500)
 );
}

async function openPdfEvidence(file,page,rects=[]){
 if($('reader').open){
  const closed=new Promise(resolve=>$('reader').addEventListener('close',resolve,{once:true}));
  $('reader').close();await closed;
 }
 await openAttachment(file);
 if(readingSession?.file.id!==file.id)return;
 await readingSession.showPage(page);
 const box=$('pdfScroll')?.querySelector('[data-pdf-page="'+page+'"]');
 if(!box||!rects.length)return;
 const layer=document.createElement('div');layer.className='pdf-note-source-focus';
 layer.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:5';
 for(const [x,y,w,h] of rects){
  const mark=document.createElement('span');
  mark.style.cssText='position:absolute;border:2px solid #087c79;background:#48c0ab30;left:'+x*100+'%;top:'+y*100+'%;width:'+w*100+'%;height:'+h*100+'%';
  layer.append(mark);
 }
 box.append(layer);
 layer.firstElementChild?.scrollIntoView({block:'center',inline:'nearest'});
 setTimeout(()=>layer.remove(),6000);
}

async function savePdfExcerpt(session,picked){
 const owner=records.find(note=>note.attachments?.some(file=>file.id===session.file.id));
 if(!owner)throw new Error('请先把 PDF 保存到当前工作台。');
 if(!picked?.quote&&!picked?.image)throw new Error('请先选中文字或框选图表。');
 const profileId=session.profileId;
 const note={
  id:crypto.randomUUID(),type:'paper',title:(owner.title+' · 第 '+picked.page+' 页摘录').slice(0,240),
  body:['出处：'+owner.title+' · '+session.file.name+' · 第 '+picked.page+' 页',picked.quote].filter(Boolean).join('\n\n'),
  tags:['PDF 摘录'],date:today(),status:statusOptions.paper[0],pinned:false,
  relatedResources:owner.type==='resource'?[owner.id]:[],
  pdfSource:{recordId:owner.id,fileId:session.file.id,fileName:session.file.name,page:picked.page,rects:picked.rects??[]},
  attachments:[]
 };
 const writes=[];
 if(picked.image){
  const id=crypto.randomUUID();
  note.attachments.push({id,name:'第 '+picked.page+' 页图表.png',mime:'image/png',size:picked.image.size,addedAt:new Date().toISOString()});
  writes.push({key:fileKey(profileId,id),blob:picked.image});
  note.bodyHtml='<p>'+esc(note.body)+'</p><span class="inline-media" data-image-id="'+id+'" data-width="85" data-align="center"></span>';
 }
 if(profileId!==appState.activeId)throw new Error('工作台已切换。');
 await put(note,writes);
 const notice=()=>showDetail(note.id);
 toast('摘录已保存为研究笔记',{label:'打开笔记',run:notice});
}

async function savePdfChartRegion(session,box,[x,y,w,h],page){
 const source=box.querySelector('canvas');
 if(!source||w<.008||h<.008)return;
 const width=source.width*w,height=source.height*h,scale=Math.min(1,2200/Math.max(width,height));
 const crop=document.createElement('canvas');
 crop.width=Math.max(1,Math.round(width*scale));crop.height=Math.max(1,Math.round(height*scale));
 crop.getContext('2d').drawImage(source,source.width*x,source.height*y,width,height,0,0,crop.width,crop.height);
 const image=await new Promise(resolve=>crop.toBlob(resolve,'image/png'));
 if(!image)throw new Error('无法截取图表。');
 if(readingSession!==session)return;
 await savePdfExcerpt(session,{page,rects:[[x,y,w,h]],image});
}

function renderPdfSourceLinks(note){
 const body=$('detailContent');
 const source=note.pdfSource;
 for(const source of [note.pdfSource,...(note.pdfEvidence||[])].filter(source=>source&&validPdfNoteSource(source))){
  const button=document.createElement('button');
  button.type='button';button.className='secondary';
  button.textContent='打开 '+source.fileName+' · 第 '+source.page+' 页';
  button.onclick=async()=>{
   const file=records.find(record=>record.id===source.recordId)?.attachments?.find(item=>item.id===source.fileId);
   if(!file){toast('原 PDF 已移除：'+source.fileName);return;}
   try{await openPdfEvidence(file,source.page,source.rects);}catch(error){toast(error.message);}
  };
  body.append(button);
 }
 if(!source&&!note.pdfEvidence?.length&&note.researchLinks===undefined)return;
 const select=document.createElement('select'),label=document.createElement('label');
 label.textContent='关联设计问题或仿真记录 ';
 select.add(new Option('选择记录…',''));
 const linked=new Set(note.researchLinks||[]);
 for(const item of records.filter(item=>['issue','study','journal'].includes(item.type)&&item.id!==note.id&&!linked.has(item.id))){
  select.add(new Option(item.title,item.id));
 }
 label.append(select);body.append(label);
 for(const id of linked){
  const target=records.find(item=>item.id===id);
  if(!target)continue;
  const jump=document.createElement('button'),remove=document.createElement('button');
  jump.type=remove.type='button';jump.textContent=target.title;remove.textContent='取消关联';
  jump.onclick=()=>showDetail(id);remove.onclick=()=>save([...linked].filter(value=>value!==id));
  body.append(jump,remove);
 }
 const save=async links=>{
  const latest=records.find(item=>item.id===note.id);
  if(!latest)return;
  try{await put({...latest,researchLinks:links});showDetail(note.id);}
  catch(error){toast(error.message);}
 };
 select.onchange=()=>{if(select.value)void save([...linked,select.value]);};
}
