/**
 * [INPUT]: 读取已授权的备份目标、保留策略和本机备份写入接口。
 * [OUTPUT]: 配置目标与保留份数、上传当前工作台并自动清理旧快照、下载并校验历史备份。
 * [POS]: 云端备份窗口。恢复沿用本地资料导入入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
 const host=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
 const writer=window.desktopLargeBackup;
 if(host&&writer){
  const localRestore=$('restoreLargeBackupFolder');
  const opener=document.createElement('button');
  opener.id='cloudBackupOpen';opener.type='button';opener.className='secondary backup-cloud-btn';
  opener.textContent='云端备份';
  const cloudSlot=$('cloudBackupSlot');
  if(cloudSlot)cloudSlot.append(opener);
  else (localRestore||$('writeFolder')).after(opener);
  document.body.insertAdjacentHTML('beforeend',`
   <dialog id="cloudBackupDialog" aria-labelledby="cloudBackupTitle">
    <div class="modalhead"><h2 id="cloudBackupTitle">云端备份</h2><button class="icon-button" data-close="cloudBackupDialog" aria-label="关闭">✕</button></div>
    <div class="modalbody">
     <details id="cloudBackupTarget">
      <summary>备份目标</summary>
      <form id="cloudBackupForm">
       <div class="field"><label for="cloudBackupMode">连接方式</label><select id="cloudBackupMode"><option value="folder">Google Drive 桌面版同步目录</option><option value="webdav">WebDAV</option></select></div>
       <div id="cloudBackupFolderFields">
        <p class="section-note">先在 Google Drive 桌面版登录，再选「我的云端硬盘」下的备份文件夹。</p>
        <div class="field"><label for="cloudBackupFolder">备份文件夹</label><input id="cloudBackupFolder" readonly placeholder="尚未选择文件夹"></div>
        <button type="button" class="secondary" id="cloudBackupChoose">选择文件夹…</button>
       </div>
       <div id="cloudBackupDavFields" hidden>
        <div class="field"><label for="cloudBackupUrl">WebDAV 文件夹地址</label><input id="cloudBackupUrl" type="url" spellcheck="false" placeholder="https://example.com/dav/"></div>
        <div class="field-row">
         <div class="field"><label for="cloudBackupUser">用户名</label><input id="cloudBackupUser" autocomplete="off"></div>
         <div class="field"><label for="cloudBackupPassword">密码</label><input id="cloudBackupPassword" type="password" autocomplete="off"></div>
        </div>
        <label id="cloudBackupClearRow" hidden><input id="cloudBackupClearPassword" type="checkbox"> 清除已保存的密码</label>
       </div>
       <div class="field"><label for="cloudBackupKeep">保留版本数</label><select id="cloudBackupKeep"><option value="0">保留全部历史版本</option><option value="3">保留最近 3 份</option><option value="5">保留最近 5 份</option><option value="10">保留最近 10 份</option><option value="20">保留最近 20 份</option></select></div>
       <button type="submit" class="primary" id="cloudBackupSave">保存并检查</button>
      </form>
     </details>
     <p id="cloudBackupSummary" class="section-note"></p>
     <div class="library-controls">
      <button type="button" class="primary" id="cloudBackupRun" disabled>备份当前工作台</button>
      <button type="button" class="secondary" id="cloudBackupRefresh" disabled>刷新备份列表</button>
     </div>
     <div class="field">
      <label for="cloudBackupList">历史备份</label>
      <select id="cloudBackupList" disabled><option value="">暂无可选备份</option></select>
     </div>
     <div class="library-controls">
      <button type="button" class="secondary" id="cloudBackupDownload" disabled>下载并校验…</button>
      <button type="button" class="secondary" id="cloudBackupRestore" hidden>恢复已下载备份…</button>
      <button type="button" class="secondary" id="cloudBackupCopyPath" hidden>复制恢复路径</button>
      <button type="button" class="secondary" id="cloudBackupCancel" hidden>取消当前任务</button>
     </div>
     <p class="section-note" id="cloudBackupDownloaded" hidden></p>
     <progress id="cloudBackupProgress" aria-label="云端备份进度" hidden></progress>
     <p id="cloudBackupMessage" class="form-message" role="status"></p>
    </div>
   </dialog>`);
  const dialog=$('cloudBackupDialog'),form=$('cloudBackupForm'),mode=$('cloudBackupMode');
  const fields=$('cloudBackupTarget'),folder=$('cloudBackupFolder'),url=$('cloudBackupUrl');
  const username=$('cloudBackupUser'),password=$('cloudBackupPassword'),keep=$('cloudBackupKeep'),list=$('cloudBackupList');
  const message=$('cloudBackupMessage'),progress=$('cloudBackupProgress');
  const pending=new Map();
  let settings=null,operation=false,trackTask=false,hadTransfer=false,cancellable=false,stopRequested=false,transferring=false,downloadedPath='';

  function setMessage(value,done,total){
   message.textContent=value;
   if(total>0){progress.max=total;progress.value=Math.min(done||0,total)}
   else progress.removeAttribute('value');
   if(window.DoNoteTasks&&trackTask&&value){
    const isSelectPrompt=/^请选择下载位置/.test(value);
    if(isSelectPrompt&&!hadTransfer)return;
    const pct=total>0?Math.round((Math.min(done||0,total)/total)*100):(/备份已写入同步目录|备份已上传到 WebDAV|备份已下载并通过校验/.test(value)?100:null);
    const isCancel=/^已取消|^正在取消/.test(value);
    const isDone=/备份已写入同步目录|备份已上传到 WebDAV|备份已下载并通过校验/.test(value);
    const isErr=!isCancel&&!isDone&&/失败|超时|无效|错误|不足|已切换/.test(value);
    window.DoNoteTasks.upsert('cloud-backup',{
     kind:'cloud',
     title:'云端快照备份',
     detail:value,
     percent:pct,
     state:isCancel&&!operation?'cancelled':isDone?'done':isErr?'error':operation?'running':'done',
     onCancel:operation&&cancellable&&!stopRequested?()=>$('cloudBackupCancel')?.click():null,
     onOpen:()=>{if(!dialog.open)dialog.showModal();}
    });
   }
  }
  function request(action,parameters={},long=false){
   const id=crypto.randomUUID();
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
     pending.delete(id);reject(new Error('响应超时。请检查云盘连接后重试。'));
    },long?24*60*60*1000:10*60*1000);
    pending.set(id,{timer,resolve,reject});
    host.postMessage({type:'cloud-backup',id,action,...parameters});
   });
  }
  host.addEventListener('message',event=>{
   const data=event.data,entry=pending.get(data?.id);
   if(!entry)return;
   if(data.type==='cloud-backup-progress'){if(!stopRequested)setMessage(data.message||'正在传输…',data.done,data.total);return;}
   if(data.type!=='cloud-backup-result')return;
   pending.delete(data.id);clearTimeout(entry.timer);
   if(data.error)entry.reject(new Error(data.error));
   else if(data.cancelled)entry.reject(new DOMException('已取消','AbortError'));
   else entry.resolve(data);
  });
  function configured(){return !!(settings?.mode==='webdav'?settings.url:settings?.folder)}
  function updateActions(){
   const available=configured()&&!operation;
   $('cloudBackupRun').disabled=$('cloudBackupRefresh').disabled=!available;
   list.disabled=!available||list.options.length<=1;
   $('cloudBackupDownload').disabled=!available||!list.value;
   $('cloudBackupRestore').disabled=operation;
   $('cloudBackupCancel').hidden=!cancellable;
   $('cloudBackupCancel').disabled=stopRequested;
   for(const element of form.elements)element.disabled=operation;
   updateMode();
   opener.textContent=operation?'云端备份 · 进行中':'云端备份';
  }
  function updateMode(){
   const dav=mode.value==='webdav';
   $('cloudBackupFolderFields').hidden=dav;
   $('cloudBackupDavFields').hidden=!dav;
   url.required=dav;
   url.disabled=operation||!dav;
  }
  function showSettings(value){
   settings=value||{};
   mode.value=settings.mode==='webdav'?'webdav':'folder';
   folder.value=settings.folder||'';url.value=settings.url||'';
   username.value=settings.username||'';password.value='';
   $('cloudBackupClearPassword').checked=false;
   password.placeholder=settings.hasPassword?'已保存，留空保留':'';
   $('cloudBackupClearRow').hidden=!settings.hasPassword;
   const keepCount=Number.isInteger(settings.keepCount)&&settings.keepCount>0?settings.keepCount:0;
   if(keepCount&&![...keep.options].some(option=>Number(option.value)===keepCount)){
    keep.add(new Option('保留最近 '+keepCount+' 份',String(keepCount)));
   }
   keep.value=String(keepCount);
   const retention=keepCount?' · 保留最近 '+keepCount+' 份':'';
   $('cloudBackupSummary').textContent=!configured()?'请选择备份目标。':settings.mode==='folder'
    ?'备份位置 · '+settings.folder+retention+'。写入后由 Google Drive 桌面版上传。'
    :'备份位置 · '+settings.url+retention;
   fields.open=!configured();
   updateMode();updateActions();
  }
  function showSnapshots(snapshots){
   list.replaceChildren(new Option(snapshots.length?'选择备份':'暂无可选备份',''));
   for(const {name} of snapshots)list.add(new Option(name.replace(/^DoNote-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/, '$1-$2-$3 $4:$5:$6 UTC · '),name));
   updateActions();
  }
  async function refresh(){
   const {snapshots}=await request('list');
   showSnapshots(snapshots||[]);
   return (snapshots||[]).length;
  }
  async function run(label,action,allowCancel=false){
   if(operation)return;
   if($('writeFolder').disabled){setMessage('请等待当前本地备份完成。');return;}
   operation=true;trackTask=allowCancel;hadTransfer=false;cancellable=allowCancel;stopRequested=false;
   $('writeFolder').disabled=true;progress.hidden=false;
   updateActions();setMessage(label);
   let runErr=null;
   try{await action()}catch(error){runErr=error;setMessage(error.name==='AbortError'?'已取消':error.message)}
   finally{
    const wasTracked=trackTask,didTransfer=hadTransfer,finalMsg=message.textContent.trim();
    operation=false;trackTask=false;hadTransfer=false;cancellable=false;transferring=false;
    $('writeFolder').disabled=false;progress.hidden=true;updateActions();
    if(wasTracked&&window.DoNoteTasks){
     const existing=window.DoNoteTasks.list?.().find(t=>t.id==='cloud-backup');
     if(runErr?.name==='AbortError'&&!didTransfer){
      window.DoNoteTasks.remove('cloud-backup');
     }else if(existing?.state==='running'){
      const done=/备份已写入同步目录|备份已上传到 WebDAV|备份已下载并通过校验/.test(finalMsg);
      const cancelled=runErr?.name==='AbortError'||/^已取消/.test(finalMsg);
      if(!finalMsg&&!runErr){
       window.DoNoteTasks.remove('cloud-backup');
      }else{
       window.DoNoteTasks.upsert('cloud-backup',{
        detail:finalMsg||(done?'云端快照操作已完成':'云端操作已结束'),
        percent:done?100:existing.percent,
        state:cancelled?'cancelled':runErr?'error':'done',
        onCancel:null
       });
      }
     }
    }
   }
  }
  async function transfer(action,name){
   if(stopRequested)throw new DOMException('已取消','AbortError');
   hadTransfer=true;transferring=true;
   try{return await request(action,{name},true)}
   finally{transferring=false}
  }
  function snapshotName(){
   return 'DoNote-'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')+'-'+crypto.randomUUID().replace(/-/g,'');
  }

  opener.onclick=()=>{
   if(!ensureReady()||dialog.open)return;
   dialog.showModal();
   if(operation)return;
   void run('正在读取设置…',async()=>{
    showSettings((await request('status')).settings);
    if(configured()){setMessage('已找到 '+await refresh()+' 份备份。');}
    else setMessage('');
   });
  };
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{password.value=''});
  mode.onchange=updateMode;
  list.onchange=updateActions;
  $('cloudBackupCancel').onclick=async()=>{
   if(!cancellable||stopRequested)return;
   stopRequested=true;updateActions();setMessage('正在取消…');
   if(transferring)try{await request('cancel')}catch(error){stopRequested=false;updateActions();setMessage(error.message)}
  };
  $('cloudBackupChoose').onclick=()=>run('请选择备份文件夹…',async()=>{
   folder.value=(await request('choose-folder')).folder;
   setMessage('已选择文件夹。点击「保存并检查」完成配置。');
  });
  form.onsubmit=event=>{
   event.preventDefault();
   if(mode.value==='folder'&&!folder.value){setMessage('请先选择备份文件夹。');return;}
   void run('正在检查备份目标…',async()=>{
    const target=mode.value==='webdav'
     ?{url:url.value.trim(),username:username.value,password:password.value,clearPassword:$('cloudBackupClearPassword').checked}
     :{folder:folder.value};
    await request('configure',{mode:mode.value,keepCount:Number(keep.value)||0,...target});
    showSettings((await request('status')).settings);showSnapshots([]);
    setMessage('目标已连接。找到 '+await refresh()+' 份备份。');
   });
  };
  $('cloudBackupRefresh').onclick=()=>run('正在读取备份列表…',async()=>{
   showSnapshots([]);setMessage('已找到 '+await refresh()+' 份备份。');
  });
  $('cloudBackupRun').onclick=()=>run('正在准备当前工作台的备份…',async()=>{
   if(!configured()||!ensureReady())return;
   const profileId=appState.activeId,name=snapshotName(),estimate=writer.estimatedBytes();
   try{
    await request('stage',{estimatedBytes:estimate});
    const profileChanged=()=>profileId!==appState.activeId;
    await writer.writeSnapshot(name,estimate,value=>{if(!stopRequested)setMessage(value)},{
     restoreOnly:true,isCancelled:()=>stopRequested||profileChanged()
    });
    if(profileChanged())throw new Error('当前工作台已切换，请重新发起备份。');
    setMessage('正在打包并传输…');
    const uploaded=await transfer('upload',name);
    if(!profileChanged()){markBackupExport();void refreshStorageSummary();}
    if(Number(settings.keepCount)>0){try{await refresh()}catch{}}
    else showSnapshots([{name},...[...list.options].filter(option=>option.value&&option.value!==name).map(option=>({name:option.value}))]);
    if([...list.options].some(option=>option.value===name))list.value=name;
    const pruneNote=uploaded?.pruneWarning?'（清理旧版本提示：'+uploaded.pruneWarning+'）':uploaded?.pruned>0?' 已自动清理 '+uploaded.pruned+' 份旧备份。':'';
    setMessage((settings.mode==='folder'?'备份已写入同步目录。请在 Google Drive 桌面版确认上传完成。':'备份已上传到 WebDAV。')+pruneNote);
   }finally{
    try{await request('discard')}catch{}
   }
  },true);
  $('cloudBackupDownload').onclick=()=>run('请选择下载位置…',async()=>{
   if(!list.value)return;
   const {path}=await transfer('download',list.value);
   downloadedPath=path;
   $('cloudBackupDownloaded').textContent='恢复时请选择此文件夹：'+path;
   $('cloudBackupDownloaded').hidden=false;
   $('cloudBackupRestore').hidden=!localRestore||localRestore.hidden;
   $('cloudBackupCopyPath').hidden=!navigator.clipboard;
   setMessage('备份已下载并通过校验。');
  },true);
  $('cloudBackupCopyPath').onclick=async()=>{
   if(!downloadedPath)return;
   try{await navigator.clipboard.writeText(downloadedPath);setMessage('恢复路径已复制。')}
   catch(error){setMessage('可手动复制上方的恢复路径。')}
  };
  $('cloudBackupRestore').onclick=()=>{dialog.close();localRestore.click()};
 }
}
