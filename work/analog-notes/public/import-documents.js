'use strict';
$('importExisting').onclick=()=>$('existingFileInput').click();
function attachmentFromFile(file){return {id:crypto.randomUUID(),name:file.name,size:file.size,mime:inferredMime(file),addedAt:new Date().toISOString()}}
function readXml(source){const doc=new DOMParser().parseFromString(source,'text/xml');if(doc.querySelector('parsererror'))throw new Error('文档内的 XML 格式无效。');return doc}
async function parseMarkdown(file,companions,attachments,writes,profileId){
 const text=await file.text();if(text.length>150000)throw new Error('Markdown 内容过长，请拆分后导入。');const root=document.createElement('template');root.innerHTML=marked.parse(text,{gfm:true,breaks:true});
 const saved=new Map();for(const img of root.content.querySelectorAll('img')){
  const src=img.getAttribute('src')||'',basename=decodeURIComponent(src.split('/').at(-1).split('?')[0]),match=companions.find(f=>f.name===basename&&fileIsImage({mime:f.type}));
  if(!match){const label=document.createElement('span');label.textContent='［图片：'+(img.getAttribute('alt')||src)+'，需附带原图导入］';img.replaceWith(label);continue}
  let a=saved.get(match.name);if(!a){if(match.size>MAX_FILE)throw new Error('图片过大：'+match.name);a=attachmentFromFile(match);a.inlineImage=true;attachments.push(a);writes.push({key:fileKey(profileId,a.id),blob:match});saved.set(match.name,a)}
  const slot=document.createElement('span');slot.dataset.imageId=a.id;slot.dataset.width='70';slot.dataset.align='center';img.replaceWith(slot);
 }
 return safeRichHtml(root.innerHTML);
}
const pptxExcerptIntros=[
 '已归档原始演示文稿。点击附件中的「预览 PPT」可逐页阅读。',
 '以下为 PPTX 中提取的文字和图片；原始排版请打开原件查看。',
 '以下为可编辑的文字和图片摘录。查看幻灯片原版式，请点击附件中的「预览 PPT」。'
];
function legacyPptxExcerpt(note){
 const file=note.attachments?.[0];
 return file&&/\.pptx$/i.test(file.name)&&pptxExcerptIntros.some(intro=>note.bodyHtml?.startsWith('<p>'+intro+'</p>'))?file:null;
}
async function hideLegacyPptxExcerpt(note,body,profileId){
 const file=legacyPptxExcerpt(note);if(!file)return;
 body.hidden=true;
 try{
  const zip=await JSZip.loadAsync(await readBlob(file.id,profileId));
  const slides=Object.keys(zip.files).filter(path=>/^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));
  const headings=[...body.children].filter(node=>node.tagName==='H2'&&/^第 (\d+) 页(?:文字摘录)?$/.test(node.textContent));
  for(const heading of headings){
   const number=Number(heading.textContent.match(/\d+/)[0]),path=slides[number-1];
   if(!path)continue;
   const doc=readXml(await zip.file(path).async('string'));
   const originals=[...doc.getElementsByTagName('a:p')].map(p=>[...p.getElementsByTagName('a:t')].map(node=>node.textContent).join('')).filter(Boolean);
   const remaining=new Map();
   for(const text of originals)remaining.set(text,(remaining.get(text)||0)+1);
   // Remove only paragraphs still matching the source slide. Edits and added notes stay visible.
   for(let node=heading.nextElementSibling;node&&node.tagName!=='H2';){
    const next=node.nextElementSibling,text=node.textContent,count=remaining.get(text);
    if(node.tagName==='P'&&node.children.length===0&&count){node.remove();remaining.set(text,count-1)}
    node=next;
   }
   heading.remove();
  }
  body.firstElementChild?.remove();
 }catch{
  const disclosure=document.createElement('details'),label=document.createElement('summary');
  label.textContent='查看旧导入正文';disclosure.append(label,...body.childNodes);body.append(disclosure);
 }finally{body.hidden=false}
}
function fileIsDocx(file){return /\.docx$/i.test(file.name)||file.mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
async function readDocxHtml(file){
 const zip=await JSZip.loadAsync(file),entry=zip.file('word/document.xml');
 if(!entry)throw new Error('找不到 DOCX 正文。');
 const doc=readXml(await entry.async('string')),ns=doc.documentElement.namespaceURI;
 const body=doc.getElementsByTagNameNS(ns,'body')[0];
 if(!body)throw new Error('找不到 DOCX 正文。');
 const text=node=>[...node.getElementsByTagNameNS(ns,'t')].map(run=>run.textContent).join('');
 let html='';
 for(const node of body.children){
  if(node.localName==='p')html+='<p>'+esc(text(node))+'</p>';
  if(node.localName==='tbl'){
   const rows=[...node.children].filter(row=>row.localName==='tr');
   html+='<table><tbody>'+rows.map(row=>'<tr>'+[...row.children].filter(cell=>cell.localName==='tc').map(cell=>'<td>'+[...cell.getElementsByTagNameNS(ns,'p')].map(p=>esc(text(p))).join('<br>')+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
  }
  if(html.length>120000)throw new Error('DOCX 正文过长，可从附件打开原件。');
 }
 return safeRichHtml(html);
}
$('existingFileInput').onchange=async e=>{
 const all=[...e.target.files],documents=all.filter(f=>/\.(docx|md|markdown|ppt|pptx|pdf|mp4|mp3)$/i.test(f.name));
 if(!documents.length){if(all.length)toast('请选择 DOCX、PPT、PPTX、PDF、MD、MP4 或 MP3 文件。');e.target.value='';return}
 $('importExisting').disabled=true;
 try{
  const type=activeCategory(view)?view:defaultRecordType(),next=structuredClone(appState),p=next.profiles.find(p=>p.id===next.activeId),writes=[];
  if(documents.some(f=>f.size>MAX_FILE))throw new Error('单个文件不能超过 2 GB。');
  for(const file of documents){const original=attachmentFromFile(file),attachments=[original];writes.push({key:fileKey(p.id,original.id),blob:file});let html='';
   if(/\.(md|markdown)$/i.test(file.name)&&file.size<=600000)html=await parseMarkdown(file,all,attachments,writes,p.id);
   else if(fileIsDocx(original)&&!requiresExternalReader(original))html=await readDocxHtml(file).catch(()=> '');
   const note=normalizeRichNote({id:crypto.randomUUID(),type,title:file.name.replace(/\.[^.]+$/,'').slice(0,240)||'导入整理',date:today(),body:'',bodyHtml:html,author:'',reference:'',url:'',status:statusOptions[type][0],tags:['导入整理'],journalKind:'daily',pinned:false,attachments,updatedAt:new Date().toISOString()});
   if(note.type==='plan'){note.planStart=today();note.planEnd=planEndFor(note.planStart,'week')}
   if(attachments.length>MAX_ATTACHMENTS||!validate(note))throw new Error('导入内容或附件过多，请拆分文件。');p.records.push(assignDefaultFolder(note));
  }
  await commitState(next,writes);render();toast('已导入 '+documents.length+' 份整理，保留原件并可继续编辑');
 }catch(error){toast('导入未完成，原记录未修改。'+error.message)}finally{e.target.value='';$('importExisting').disabled=false}
};
