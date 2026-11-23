'use strict';
// 大批量导入时的进度面板：显示已处理数量、当前文件与可取消按钮。
let importProgressDialog=null,importProgressCancel=false;
function ensureImportProgressDialog(){
 if(importProgressDialog&&importProgressDialog.isConnected)return importProgressDialog;
 const dialog=document.createElement('dialog');dialog.id='importProgressDialog';dialog.className='compact-dialog';dialog.setAttribute('aria-labelledby','importProgressTitle');
 dialog.innerHTML='<div class="modalhead"><h2 id="importProgressTitle">正在导入资料</h2></div><div class="modalbody"><p id="importProgressText" class="section-note" role="status">准备中…</p><div class="import-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="importProgressBar" style="width:0%"></i></div><p id="importProgressCurrent" class="tiny"></p></div><div class="modalfoot"><span class="tiny" id="importProgressHint">导入期间请勿关闭窗口</span><div class="right"><button type="button" class="secondary" id="importProgressCancel">取消导入</button></div></div>';
 document.body.append(dialog);
 $('importProgressCancel').onclick=()=>{
  if(importProgressCancel)return;
  importProgressCancel=true;
  $('importProgressCancel').disabled=true;
  $('importProgressCancel').textContent='正在停止…';
  $('importProgressHint').textContent='会在当前这一批完成后停止，已导入的资料会保留';
 };
 dialog.addEventListener('cancel',event=>event.preventDefault());
 importProgressDialog=dialog;
 return dialog;
}
function startImportProgress(message='正在读取文件…'){
 importProgressCancel=false;
 const dialog=ensureImportProgressDialog();
 $('importProgressTitle').textContent='正在导入资料';
 $('importProgressText').textContent=message;
 $('importProgressCurrent').textContent='';
 $('importProgressHint').textContent='导入期间请勿关闭窗口';
 $('importProgressCancel').hidden=false;
 $('importProgressCancel').disabled=false;
 $('importProgressCancel').textContent='取消导入';
 setImportProgress(0,0);
 if(!dialog.open)dialog.showModal();
}
function setImportProgress(done,total,current){
 const dialog=importProgressDialog;if(!dialog)return;
 const percent=total?Math.min(100,Math.round(done/total*100)):0;
 const bar=$('importProgressBar');
 if(bar)bar.style.width=percent+'%';
 const wrap=dialog.querySelector('.import-progress');
 if(wrap)wrap.setAttribute('aria-valuenow',String(percent));
 const text=$('importProgressText');
 if(text)text.textContent=total?'已处理 '+done+' / '+total+' 份（'+percent+'%）':'准备中…';
 const name=$('importProgressCurrent');
 if(name)name.textContent=current?('当前：'+current):'';
}
function importProgressRequested(){return importProgressCancel}
function finishImportProgress(message){
 const dialog=importProgressDialog;if(!dialog)return;
 if(message)$('importProgressText').textContent=message;
 $('importProgressCurrent').textContent='';
 $('importProgressHint').textContent='';
 $('importProgressCancel').hidden=true;
 const bar=$('importProgressBar');if(bar)bar.style.width='100%';
 setTimeout(()=>{if(dialog.open)dialog.close()},message?900:0);
}
