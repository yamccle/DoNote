/**
 * [INPUT]: 读取当前阅读会话的批注数组、原始 PDF Blob 与 PDFLib。
 * [OUTPUT]: 提供 exportAnnotatedPdf 与 bindPdfAnnotationExports（JSON 导出/恢复与带批注 PDF 副本导出）。
 * [POS]: 挂载在批注面板底部折叠抽屉中，提供可校验的批注迁移与分享副本。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

async function exportAnnotatedPdf(session, status) {
 const source=await readBlob(session.file.id,session.profileId);
 if(source.size>256*1024**2)throw new Error('批注 PDF 副本支持 256 MiB 以内的文档。大文件请导出可校验的批注 JSON。');
 const marks=checkedAnnotations(session.annotations);
 const {PDFDocument,PDFName,PDFString,PDFHexString,PDFArray}=PDFLib;
 const document=await PDFDocument.load(await source.arrayBuffer(),{updateMetadata:false});
 const names={highlight:'Highlight',underline:'Underline',strike:'StrikeOut',comment:'Text',rect:'Square',pen:'Ink',text:'FreeText',bookmark:'Text',translation:'Text'};
 for(const pageNumber of new Set(marks.map(mark=>mark.page))){
  const page=document.getPage(pageNumber-1);
  const viewport=(await session.pdf.getPage(pageNumber)).getViewport({scale:1});
  const point=(x,y)=>viewport.convertToPdfPoint(x*viewport.width,y*viewport.height);
  const corners=([x,y,w,h])=>[point(x,y),point(x+w,y),point(x,y+h),point(x+w,y+h)];
  let annots=page.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  if(!annots){annots=document.context.obj([]);page.node.set(PDFName.of('Annots'),annots);}
  for(const mark of marks.filter(item=>item.page===pageNumber)){
   const ink=mark.points.map(([x,y])=>point(x,y));
   const quads=mark.rects.map(corners);
   const points=ink.length?ink:quads.length?quads.flat():corners([.02,.02,.035,.035]);
   const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
   const rect=[Math.min(...xs)-1,Math.min(...ys)-1,Math.max(...xs)+1,Math.max(...ys)+1];
   const color=mark.color.match(/[a-f0-9]{2}/gi).map(v=>parseInt(v,16)/255);
   const subtype=names[mark.kind];
   const values={
    Type:PDFName.of('Annot'),Subtype:PDFName.of(subtype),Rect:rect,C:color,F:4,
    NM:PDFString.of(mark.id),Contents:PDFHexString.fromText([mark.note,mark.quote].filter(Boolean).join('\n\n')||PDF_ANNOTATION_LABELS[mark.kind]),
    T:PDFHexString.fromText('DoNote')
   };
   if(quads.length&&['Highlight','Underline','StrikeOut'].includes(subtype))values.QuadPoints=quads.flat(2);
   if(ink.length)values.InkList=[ink.flat()];
   if(subtype==='FreeText')values.DA=PDFString.of('/Helv 12 Tf 0 g');
   annots.push(document.context.register(document.context.obj(values)));
  }
  status.textContent='正在导出批注 · 第 '+pageNumber+' 页';
 }
 const bytes=await document.save();
 const verified=await PDFDocument.load(bytes,{updateMetadata:false});
 if(verified.getPageCount()!==session.pdf.numPages)throw new Error('副本页数校验失败。');
 const ids=new Set();
 for(const number of new Set(marks.map(mark=>mark.page))){
  const page=verified.getPage(number-1),annots=page.node.lookup(PDFName.of('Annots'),PDFArray);
  for(let i=0;i<annots.size();i++){
   const id=annots.lookup(i).get?.(PDFName.of('NM'));
   if(id?.decodeText)ids.add(id.decodeText());
  }
 }
 if(marks.some(mark=>!ids.has(mark.id)))throw new Error('副本批注校验失败。');
 downloadBlob(session.file.name.replace(/\.pdf$/i,'')+'-带批注.pdf',new Blob([bytes],{type:'application/pdf'}));
}

function bindPdfAnnotationExports(session){
 const exportMarks=$('exportPdfMarks');
 const status=$('markSaveStatus');
 const copy=document.createElement('button');
 copy.type='button';copy.className='secondary';copy.textContent='导出带批注 PDF';exportMarks.after(copy);
 exportMarks.onclick=async()=>{
  exportMarks.disabled=true;
  try{
   const annotations=checkedAnnotations(session.annotations);
   const payload={format:'analog-pdf-annotations',version:2,file:session.file.name,
    sourceSha256:await fileDigest(await readBlob(session.file.id,session.profileId)),annotations};
   downloadBlob(session.file.name+'.annotations.json',new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
   status.textContent='批注已导出，含原 PDF 的 SHA-256 校验值。';
  }catch(error){status.textContent='导出失败：'+error.message;}
  finally{exportMarks.disabled=false;}
 };
 copy.onclick=async()=>{
  copy.disabled=true;status.textContent='正在准备 PDF 副本…';
  try{await exportAnnotatedPdf(session,status);status.textContent='带批注的 PDF 副本已导出并通过校验。';}
  catch(error){status.textContent='导出失败：'+error.message;}
  finally{copy.disabled=false;}
 };
 const restore=document.createElement('button'),input=document.createElement('input');
 restore.type='button';restore.className='secondary';restore.textContent='恢复批注 JSON';
 input.type='file';input.accept='.json';input.hidden=true;
 copy.after(restore,input);
 restore.onclick=()=>input.click();
 input.onchange=async()=>{
  const file=input.files[0];input.value='';
  if(!file)return;
  restore.disabled=true;
  try{
   if(file.size>32*1024**2)throw new Error('批注文件过大。');
   const data=JSON.parse(await file.text());
   if(data.format!=='analog-pdf-annotations'||data.version!==2)throw new Error('请选择含原文校验值的批注 JSON。');
   const incoming=checkedAnnotations(data.annotations);
   if(incoming.some(mark=>mark.page>session.pdf.numPages))throw new Error('批注页码超出文档范围。');
   if(await fileDigest(await readBlob(session.file.id,session.profileId))!==data.sourceSha256)throw new Error('批注对应的 PDF 与当前文件不同。');
   if(readingSession!==session)return;
   const merged=new Map(session.annotations.map(mark=>[mark.id,mark]));
   for(const mark of incoming)if(!merged.has(mark.id))merged.set(mark.id,mark);
   session.annotations=checkedAnnotations([...merged.values()]);
   await savePdfMarks(session);renderPdfSidebar(session);renderPdfMarks(session);
  }catch(error){status.textContent='恢复失败：'+error.message;}
  finally{restore.disabled=false;}
 };
}
