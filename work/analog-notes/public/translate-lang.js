/**
 * [INPUT]: 读取与保存本机翻译语言对配置（源语言与目标语言）。
 * [OUTPUT]: 提供 storedTranslateLanguage、applyTranslateLanguage、refreshTranslateLanguageLabel 及一键互换语言事件。
 * [POS]: 连接阅读器翻译面板顶部语言栏与语言设置弹窗。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
const TRANSLATE_LANG_KEY='analog-translate-lang';
const TRANSLATE_LANG_NAMES={en:'英语',zh:'中文',de:'德语',fr:'法语'};
function storedTranslateLanguage(){
 try{
  const value=JSON.parse(localStorage.getItem(TRANSLATE_LANG_KEY)||'{}');
  const source=TRANSLATE_LANG_NAMES[value.source]?value.source:'en';
  const target=TRANSLATE_LANG_NAMES[value.target]?value.target:'zh';
  return {source,target};
 }catch{return {source:'en',target:'zh'}}
}
function applyTranslateLanguage(source,target){
 const from=$('pdfSourceLang'),to=$('pdfTargetLang');
 if(from&&TRANSLATE_LANG_NAMES[source])from.value=source;
 if(to&&TRANSLATE_LANG_NAMES[target])to.value=target;
 refreshTranslateLanguageLabel();
}
function refreshTranslateLanguageLabel(){
 const from=$('pdfSourceLang'),to=$('pdfTargetLang');
 const label=(element,target)=>{
  if(!element||!target)return;
  target.textContent=TRANSLATE_LANG_NAMES[element.value]||element.value;
 };
 label(from,$('pdfLangFrom'));
 label(to,$('pdfLangTo'));
}
function openTranslateLangDialog(){
 const {source,target}=storedTranslateLanguage();
 applyTranslateLanguage(source,target);
 const dialog=$('translateLangDialog');
 if(dialog&&!dialog.open)dialog.showModal();
}
document.addEventListener('click',event=>{
 if(event.target.closest('#pdfLangSettings,#openTranslateLangDialog')){openTranslateLangDialog();return}
 if(event.target.closest('#pdfLangSwap')){
  const {source,target}=storedTranslateLanguage();
  if(source===target)return;
  try{localStorage.setItem(TRANSLATE_LANG_KEY,JSON.stringify({source:target,target:source}))}catch{}
  applyTranslateLanguage(target,source);
  document.dispatchEvent(new CustomEvent('translate-language-change',{detail:{source:target,target:source}}));
 }
});
$('translateLangSave').onclick=()=>{
 const source=$('pdfSourceLang').value,target=$('pdfTargetLang').value;
 if(source===target){toast('原文语言和译文语言不能相同。');return}
 try{localStorage.setItem(TRANSLATE_LANG_KEY,JSON.stringify({source,target}))}catch{}
 applyTranslateLanguage(source,target);
 $('translateLangDialog').close();
 document.dispatchEvent(new CustomEvent('translate-language-change',{detail:{source,target}}));
 toast('翻译语言已更新为 '+TRANSLATE_LANG_NAMES[source]+' → '+TRANSLATE_LANG_NAMES[target]);
};
(function initTranslateLanguage(){
 const {source,target}=storedTranslateLanguage();
 applyTranslateLanguage(source,target);
})();
