/**
 * [INPUT]: 读取桌面翻译设置弹窗表单与 WebView2 宿主 translation-settings 消息。
 * [OUTPUT]: 暴露 window.desktopTranslation 桥，维护加密密钥就绪提示、一键连接测试与跨视图热切换事件。
 * [POS]: 桌面翻译配置与请求协调层，衔接设置中心、选词即翻、整页对照与智能排版双语模式。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
 const host=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
 if(host){
  const dialog=$('translationSettings'),provider=$('translationProvider'),status=$('translationSettingsStatus'),save=$('translationSettingsSave'),testBtn=$('translationTestBtn');
  const pending=new Map();
  let settings;
  const defaultSettings={provider:'localai',localModel:'large',localConfigured:false};
  const labels={localai:'本地大模型（离线）',openai:'云端大模型（并发极速）',mymemory:'MyMemory',baidu:'百度翻译',azure:'微软 Translator'};
  const localModels={large:'4B',compact:'1.7B',tiny:'0.6B'};
  const currentSettings=()=>settings||defaultSettings;
  const providerLabel=(p=currentSettings().provider)=>p==='localai'
   ?'本地大模型 · Qwen3-'+(localModels[currentSettings().localModel]||localModels.large)
   :p==='openai'
   ?'云端大模型 · '+(currentSettings().openaiModel||'OpenAI 兼容')
   :labels[p]||p;
  const hasSavedKey=value=>(value==='openai'&&!!settings?.openaiConfigured)
   ||(value==='baidu'&&!!settings?.baiduConfigured)
   ||(value==='azure'&&!!settings?.azureConfigured);
  function updateFields(){
   const value=provider.value;
   $('translationOpenAiBaseUrlField').hidden=value!=='openai';
   $('translationOpenAiModelField').hidden=value!=='openai';
   $('translationOpenAiConcurrencyField').hidden=value!=='openai';
   $('translationOpenAiConcurrency').disabled=value!=='openai';
   $('translationAppIdField').hidden=value!=='baidu';
   $('translationKeyField').hidden=value!=='baidu'&&value!=='azure'&&value!=='openai';
   $('translationRegionField').hidden=value!=='azure';
   $('localModelField').hidden=value!=='localai';
   const keySaved=hasSavedKey(value);
   const keyLabel=$('translationKeyLabelText');
   if(keyLabel)keyLabel.textContent=keySaved?'服务密钥 / API Key（✓ 已加密保存，留空即保留）':'服务密钥 / API Key';
   $('translationKey').placeholder=keySaved
    ?'•••••••• 密钥已保存（留空保留原密钥，输入新值可替换）'
    :(value==='openai'?'请输入 API Key（如 sk-...，本机 Ollama 可留空）':'请输入服务密钥');
   if(testBtn)testBtn.hidden=value!=='openai'&&value!=='baidu'&&value!=='azure';
   $('translationHelp').textContent={
    localai:'完全在本机运行，翻译文本不会上传。首次加载约需数秒到数十秒，之后会复用模型进程；整页翻译已启用轻模型级联路由与多段打包批译。',
    openai:'支持 DeepSeek、通义千问、OpenAI 或本地 Ollama/vLLM 兼容接口。保存后选词即翻、整页对照与排版翻译将统一启用，无需重复填写密钥。',
    mymemory:'无需注册或密钥，受匿名免费额度限制。',
    baidu:'需在百度翻译开放平台开通通用文本翻译并填写 APP ID 和密钥。已配置时可留空保留原凭证。',
    azure:'需在 Azure 创建 Translator 资源，免费使用请选择 F0。密钥已保存时可留空保留。'
   }[value];
   const model=$('translationLocalModel').value;
   const field={large:'Large',compact:'Compact',tiny:'Tiny'}[model];
   const configured=settings?.['local'+field+'Configured'];
   const path=settings?.['local'+field+'Path'];
   $('translationLocalStatus').textContent=!settings?'正在检查模型…':configured
    ?'模型已就绪'
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
  function collectFormPayload(action){
   return {
    action,
    provider:provider.value,
    appId:$('translationAppId').value,
    key:$('translationKey').value,
    region:$('translationRegion').value,
    localModel:$('translationLocalModel').value,
    openaiBaseUrl:$('translationOpenAiBaseUrl').value,
    openaiModel:$('translationOpenAiModel').value,
    openaiConcurrency:$('translationOpenAiConcurrency').value
   };
  }
  host.addEventListener('message',event=>{
   const data=event.data;
   if(data?.type==='translation-settings'&&Object.hasOwn(labels,data.provider)){
    const hadLoaded=!!settings;
    settings=data;
    if(dialog.open&&!hadLoaded){
     provider.value=data.provider;$('translationRegion').value=data.region||'';$('translationLocalModel').value=data.localModel||'large';
     $('translationOpenAiBaseUrl').value=data.openaiBaseUrl||'https://api.deepseek.com';
     $('translationOpenAiModel').value=data.openaiModel||'deepseek-chat';
     $('translationOpenAiConcurrency').value=data.openaiConcurrency||8;
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
   azureConfigured:()=>!!settings?.azureConfigured,
   openaiModel:()=>settings?.openaiModel||'deepseek-chat',
   modelCacheKey:(preference=currentSettings().localModel)=>preference==='openai'?'openai:'+(settings?.openaiModel||'openai'):(settings?.localModelKeys?.[preference]||''),
   localModelPreference:()=>currentSettings().localModel||'large'
  };
  $('openTranslationSettings').onclick=()=>{
   const current=currentSettings();
   $('translationSettingsForm').reset();provider.value=current.provider;
   $('translationRegion').value=current.region||'';$('translationLocalModel').value=current.localModel||'large';
   $('translationOpenAiBaseUrl').value=current.openaiBaseUrl||'https://api.deepseek.com';
   $('translationOpenAiModel').value=current.openaiModel||'deepseek-chat';
   $('translationOpenAiConcurrency').value=current.openaiConcurrency||8;
   status.textContent=hasSavedKey(current.provider)?'✓ 当前密钥已加密保存在本机，无需重复填写；直接修改参数或关闭即可。':'';
   updateFields();dialog.showModal();
   readSettings().then(()=>{if(dialog.open)updateFields()}).catch(error=>{if(dialog.open)status.textContent=error.message});
  };
  provider.onchange=()=>{$('translationKey').value='';status.textContent='';updateFields()};
  $('translationLocalModel').onchange=updateFields;
  $('openLocalModelFolder').onclick=()=>host.postMessage('translation:open-local-models');
  dialog.querySelectorAll('[data-close-translation]').forEach(button=>button.onclick=()=>dialog.close());
  if(testBtn){
   testBtn.onclick=async()=>{
    if(testBtn.disabled||save.disabled)return;
    testBtn.disabled=true;save.disabled=true;status.textContent='正在测试翻译服务连接…';
    try{
     const msg=await request(collectFormPayload('test'));
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
    await request(collectFormPayload('save'));
    try{
     if(chosen==='openai'){
      localStorage.setItem('donote.pdf.comparison.engine','openai');
      localStorage.setItem('donote.bilingual.engine','configured');
     }else if(chosen==='localai'){
      localStorage.setItem('donote.pdf.comparison.engine',localPref);
      localStorage.setItem('donote.bilingual.engine','configured');
     }
    }catch{}
    $('translationKey').value='';dialog.close();
    window.dispatchEvent(new CustomEvent('donote-translation-settings-change',{detail:currentSettings()}));
    toast('翻译服务已保存：'+providerLabel(chosen));
   }catch(error){status.textContent=error.message}
   finally{save.disabled=false;if(testBtn)testBtn.disabled=false}
  };
  dialog.addEventListener('close',()=>{$('translationKey').value=''});
  readSettings().catch(()=>{});
 }
}
