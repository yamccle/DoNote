'use strict';
// 翻译语言对：放在设置里维护，阅读器面板只显示当前语言并可一键打开设置。
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
 if(event.target.closest('#pdfLangSettings,#openTranslateLangDialog'))openTranslateLangDialog();
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
