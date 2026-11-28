'use strict';
{
 const host=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
 if(host){
  const dialog=$('translationSettings'),provider=$('translationProvider'),status=$('translationSettingsStatus'),save=$('translationSettingsSave');
  const pending=new Map();
  let settings;
  const defaultSettings={provider:'localai',localModel:'large',localConfigured:false};
  const labels={localai:'本地大模型（离线）',openai:'云端大模型（并发极速）',mymemory:'MyMemory',baidu:'百度翻译',azure:'微软 Translator'};
  const localModels={large:'4B',compact:'1.7B',tiny:'0.6B'};
  const currentSettings=()=>settings||defaultSettings;
  const providerLabel=(provider=currentSettings().provider)=>provider==='localai'
   ?'本地大模型 · Qwen3-'+(localModels[currentSettings().localModel]||localModels.large)
   :provider==='openai'
   ?'云端大模型 · '+(currentSettings().openaiModel||'OpenAI 兼容')
   :labels[provider]||provider;
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
   $('translationHelp').textContent={
    localai:'完全在本机运行，翻译文本不会上传。首次加载约需数秒到数十秒，之后会复用模型进程；整页翻译已启用轻模型级联路由与多段打包批译。',
    openai:'支持 DeepSeek、通义千问、OpenAI 或本地 Ollama/vLLM 兼容接口，整页与智能排版翻译默认按并发数同时发送并命中前缀缓存，通常 1–3 秒完成一页。密钥已保存时可留空保留。',
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
    const timer=setTimeout(()=>cancel(new Error('翻译服务响应超时。')),fields.provider==='localai'?8*60*1000:fields.provider==='openai'?90000:22000);
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
  host.addEventListener('message',event=>{
   const data=event.data;
   if(data?.type==='translation-settings'&&Object.hasOwn(labels,data.provider)){
    settings=data;
    if(dialog.open){
     provider.value=data.provider;$('translationRegion').value=data.region||'';$('translationLocalModel').value=data.localModel||'large';
     $('translationOpenAiBaseUrl').value=data.openaiBaseUrl||'https://api.deepseek.com';
     $('translationOpenAiModel').value=data.openaiModel||'deepseek-chat';
     $('translationOpenAiConcurrency').value=data.openaiConcurrency||8;
     updateFields();
     status.textContent=data.recovered?'原翻译设置无法读取，已恢复为本地翻译。保存后会备份原设置。':'';
    }
   }else if(data?.type==='translation-response'){
    pending.get(data.id)?.(data.error?new Error(data.error):null,data.value);
   }
  });
  window.desktopTranslation={provider:()=>currentSettings().provider,label:providerLabel,request,ready,
   localConfigured:()=>!!settings?.localConfigured,localModelPath:()=>settings?.localModelPath||'',
   openaiConfigured:()=>!!settings?.openaiConfigured,openaiModel:()=>settings?.openaiModel||'deepseek-chat',
   modelCacheKey:(preference=currentSettings().localModel)=>preference==='openai'?'openai:'+(settings?.openaiModel||'openai'):(settings?.localModelKeys?.[preference]||''),
   localModelPreference:()=>currentSettings().localModel||'large'};
  $('openTranslationSettings').onclick=()=>{
   const current=currentSettings();
   $('translationSettingsForm').reset();provider.value=current.provider;
   $('translationRegion').value=current.region||'';$('translationLocalModel').value=current.localModel||'large';
   $('translationOpenAiBaseUrl').value=current.openaiBaseUrl||'https://api.deepseek.com';
   $('translationOpenAiModel').value=current.openaiModel||'deepseek-chat';
   $('translationOpenAiConcurrency').value=current.openaiConcurrency||8;
   status.textContent='';updateFields();dialog.showModal();
   readSettings().catch(error=>{if(dialog.open)status.textContent=error.message});
  };
  provider.onchange=()=>{$('translationKey').value='';updateFields()};
  $('translationLocalModel').onchange=updateFields;
  $('openLocalModelFolder').onclick=()=>host.postMessage('translation:open-local-models');
  dialog.querySelectorAll('[data-close-translation]').forEach(button=>button.onclick=()=>dialog.close());
  $('translationSettingsForm').onsubmit=async event=>{
   event.preventDefault();if(save.disabled)return;
   save.disabled=true;status.textContent='';
   try{
    await request({action:'save',provider:provider.value,appId:$('translationAppId').value,key:$('translationKey').value,region:$('translationRegion').value,localModel:$('translationLocalModel').value,openaiBaseUrl:$('translationOpenAiBaseUrl').value,openaiModel:$('translationOpenAiModel').value,openaiConcurrency:$('translationOpenAiConcurrency').value});
    $('translationKey').value='';dialog.close();toast('翻译服务已保存。');
   }catch(error){status.textContent=error.message}
   finally{save.disabled=false}
  };
  dialog.addEventListener('close',()=>{$('translationKey').value=''});
  readSettings().catch(()=>{});
 }
}
