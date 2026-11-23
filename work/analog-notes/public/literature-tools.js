'use strict';
for(const id of ['literatureDialog','literatureMatrix'])$(id).querySelector('[data-close]').onclick=()=>$(id).close();
const LITERATURE_FIELDS={doi:'DOI',publication:'期刊 / 会议',year:'出版年份',abstract:'摘要',translatedTitle:'标题译文',translatedAbstract:'摘要译文'};
const LITERATURE_LIMITS={doi:250,publication:300,year:4,abstract:12000,translatedTitle:2000,translatedAbstract:16000,needsReview:1};
function validLiteratureData(data){
 return data===undefined||(data&&typeof data==='object'&&!Array.isArray(data)&&Object.entries(data).every(([key,value])=>Object.hasOwn(LITERATURE_LIMITS,key)&&typeof value==='string'&&value.length<=LITERATURE_LIMITS[key]));
}
function literatureDoi(text){return text.match(/10\.\d{4,9}\/[\-._;()/:a-z0-9]+/i)?.[0].replace(/[.,;]+$/,'')||''}
function plainLiteratureText(text){
 const documentText=new DOMParser().parseFromString(String(text||''),'text/xml');
 return (documentText.querySelector('parsererror')?String(text||'').replace(/<[^>]*>/g,' '):documentText.documentElement.textContent).replace(/\s+/g,' ').trim();
}
function crossrefLiterature(item){
 return {title:item.title?.[0]||'',author:(item.author||[]).map(a=>a.name||[a.given,a.family].filter(Boolean).join(' ')).filter(Boolean).join('、'),
  doi:item.DOI||'',publication:item['container-title']?.[0]||'',year:String(item.issued?.['date-parts']?.[0]?.[0]||''),abstract:plainLiteratureText(item.abstract)};
}
const literatureRecognitionQueue=[];
let literatureRecognitionRunning=false;
function queueLiteratureRecognition(notes,profile){
 for(const note of notes)if(note.attachments?.some(fileIsPdf))literatureRecognitionQueue.push({id:note.id,profile});
 if(!literatureRecognitionRunning)void runLiteratureRecognition();
}
async function runLiteratureRecognition(){
 literatureRecognitionRunning=true;
 let completed=0,pending=0;
 const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 try{while(literatureRecognitionQueue.length){
  while($('importResources').disabled)await new Promise(resolve=>setTimeout(resolve,500));
  const {id,profile}=literatureRecognitionQueue.shift();
  if(profile!==appState.activeId)continue;
  const note=records.find(n=>n.id===id),file=note?.attachments?.find(fileIsPdf);
  if(!file||file.size>24*1024**2)continue;
  let task;
  try{
   const lib=await pdfLibrary(),blob=await readBlob(file.id,profile);
   task=await localPdfTask(lib,blob);
   const pdf=await task.promise,{info}=await pdf.getMetadata(),page=await pdf.getPage(1),content=await page.getTextContent();
   const title=String(info.Title||note.title).trim(),doi=literatureDoi(content.items.map(i=>i.str).join(' '));
   const url=doi?'https://api.crossref.org/works/'+encodeURIComponent(doi):'https://api.crossref.org/works?'+new URLSearchParams({'query.title':title,rows:'5'});
   const response=await fetch(url,{signal:AbortSignal.timeout(15000),credentials:'omit'});
   if(!response.ok)throw new Error('查询失败');
   const data=(await response.json()).message,candidates=(doi?[data]:data.items||[]).map(crossrefLiterature);
   const match=candidates.find(c=>normalize(c.title).length>15&&normalize(c.title)===normalize(title));
   while((workspaceEditorActive()||$('importResources').disabled)&&appState.activeId===profile)await new Promise(resolve=>setTimeout(resolve,1000));
   const latest=records.find(n=>n.id===id);
   if(appState.activeId!==profile||!latest||latest.updatedAt!==note.updatedAt){pending++;continue}
   if(!match){
    if(!latest.author&&!latest.literature?.needsReview){
     await put({...latest,literature:{...latest.literature,needsReview:'1'}});
    }
    pending++;continue
   }
   const {title:matchedTitle,author,...literature}=match;
   const updatedLiterature={...latest.literature,...literature};
   delete updatedLiterature.needsReview;
   await put({...latest,title:matchedTitle,author:author||latest.author,literature:updatedLiterature,reference:[literature.publication,literature.year].filter(Boolean).join(' · ')||latest.reference});
   completed++;
  }catch{pending++}finally{await task?.destroy().catch(()=>{})}
 }}
 finally{literatureRecognitionRunning=false;if(completed||pending){render();toast('文献自动匹配：已补全 '+completed+' 份，'+pending+' 份请在「补全资料 / 翻译」中核对。')}}
}
function openLiteratureDialog(note){
 const dialog=$('literatureDialog'),form=$('literatureForm'),message=$('literatureMessage'),results=$('literatureCandidates');
 let matchedFile=null;
 const profile=appState.activeId,controller=new AbortController(),{signal}=controller;
 const fields={title:'标题',author:'作者',...LITERATURE_FIELDS};
 const get=key=>form.elements.namedItem(key);
 $('literatureFields').innerHTML=Object.entries(fields).map(([key,label])=>{
  const limit=LITERATURE_LIMITS[key]||(key==='title'?240:200);
  return '<div class="field"><label for="literature-'+key+'">'+label+'</label>'+(/abstract/i.test(key)?'<textarea rows="4"':'<input type="text"')+' id="literature-'+key+'" name="'+key+'" maxlength="'+limit+'" '+(key==='title'?'required':'')+'>' + (/abstract/i.test(key)?'</textarea>':'')+'</div>';
 }).join('');
 const fill=(data,overwrite=false)=>{
  for(const key of Object.keys(fields)){
   if(data[key]&&(overwrite||!get(key).value))get(key).value=String(data[key]).slice(0,get(key).maxLength);
  }
 };
 fill({...note.literature,title:note.title,author:note.author,doi:note.literature?.doi||literatureDoi(note.url||'')},true);
 results.replaceChildren();message.textContent='';
 const matchInput=$('literatureMatchInput'),matches=$('literatureMatches');matchInput.value='';matches.replaceChildren();
 $('literatureMatchTools').hidden=note.type!=='resource'||!!note.webArticle;
 $('literatureMatch').onclick=()=>matchInput.click();
 matchInput.onchange=()=>{
  const normalize=value=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const title=normalize(get('title').value),author=normalize(get('author').value.split(/[、,，]/)[0]);
  matchedFile=null;matches.replaceChildren();
  const candidates=[...matchInput.files].filter(file=>/\.pdf$/i.test(file.name)&&file.size>0&&file.size<=MAX_FILE).filter(file=>{
   const name=normalize(file.name.replace(/\.pdf$/i,''));
   return title&&(name===title||author&&name===title+author||title.length>=6&&name.includes(title));
  });
  for(const file of candidates.slice(0,12)){
   const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=file.webkitRelativePath||file.name;
   button.onclick=()=>{matchedFile=file;message.textContent='已选 '+file.name+'，保存时复制到资料库。'};
   matches.append(button);
  }
  message.textContent=candidates.length?'请选择匹配的 PDF，再保存文献信息。':'此文件夹没有匹配的 PDF。';
 };$('literaturePdf').disabled=!note.attachments?.some(fileIsPdf);
 dialog.addEventListener('close',()=>controller.abort(),{once:true});
 const action=async (button,work)=>{
  if(form.dataset.working==='true')return;
  form.dataset.working='true';button.disabled=true;
  try{await work()}catch(error){if(!signal.aborted)message.textContent=error.message}
  finally{delete form.dataset.working;button.disabled=false}
 };
 $('literaturePdf').onclick=e=>action(e.currentTarget,async()=>{
  const file=note.attachments.find(fileIsPdf),library=await pdfLibrary(),blob=await readBlob(file.id,profile);
  const task=await localPdfTask(library,blob,signal);
  try{
   const pdf=await task.promise,{info}=await pdf.getMetadata(),page=await pdf.getPage(1),text=await page.getTextContent();
   if(signal.aborted)return;
   fill({title:info.Title,author:info.Author,doi:literatureDoi(text.items.map(item=>item.str).join(' '))},false);
   if(info.Title&&get('title').value===file.name.replace(/\.pdf$/i,''))get('title').value=info.Title.slice(0,240);
   message.textContent='已读取 PDF 内嵌信息，请核对后保存。';
  }finally{await task.destroy()}
 });
 $('literatureLookup').onclick=e=>action(e.currentTarget,async()=>{
  const doi=literatureDoi(get('doi').value),title=get('title').value.trim();
  if(get('doi').value.trim()&&!doi)throw new Error('请检查 DOI 格式。');
  if(!doi&&!title)throw new Error('请输入标题或 DOI。');
  results.replaceChildren();message.textContent='正在查询 Crossref…';
  const url=doi?'https://api.crossref.org/works/'+encodeURIComponent(doi):'https://api.crossref.org/works?'+new URLSearchParams({'query.title':title,rows:'5'});
  const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),credentials:'omit'});
  if(response.status===404)throw new Error('Crossref 未找到该 DOI。');
  if(!response.ok)throw new Error('Crossref 查询暂不可用。');
  const data=(await response.json()).message,candidates=(doi?[data]:data.items||[]).map(crossrefLiterature).filter(item=>item.title);
  if(signal.aborted)return;
  for(const item of candidates){
   const button=document.createElement('button');button.type='button';button.className='secondary';
   button.textContent=[item.title,item.author,item.publication,item.year].filter(Boolean).join(' · ');
   button.onclick=()=>{fill(item,true);message.textContent='已填入候选资料，保存前可以修改。'};
   results.append(button);
  }
  message.textContent=candidates.length?'请选择匹配条目。':'未找到匹配条目，可手动填写。';
 });
 for(const [buttonId,key,target] of [['translateLiteratureTitle','title','translatedTitle'],['translateLiteratureAbstract','abstract','translatedAbstract']]){
  $(buttonId).onclick=e=>action(e.currentTarget,async()=>{
   const text=get(key).value.trim(),source=$('literatureSource').value,targetLang=$('literatureTarget').value;
   if(!text)throw new Error('请先填写'+fields[key]+'。');
   if(source===targetLang)throw new Error('请选择不同的源语言和目标语言。');
   if([...text].length>5000)throw new Error('每次在线翻译最多 5,000 字符。');
   const translated=await translatePdfOnline(text,source,targetLang,signal,(i,total)=>{message.textContent='正在翻译 '+i+' / '+total+'…'});
   if(signal.aborted)return;
   get(target).value=translated.slice(0,LITERATURE_LIMITS[target]);message.textContent='译文已填入，保存前可以修改。';
  });
 }
 form.onsubmit=async e=>{
  e.preventDefault();if(form.dataset.working==='true')return;
  await action($('literatureSave'),async()=>{
   const latest=records.find(n=>n.id===note.id&&n.type===note.type);
   if(profile!==appState.activeId||!latest)throw new Error('原资料已变化，请重新打开详情。');
   const literature=Object.fromEntries(Object.keys(LITERATURE_FIELDS).map(key=>[key,get(key).value.trim()]));
   if(literature.doi){literature.doi=literatureDoi(literature.doi);if(!literature.doi)throw new Error('请检查 DOI 格式。')}
   if(literature.year&&!/^\d{4}$/.test(literature.year))throw new Error('出版年份须为四位数字。');
   const title=get('title').value.trim(),author=get('author').value.trim();
   const reference=[literature.publication,literature.year].filter(Boolean).join(' · ')||latest.reference;
   const saved={...latest,literature,title,author,reference,url:latest.url||(literature.doi?'https://doi.org/'+literature.doi:'')};
   if(!validate(saved))throw new Error('请检查标题和文献资料。');
   const writes=[];
   if(matchedFile&&!latest.attachments?.some(a=>a.name===matchedFile.name&&a.size===matchedFile.size)){
    const attachment={id:crypto.randomUUID(),name:matchedFile.name,size:matchedFile.size,mime:'application/pdf',addedAt:new Date().toISOString()};
    saved.attachments=[...(latest.attachments||[]),attachment];
    writes.push({key:fileKey(profile,attachment.id),blob:matchedFile});
   }
   await put(saved,writes);dialog.close();render();showDetail(note.id);
  });
 };
 dialog.showModal();
}
function renderLiteratureDetails(note){
 if(!['resource','paper'].includes(note.type))return;
 const section=document.createElement('section');section.className='inline-note-links';
 section.innerHTML='<h3>文献信息</h3>'+Object.entries(LITERATURE_FIELDS).filter(([key])=>note.literature?.[key]).map(([key,label])=>'<p class="literature-text"><strong>'+label+'</strong><br>'+esc(note.literature[key])+'</p>').join('');
 const controls=document.createElement('div');controls.className='library-controls citation-tools';
 const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='补全资料 / 翻译';edit.onclick=()=>openLiteratureDialog(note);controls.append(edit);
 installCitationButton(controls,note);section.append(controls);
 $('detailContent').append(section);
}
$('openLiteratureMatrix').onclick=async()=>{
 const dialog=$('literatureMatrix'),output=$('literatureMatrixContent'),profile=appState.activeId;
 const ids=selectedLibraryIds.size?[...selectedLibraryIds]:visibleLibraryIds;
 const notes=ids.map(id=>records.find(n=>n.id===id)).filter(Boolean);
 output.textContent='正在读取批注…';dialog.showModal();
 const rows=[];
 for(const note of notes.slice(0,100)){
  if(!dialog.open||profile!==appState.activeId)return;
  const entries=(note.webAnnotations||[]).filter(mark=>mark.note||mark.quote).map(mark=>({mark}));
  for(const file of (note.attachments||[]).filter(fileIsPdf)){
   try{for(const mark of await fileAnnotations(profile,file))if(mark.quote||mark.note)entries.push({mark,file})}
   catch(error){entries.push({mark:{note:'批注读取失败：'+error.message}})}
  }
  rows.push({note,entries});
 }
 if(!dialog.open||profile!==appState.activeId)return;
 output.innerHTML='<p class="tiny">'+(notes.length>100?'显示前 100 份，缩小筛选范围可查看更多。':'共 '+notes.length+' 份资料')+'</p>';
 if(!rows.length){output.append('当前范围没有资料。');return}
 for(const {note,entries} of rows){
  const block=document.createElement('details');block.className='literature-matrix-entry';
  block.innerHTML='<summary>'+esc(note.title)+' · '+entries.length+' 条批注</summary><p class="tiny">'+esc([note.author,note.literature?.publication,note.literature?.year,note.status].filter(Boolean).join(' · '))+'</p>';
  const detail=document.createElement('button');detail.type='button';detail.className='secondary';detail.textContent='查看详情';detail.onclick=()=>{dialog.close();showDetail(note.id)};block.append(detail);
  for(const {mark,file} of entries){
   const row=document.createElement('p');row.className='literature-text';
   if(file){const source=document.createElement('button');source.type='button';source.className='pdf-note-link';source.textContent=file.name+' · 第 '+mark.page+' 页';source.onclick=async()=>{dialog.close();await openAttachment(file);if(readingSession?.file.id===file.id)await readingSession.showPage?.(mark.page)};row.append(source,document.createElement('br'))}
   row.append([mark.quote,mark.note].filter(Boolean).join('\n'));block.append(row);
  }
  output.append(block);
 }
};
