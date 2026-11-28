/**
 * [INPUT]: 读取 PDF 选区、框选识字结果、术语表、pdf-translation-bridges.js 与桌面翻译桥。
 * [OUTPUT]: 提供 normalizePdfTranslationText、translatePdfOnline 与选区翻译侧栏 installPdfTranslationPanel。
 * [POS]: 连接阅读器选区/识字与云端/本地自动翻译、批注保存、研究笔记保存及记录追加。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

function normalizePdfTranslationText(text){
 return wellFormedText(text).replace(/\r\n?/g,'\n').replace(/\u00ad[ \t]*\n(?![ \t]*\n)[ \t]*/g,'').replace(/\u00ad/g,'')
  .split(/\n[ \t]*\n+/).map(paragraph=>paragraph.trim()
   .replace(/\b([A-Za-z]+)-[ \t]*\n[ \t]*(?=[a-z])/g,(match,word)=>
    /^(?:low|high|wide|narrow|small|large|single|multi|two|three|four|closed|open|rail|full|half|non|ultra)$/i.test(word)?word+'-':word)
   .replace(/-[ \t]*\n[ \t]*/g,'-')
   .replace(/(?<=\p{Script=Han})[ \t]*\n[ \t]*(?=\p{Script=Han})/gu,'')
   .replace(/[ \t]*\n[ \t]*/g,' ')).filter(Boolean).join('\n\n');
}
function onlineTranslationChunks(paragraph,limit=500){
 // MyMemory accepts at most 500 UTF-8 bytes per query.
 const encoder=new TextEncoder(),chunks=[];
 while(paragraph){
  let bytes=0,end=0,sentence=0,space=0;
  for(const char of paragraph){
   bytes+=encoder.encode(char).length;if(bytes>limit)break;
   end+=char.length;
   if(/[.!?。！？；;]/.test(char))sentence=end;
   if(/\s/.test(char))space=end;
  }
  const cut=end===paragraph.length?end:sentence||space||end;
  const chunk=paragraph.slice(0,cut).trim();
  if(chunk)chunks.push(chunk);
  paragraph=paragraph.slice(cut).trimStart();
 }
 return chunks;
}
async function abortableDelay(ms,signal){
 if(ms<=0)return;
 signal?.throwIfAborted();
 await new Promise((resolve,reject)=>{
  const onAbort=()=>{clearTimeout(timer);reject(signal.reason)};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve()},ms);
  signal?.addEventListener('abort',onAbort,{once:true});
 });
}
async function translatePdfOnline(text,source,target,signal,progress,context='',provider=window.desktopTranslation?.provider()||'mymemory',profileId=appState?.activeId){
 const bridge=window.desktopTranslation;
 const useGlossary=source==='en'&&target==='zh'&&typeof applyCircuitGlossaryPreAlign==='function';
 if(provider==='localai'||provider==='openai'){
  progress(1,1);
  const hint=source==='en'&&target==='zh'&&typeof formatCircuitGlossaryHint==='function'?formatCircuitGlossaryHint(text,profileId):'';
  const mergedCtx=[hint,context].filter(Boolean).join('\n');
  return bridge.request({action:'translate',provider,text,source,target,context:mergedCtx},signal);
 }
 const alignedText=useGlossary?applyCircuitGlossaryPreAlign(text,profileId):text;
 if(provider==='azure'){progress(1,1);return bridge.request({action:'translate',provider,text:alignedText,source,target},signal)}
 if(provider==='baidu'){
  const encoder=new TextEncoder();
  const isPro=bridge?.baiduQpsMode?.()==='pro';
  const rawParas=alignedText.split('\n\n');
  if(encoder.encode(alignedText).length<=4800){
   progress(1,1);
   const single=await bridge.request({action:'translate',provider,text:rawParas.join('\n'),source,target},signal);
   return rawParas.length>1?single.split('\n').join('\n\n'):single;
  }
  const bChunks=[];
  for(const part of rawParas)bChunks.push(...onlineTranslationChunks(part,4200));
  const out=[];
  for(let i=0;i<bChunks.length;i++){
   progress(i+1,bChunks.length);
   if(i>0&&!isPro)await abortableDelay(1050,signal);
   out.push(await bridge.request({action:'translate',provider,text:bChunks[i],source,target},signal));
  }
  return out.join('\n\n');
 }
 const paragraphs=alignedText.split('\n\n').map(part=>onlineTranslationChunks(part,500)),total=paragraphs.reduce((sum,chunks)=>sum+chunks.length,0);
 const pair=[source,target].map(lang=>lang==='zh'?'zh-CN':lang).join('|');
 const translated=[];let current=0;
 for(const chunks of paragraphs){
  const parts=[];
  for(const chunk of chunks){
   progress(++current,total);
   const params=new URLSearchParams({q:chunk,langpair:pair});
   const response=await fetch('https://api.mymemory.translated.net/get?'+params,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),credentials:'omit',referrerPolicy:'no-referrer'});
   if(response.status===429)throw new Error('免费在线翻译额度暂不可用，请稍后再试。');
   if(!response.ok)throw new Error('在线翻译暂不可用，请稍后再试。');
   const data=await response.json();
   if(data.quotaFinished||Number(data.responseStatus)===429)throw new Error('免费在线翻译额度已用完，请稍后再试。');
   const value=data.responseData?.translatedText;
   if(Number(data.responseStatus)!==200||typeof value!=='string'||!value.trim())throw new Error('在线服务未返回有效译文，请稍后重试。');
   parts.push(value.trim());
  }
  translated.push(parts.join(target==='zh'?'':' '));
 }
 return translated.join('\n\n');
}
function installPdfTranslationPanel(session, panel, showPanel) {
 const input = panel.querySelector('#pdfTranslateSource');
 const result = panel.querySelector('#pdfTranslateResult');
 const status = panel.querySelector('#pdfTranslationStatus');
 const automaticToggle = panel.querySelector('#pdfAutoTranslate');
 const anchorBadge = panel.querySelector('#pdfTranslateAnchor');
 const engineBadge = panel.querySelector('#pdfTranslateEngine');
 const copyBtn = panel.querySelector('#copyPdfTranslation');
 const clearBtn = panel.querySelector('#pdfClearTranslation');
 const {signal: sessionSignal} = session.controller;
 const refreshGlossary=bindCircuitGlossary(session,panel,input,result);
 let pending;
 function fitBox(box){
  box.style.height='auto';
  box.style.height=Math.min(220,Math.max(66,box.scrollHeight))+'px';
 }
 function syncChrome(engineLabel){
  fitBox(input);fitBox(result);
  const pageNum=session.translationSelection?.page;
  if(anchorBadge){anchorBadge.hidden=!pageNum;if(pageNum)anchorBadge.textContent='P.'+pageNum;}
  if(engineBadge&&engineLabel!==undefined){
   engineBadge.hidden=!engineLabel;engineBadge.textContent=engineLabel||'';
  }
  if(copyBtn)copyBtn.hidden=!result.value.trim();
  if(clearBtn)clearBtn.hidden=!input.value.trim()&&!result.value.trim();
 }
 const pageContext=()=>{
  const number=session.translationSelection?.page;
  const slot=number
   ? session.pageBox?.parentElement?.querySelector('[data-pdf-page="'+number+'"]')
   : session.pageBox;
  const text=normalizePdfTranslationText(slot?.querySelector('.pdf-text-layer')?.innerText||'');
  const offset=text.indexOf(normalizePdfTranslationText(input.value));
  const start=Math.max(0,offset-1800);
  return text.slice(start,start+3600);
 };

 function cancelQueued() {
  clearTimeout(pending);
 }

  function setSource(picked) {
  if (!picked?.quote) return;
  const text = normalizePdfTranslationText(picked.quote);
  if (input.value !== text) {
   session.translationController?.abort();
   session.translationKey = null;
   input.value = text;
   result.value = '';
   syncChrome('');
  }
  session.translationSelection = picked;
  refreshGlossary();
  syncChrome('');
 }

 async function translateSelection({automatic = false, online = false, forceLocal = false} = {}) {
  const text = normalizePdfTranslationText(input.value);
  if (!text) {
   if (!automatic) toast('请先选择或输入待翻译文字。');
   return;
  }
  if (sessionSignal.aborted) return;
  if (!automatic) input.value = text;
  const {source,target} = storedTranslateLanguage();
  const bridge = window.desktopTranslation;
  const glossarySig = typeof circuitGlossarySignature === 'function' ? circuitGlossarySignature(session.profileId) : '';
  const key = JSON.stringify([source, target, text, online, forceLocal, bridge?.provider?.(), bridge?.modelCacheKey?.(), glossarySig]);
  if (automatic && session.translationKey === key) return;

  session.translationController?.abort();
  const controller = new AbortController();
  const {signal} = controller;
  session.translationController = controller;
  session.translationKey = key;
  const active = () => !sessionSignal.aborted && !signal.aborted;
  const options = {sourceLanguage: source, targetLanguage: target};
  let translator, translated, service, usedOnline = online;
  result.value = '';

  try {
   if (source === target) {
    translated = text;
    result.value = text;
    status.textContent = '原文与目标语言相同。';
    return;
   }
   status.textContent = '正在准备翻译…';
   try { await bridge?.ready?.(signal); }
   catch (error) {
    // Explicit online translation needs the configured credentials. A local
    // request can still use the bundled engine when settings are unreadable.
    if (online) throw error;
   }
   if (!active()) return;
   const configured = bridge?.provider() || 'mymemory';
   const autoCloud = !forceLocal && (
    (configured === 'openai' && bridge?.openaiConfigured?.()) ||
    (configured === 'baidu' && bridge?.baiduConfigured?.()) ||
    (configured === 'azure' && bridge?.azureConfigured?.())
   );
   const useOnline = online || autoCloud;
   usedOnline = useOnline;
   const provider = useOnline && configured !== 'localai' ? configured : 'mymemory';
   const useLlm = !useOnline && bridge?.localConfigured?.();
   const useOffline = !useOnline && source === 'en' && target === 'zh' && window.BilingualBook?.available;

   const limit = useOnline && provider !== 'openai' ? 5000 : 10000;
   if (text.length > limit) {
    status.textContent = '每次最多翻译 ' + limit.toLocaleString('zh-CN') + ' 字符，请缩短原文。';
    return;
   }
   if (useOnline) {
    service = bridge?.label?.(provider) || 'MyMemory';
    status.textContent = (provider === 'openai' ? '云端大模型正在翻译…' : '正在在线翻译…');
    translated = await translatePdfOnline(text, source, target, signal, (current, total) => {
     if (active() && provider !== 'openai') status.textContent = '正在在线翻译…' + (total > 1 ? ' ' + current + ' / ' + total : '');
    }, provider === 'openai' ? pageContext() : '', provider, session.profileId);
   } else if (useLlm || useOffline) {
    if (useLlm) {
     service = bridge.label('localai');
     status.textContent = '本地大模型正在翻译…';
     try {
      const hint = source === 'en' && target === 'zh' && typeof formatCircuitGlossaryHint === 'function' ? formatCircuitGlossaryHint(text, session.profileId) : '';
      const mergedCtx = [hint, pageContext()].filter(Boolean).join('\n');
      translated = await bridge.request({action:'translate', provider:'localai', text, source, target, context:mergedCtx}, signal);
     } catch (error) {
      if (!useOffline || !active()) throw error;
     }
    }
    if (!translated) {
     service = '快速离线';
     status.textContent = '正在快速离线翻译…';
     const blocks = text.split('\n\n').map((paragraph, index) => ({id:String(index), type:'para', text:paragraph}));
     const response = await window.BilingualBook.pair(blocks, {translate:true, preference:'offline', source, target, signal});
     const pairs = new Map((response.pairs || []).map(pair => [pair.id, pair.translation]));
     const values = blocks.map(block => pairs.get(block.id)?.trim());
     if (!values.some(Boolean)) throw new Error('快速离线未返回有效译文。');
     translated = values.map((value, index) => value || blocks[index].text).join('\n\n');
     if (values.some(value => !value)) service += '（部分保留原文）';
    }
   } else {
    if (!('Translator' in window)) {
     status.textContent = '此语言组合需要配置本地大模型，或点击「在线翻译」。';
     return;
    }
    const availability = await Translator.availability(options);
    if (!active()) return;
    if (availability === 'unavailable') {
     status.textContent = '此语言组合暂不支持本地翻译。';
     return;
    }
    if (availability !== 'available' && automatic) {
     status.textContent = '首次使用请点击「本地翻译」准备语言包。';
     return;
    }
    translator = await Translator.create({
     ...options,
     signal,
     monitor(monitor) {
      monitor.addEventListener('downloadprogress', event => {
       if (active()) status.textContent = '正在准备语言包 ' + Math.round(event.loaded * 100) + '%';
      });
     }
    });
    if (!active()) return;
    service = '本地语言包';
    status.textContent = '正在翻译所选文字…';
    translated = await translator.translate(text, {signal});
   }
   if (!active()) return;
   if (!translated?.trim()) throw new Error('未返回有效译文。');
   result.value = translated;
   syncChrome(service);
   status.textContent = '翻译完成 · ' + service;
  } catch (error) {
   if (!active()) return;
   if (usedOnline && error.name === 'TimeoutError') status.textContent = '在线翻译超时，请重试。';
   else if (usedOnline && error instanceof TypeError) status.textContent = '无法连接在线翻译服务。';
   else status.textContent = (usedOnline ? '在线翻译未完成：' : '本地翻译未完成：') + (error.message || '请重试。');
  } finally {
   translator?.destroy();
   if (session.translationController === controller) {
    session.translationController = null;
    if (!result.value) session.translationKey = null;
   }
  }
 }

 function queueSelection(picked) {
  if (!automaticToggle.checked || !picked?.quote) return;
  setSource(picked);
  cancelQueued();
  pending = setTimeout(() => {
   if (!sessionSignal.aborted && !session.selectingText) void translateSelection({automatic: true});
  }, 280);
 }

 async function openSelection(picked) {
  setSource(picked);
  cancelQueued();
  await showPanel('translation', false, picked);
  if (sessionSignal.aborted) return;
  input.focus();
  if (!result.value && !session.translationController) void translateSelection();
 }

 session.receiveOcrText = openSelection;
 session.translateMark = async mark => {
  await showPanel('translation');
  if (sessionSignal.aborted) return;
  input.value = normalizePdfTranslationText(mark.quote);
  session.translationSelection = mark;
  input.oninput();
  input.focus();
 };
 sessionSignal.addEventListener('abort', () => {
  cancelQueued();
  session.translationController?.abort();
 }, {once: true});

 try { automaticToggle.checked = localStorage.getItem('analog-auto-translate') !== 'off'; } catch {}
 automaticToggle.onchange = () => {
  try { localStorage.setItem('analog-auto-translate', automaticToggle.checked ? 'on' : 'off'); } catch {}
  if (!automaticToggle.checked) {
   cancelQueued();
   session.translationController?.abort();
   status.textContent = '已关闭「选中即翻」。';
  }
 };
 input.oninput = () => {
  cancelQueued();
  session.translationController?.abort();
  session.translationKey = null;
  const trimmed = input.value.trim();
  session.translationSelection = trimmed && session.translationSelection ? { ...session.translationSelection, quote: trimmed } : null;
  result.value = '';
  syncChrome('');
  status.textContent = trimmed ? '原文已修改，可点击「本地翻译」或「在线翻译」。' : '';
 };
 input.onpaste = event => {
  const pasted = event.clipboardData?.getData('text/plain');
  if (!pasted || !/[\r\n]/.test(pasted)) return;
  event.preventDefault();
  input.setRangeText(normalizePdfTranslationText(pasted), input.selectionStart, input.selectionEnd, 'end');
  input.oninput();
 };
 result.oninput = () => {
  cancelQueued();
  session.translationController?.abort();
  syncChrome();
 };
 if (copyBtn) {
  copyBtn.onclick = async () => {
   const text = result.value.trim();
   if (!text) return;
   try { await navigator.clipboard.writeText(text); toast('译文已复制'); }
   catch { toast('复制失败，请手动选择复制'); }
  };
 }
 if (clearBtn) {
  clearBtn.onclick = () => {
   cancelQueued();
   session.translationController?.abort();
   session.translationKey = null;
   session.translationSelection = null;
   input.value = '';
   result.value = '';
   status.textContent = '';
   refreshGlossary();
   syncChrome('');
  };
 }
 document.addEventListener('translate-language-change', () => {
  refreshTranslateLanguageLabel();
  cancelQueued();
  session.translationController?.abort();
  session.translationController = null;
  session.translationKey = null;
  result.value = '';
  status.textContent = '';
  if (automaticToggle.checked && normalizePdfTranslationText(input.value)) void translateSelection({automatic: true});
 }, {signal: sessionSignal});
 window.addEventListener('donote-translation-settings-change', () => {
  cancelQueued();
  session.translationController?.abort();
  session.translationController = null;
  session.translationKey = null;
  if (automaticToggle.checked && normalizePdfTranslationText(input.value)) void translateSelection({automatic: true});
 }, {signal: sessionSignal});
 window.addEventListener('donote-glossary-change', () => {
  refreshGlossary();
  cancelQueued();
  session.translationController?.abort();
  session.translationController = null;
  session.translationKey = null;
  if (automaticToggle.checked && normalizePdfTranslationText(input.value)) void translateSelection({automatic: true});
 }, {signal: sessionSignal});

 const useSelection = panel.querySelector('#pdfUseSelection');
 useSelection.onmousedown = event => {
  capturePdfSelection(session);
  event.preventDefault();
 };
 useSelection.onclick = () => {
  const picked = capturePdfSelection(session);
  if (!picked) {
   toast('请先选中文字。');
   return;
  }
  setSource(picked);
  cancelQueued();
  void translateSelection();
 };
 panel.querySelector('#pdfLocalTranslate').onclick = () => {
  cancelQueued();
  void translateSelection({forceLocal: true});
 };
 panel.querySelector('#pdfOnlineTranslate').onclick = () => {
  cancelQueued();
  void translateSelection({online: true});
 };
 panel.querySelector('#savePdfTranslation').onclick = () => {
  const text = input.value.trim();
  const translation = result.value.trim();
  const picked = session.translationSelection;
  if (!text || !translation) {
   toast('请先填写原文和译文。');
   return;
  }
  const mark = addPdfMark(session, 'translation', {
   quote: text,
   note: translation,
   page: picked?.page ?? session.page,
   rects: picked?.rects ?? []
  });
  if (mark) status.textContent = '译文已保存，可在「批注」查看。';
 };
 function currentExcerptPicked() {
  const quote = input.value.trim();
  if (!quote) { toast('请先选中文字或框选识字。'); return null; }
  const base = session.translationSelection || session.picked;
  const page = base?.page ?? session.page;
  return { page, rects: base?.page === page ? (base?.rects ?? []) : [], quote };
 }
 panel.querySelector('#savePdfSelectionNote').onclick = async () => {
  const picked = currentExcerptPicked();
  if (!picked) return;
  try { await savePdfExcerpt(session, picked); } catch (error) { toast(error.message); }
 };
 panel.querySelector('#appendPdfSelectionRecord').onclick = async () => {
  const picked = currentExcerptPicked();
  if (!picked) return;
  try {
   const id = await askPdfExcerptTarget();
   if (id) await appendPdfExcerpt(session, picked, id);
  } catch (error) { toast(error.message); }
 };
 refreshTranslateLanguageLabel();
 return {
  cancelQueued,
  openSelection,
  queueSelection,
  get automaticEnabled() { return automaticToggle.checked; }
 };
}
