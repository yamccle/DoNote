/**
 * [INPUT]: 读取独立「翻译服务设置」弹窗表单、已配 AI 大模型服务商列表与 WebView2 宿主 translation-settings 消息。
 * [OUTPUT]: 暴露 window.desktopTranslation 桥，支持专用翻译 API（百度/微软/MyMemory）、本地 GGUF 与已配大模型服务商复用。
 * [POS]: 桌面端独立文献与选词翻译配置层，与「AI 大模型服务商中心」边界清晰分离又支持一键复用大模型密钥。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
 const host=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
 if(host){
  const dialog=$('translationSettings'),provider=$('translationProvider'),status=$('translationSettingsStatus'),save=$('translationSettingsSave'),testBtn=$('translationTestBtn');
  const hubSelect=$('translationHubProviderSelect'),hubField=$('translationHubReuseField'),jumpHubBtn=$('translationJumpAiHubBtn');
  const pending=new Map();
  let settings;
  const defaultSettings={provider:'localai',localModel:'large',localConfigured:false};
  const labels={localai:'本地大模型（离线）',openai:'AI 大模型（并发极速）',mymemory:'MyMemory 免费在线',baidu:'百度翻译 API',azure:'微软 Translator'};
  const localModels={large:'4B',compact:'1.7B',tiny:'0.6B'};
  const currentSettings=()=>settings||defaultSettings;
  const providerLabel=(p=currentSettings().provider)=>p==='localai'
   ?'本地大模型 · Qwen3-'+(localModels[currentSettings().localModel]||localModels.large)
   :p==='openai'
   ?'AI 大模型 · '+(currentSettings().openaiModel||'OpenAI 兼容')
   :labels[p]||p;
  const hasSavedKey=value=>(value==='openai'&&!!settings?.openaiConfigured)
   ||(value==='baidu'&&!!settings?.baiduConfigured)
   ||(value==='azure'&&!!settings?.azureConfigured);

  function syncHubProviderDropdown(){
   if(!hubSelect)return;
   const hubProviders=window.desktopAiHub?.getState?.()?.providers||[];
   hubSelect.replaceChildren();
   for(const p of hubProviders){
    const opt=document.createElement('option');
    opt.value=p.id;
    opt.textContent=`复用已配服务商：${p.name}（${p.defaultModel} · ${p.hasKey?p.maskedKey:'本机免密'}）`;
    hubSelect.append(opt);
   }
   const customOpt=document.createElement('option');
   customOpt.value='__custom__';
   customOpt.textContent=hubProviders.length?'手动填写独立翻译大模型接口…':'手动填写兼容接口地址与 API Key…';
   hubSelect.append(customOpt);
   const curUrl=(settings?.openaiBaseUrl||'').replace(/\/+$/,'').toLowerCase();
   const matched=settings?.provider==='openai'?hubProviders.find(p=>p.baseUrl.replace(/\/+$/,'').toLowerCase()===curUrl):hubProviders[0];
   hubSelect.value=matched?matched.id:'__custom__';
  }

  function updateFields(){
   const value=provider.value;
   const hubProviders=window.desktopAiHub?.getState?.()?.providers||[];
   const usingHubProvider=value==='openai'&&hubSelect&&hubSelect.value&&hubSelect.value!=='__custom__'&&hubProviders.some(p=>p.id===hubSelect.value);
   if(hubField)hubField.hidden=value!=='openai';
   $('translationOpenAiBaseUrlField').hidden=value!=='openai'||usingHubProvider;
   $('translationOpenAiModelField').hidden=value!=='openai';
   $('translationOpenAiConcurrencyField').hidden=value!=='openai';
   $('translationOpenAiConcurrency').disabled=value!=='openai';
   $('translationAppIdField').hidden=value!=='baidu';
   if($('translationBaiduOptionsField'))$('translationBaiduOptionsField').hidden=value!=='baidu';
   $('translationKeyField').hidden=(value!=='baidu'&&value!=='azure'&&value!=='openai')||usingHubProvider;
   $('translationRegionField').hidden=value!=='azure';
   $('localModelField').hidden=value!=='localai';

   if(usingHubProvider){
    const picked=hubProviders.find(p=>p.id===hubSelect.value);
    if(picked){
     $('translationOpenAiBaseUrl').value=picked.baseUrl;
     if(!$('translationOpenAiModel').value.trim())$('translationOpenAiModel').value=picked.defaultModel;
    }
   }

   const keySaved=hasSavedKey(value);
   const keyLabel=$('translationKeyLabelText');
   if(keyLabel)keyLabel.textContent=keySaved?'服务密钥 / API Key（✓ 已加密保存，留空即保留）':'服务密钥 / API Key';
   $('translationKey').placeholder=keySaved
    ?'•••••••• 密钥已保存（留空保留原密钥，输入新值可替换）'
    :(value==='openai'?'请输入 API Key（如 sk-...，本机 Ollama 可留空）':'请输入专用翻译 API 密钥');
   if(testBtn)testBtn.hidden=value!=='openai'&&value!=='baidu'&&value!=='azure';
   $('translationHelp').textContent={
    baidu:'百度通用文本翻译专用 API，与 AI 大模型互不干扰。全面覆盖划词、整页保公式对照与排版翻译，并自动对齐阅读器「专业术语词库」；开通高级/尊享版可切换 QPS=10 多批并发。',
    azure:'微软 Azure Translator 专用机器翻译 API，单页多段一次请求极速返回，全面覆盖划词、整页对照与排版翻译，并自动对齐「专业术语词库」。',
    openai:usingHubProvider
     ?'当前直接复用「AI 大模型服务商中心」已加密保存的密钥，无需重复填写；自动注入学科「专业术语词库」并按并发数极速翻译。'
     :'支持任意 OpenAI 兼容大模型接口并发翻译；建议先在「AI 大模型服务商中心」统一保存密钥后直接在此选用。',
    localai:'完全在本机离线运行，文献内容不上传网络。常驻内存复用，自动注入学科「专业术语词库」并支持流式多段批译。',
    mymemory:'无需注册或密钥的免费匿名在线翻译，受每日额度与单句长度限制，适合 PDF 划词短句翻译（同样支持本地术语表对齐）。'
   }[value];
   const model=$('translationLocalModel').value;
   const field={large:'Large',compact:'Compact',tiny:'Tiny'}[model];
   const configured=settings?.['local'+field+'Configured'];
   const path=settings?.['local'+field+'Path'];
   $('translationLocalStatus').textContent=!settings?'正在检查模型…':configured
    ?'✓ 本地模型已就绪'
    :'尚未检测到模型。请放入：'+(path||'models\\translation');
  }

  function request(fields,signal){
   if(signal?.aborted)return Promise.reject(signal.reason);
   const id=crypto.randomUUID();
   return new Promise((resolve,reject)=>{
    const finish=(error,value)=>{
     pending.delete(id);clearTimeout(timer);signal?.removeEventListener('abort',abort);
     if(error)reject(error);else resolve(value);
    };
    const cancel=error=>{
     if(fields.action==='translate'){try{host.postMessage('translation:cancel:'+id)}catch{}}
     finish(error);
    };
    const abort=()=>cancel(signal.reason);
    const timeoutMs=fields.action==='test'?28000:fields.provider==='localai'?8*60*1000:fields.provider==='openai'?90000:25000;
    const timer=setTimeout(()=>cancel(new Error('翻译服务响应超时。')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});pending.set(id,finish);
    try{host.postMessage('translation:'+JSON.stringify({id,...fields}))}catch(error){finish(error)}
   });
  }
  let reading;
  const readSettings=()=>reading??=request({action:'read'}).finally(()=>{reading=null});
  const ready=async signal=>{
   if(!settings)await readSettings();
   signal?.throwIfAborted();
  };

  async function collectFormPayload(action){
   const chosen=provider.value;
   let baseUrl=$('translationOpenAiBaseUrl').value;
   let key=$('translationKey').value;
   let model=$('translationOpenAiModel').value;
   if(chosen==='openai'&&hubSelect&&hubSelect.value&&hubSelect.value!=='__custom__'&&window.desktopAiHub){
    const hubState=window.desktopAiHub.getState?.();
    const picked=(hubState?.providers||[]).find(p=>p.id===hubSelect.value);
    if(picked){
     baseUrl=picked.baseUrl;
     model=model.trim()||picked.defaultModel;
     if(!key.trim()){
      if(picked.isLocal)key='local';
      else if(window.desktopAiHub.resolveProviderKey){
       const resolvedKey=await window.desktopAiHub.resolveProviderKey(picked.id);
       if(resolvedKey)key=resolvedKey;
      }
     }
    }
   }
   return {
    action,
    provider:chosen,
    appId:$('translationAppId').value,
    baiduQpsMode:$('translationBaiduQpsMode')?.value||'standard',
    baiduCustomDict:$('translationBaiduCustomDict')?.checked?'true':'false',
    key,
    region:$('translationRegion').value,
    localModel:$('translationLocalModel').value,
    openaiBaseUrl:baseUrl,
    openaiModel:model,
    openaiConcurrency:$('translationOpenAiConcurrency').value
   };
  }

  host.addEventListener('message',event=>{
   const data=event.data;
   if(data?.type==='translation-settings'&&Object.hasOwn(labels,data.provider)){
    const hadLoaded=!!settings;
    settings=data;
    if(dialog.open&&!hadLoaded){
     provider.value=data.provider;$('translationAppId').value=data.baiduId||'';
     if($('translationBaiduQpsMode'))$('translationBaiduQpsMode').value=data.baiduQpsMode==='pro'?'pro':'standard';
     if($('translationBaiduCustomDict'))$('translationBaiduCustomDict').checked=!!data.baiduCustomDict;
     $('translationRegion').value=data.region||'';$('translationLocalModel').value=data.localModel||'large';
     $('translationOpenAiBaseUrl').value=data.openaiBaseUrl||'https://api.deepseek.com';
     $('translationOpenAiModel').value=data.openaiModel||'deepseek-chat';
     $('translationOpenAiConcurrency').value=data.openaiConcurrency||8;
     syncHubProviderDropdown();
    }
    if(dialog.open){
     updateFields();
     if(data.recovered)status.textContent='原翻译设置无法读取，已恢复为本地翻译。保存后会备份原设置。';
    }
   }else if(data?.type==='translation-response'){
    pending.get(data.id)?.(data.error?new Error(data.error):null,data.value);
   }
  });

  window.desktopTranslation={
   provider:()=>currentSettings().provider,
   label:providerLabel,
   request,
   ready,
   localConfigured:()=>!!settings?.localConfigured,
   localModelPath:()=>settings?.localModelPath||'',
   openaiConfigured:()=>!!settings?.openaiConfigured,
   baiduConfigured:()=>!!settings?.baiduConfigured,
   baiduQpsMode:()=>currentSettings().baiduQpsMode==='pro'?'pro':'standard',
   baiduCustomDict:()=>!!currentSettings().baiduCustomDict,
   azureConfigured:()=>!!settings?.azureConfigured,
   openaiModel:()=>settings?.openaiModel||'deepseek-chat',
   modelCacheKey:(preference=currentSettings().localModel)=>{
    if(preference==='openai')return 'openai:'+(settings?.openaiModel||'openai');
    if(preference==='api'||preference==='baidu'||preference==='azure'){
     const p=currentSettings().provider||'api';
     return 'api:'+p+(p==='baidu'&&currentSettings().baiduCustomDict?':dict':'');
    }
    return settings?.localModelKeys?.[preference]||'';
   },
   localModelPreference:()=>currentSettings().localModel||'large'
  };

  $('openTranslationSettings').onclick=()=>{
   const current=currentSettings();
   $('translationSettingsForm').reset();provider.value=current.provider;
   $('translationAppId').value=current.baiduId||'';
   if($('translationBaiduQpsMode'))$('translationBaiduQpsMode').value=current.baiduQpsMode==='pro'?'pro':'standard';
   if($('translationBaiduCustomDict'))$('translationBaiduCustomDict').checked=!!current.baiduCustomDict;
   $('translationRegion').value=current.region||'';$('translationLocalModel').value=current.localModel||'large';
   $('translationOpenAiBaseUrl').value=current.openaiBaseUrl||'https://api.deepseek.com';
   $('translationOpenAiModel').value=current.openaiModel||'deepseek-chat';
   $('translationOpenAiConcurrency').value=current.openaiConcurrency||8;
   syncHubProviderDropdown();
   status.textContent=hasSavedKey(current.provider)?'✓ 当前密钥已加密保存在本机，留空即保留原密钥。':'';
   updateFields();
   if(!dialog.open)dialog.showModal();
   Promise.all([window.desktopAiHub?.ready?.().catch(()=>{}),readSettings()]).then(()=>{
    if(dialog.open){
     $('translationAppId').value=settings?.baiduId||$('translationAppId').value;
     if($('translationBaiduQpsMode'))$('translationBaiduQpsMode').value=settings?.baiduQpsMode==='pro'?'pro':'standard';
     if($('translationBaiduCustomDict'))$('translationBaiduCustomDict').checked=!!settings?.baiduCustomDict;
     syncHubProviderDropdown();updateFields();
    }
   }).catch(error=>{if(dialog.open)status.textContent=error.message});
  };
  provider.onchange=()=>{$('translationKey').value='';status.textContent='';updateFields()};
  if(hubSelect)hubSelect.onchange=()=>{
   const hubProviders=window.desktopAiHub?.getState?.()?.providers||[];
   const picked=hubProviders.find(p=>p.id===hubSelect.value);
   if(picked){$('translationOpenAiBaseUrl').value=picked.baseUrl;$('translationOpenAiModel').value=picked.defaultModel}
   updateFields();
  };
  if(jumpHubBtn)jumpHubBtn.onclick=()=>{dialog.close();window.desktopAiHub?.open?.()};
  $('translationLocalModel').onchange=updateFields;
  $('openLocalModelFolder').onclick=()=>host.postMessage('translation:open-local-models');
  dialog.querySelectorAll('[data-close-translation]').forEach(button=>button.onclick=()=>dialog.close());
  if(testBtn){
   testBtn.onclick=async()=>{
    if(testBtn.disabled||save.disabled)return;
    testBtn.disabled=true;save.disabled=true;status.textContent='正在测试翻译服务连接…';
    try{
     const msg=await request(await collectFormPayload('test'));
     status.textContent=msg||'✓ 连接正常。';
    }catch(error){status.textContent=error.message||'连接测试未通过。'}
    finally{testBtn.disabled=false;save.disabled=false}
   };
  }
  $('translationSettingsForm').onsubmit=async event=>{
   event.preventDefault();if(save.disabled)return;
   save.disabled=true;if(testBtn)testBtn.disabled=true;status.textContent='';
   try{
    const chosen=provider.value,localPref=$('translationLocalModel').value||'large';
    await request(await collectFormPayload('save'));
    try{
     if(chosen==='openai'){
      localStorage.setItem('donote.pdf.comparison.engine','openai');
      localStorage.setItem('donote.bilingual.engine','configured');
     }else if(chosen==='baidu'||chosen==='azure'){
      localStorage.setItem('donote.pdf.comparison.engine','api');
      localStorage.setItem('donote.bilingual.engine','configured');
     }else if(chosen==='localai'){
      localStorage.setItem('donote.pdf.comparison.engine',localPref);
      localStorage.setItem('donote.bilingual.engine','configured');
     }
    }catch{}
    $('translationKey').value='';dialog.close();
    window.desktopAiHub?.refresh?.().catch(()=>{});
    window.dispatchEvent(new CustomEvent('donote-translation-settings-change',{detail:currentSettings()}));
    toast('翻译服务已保存：'+providerLabel(chosen));
   }catch(error){status.textContent=error.message}
   finally{save.disabled=false;if(testBtn)testBtn.disabled=false}
  };
  dialog.addEventListener('close',()=>{$('translationKey').value=''});
  readSettings().catch(()=>{});
 }
}
