(function(){
 'use strict';
 const key='analog-ui-theme',paletteKey='donote-ui-palette',system=matchMedia('(prefers-color-scheme: dark)');
 const palettes={default:'默认',warm:'暖灰',mist:'雾蓝',sage:'鼠尾草绿',sand:'柔沙棕'};
 let preference='system';
 try{const stored=localStorage.getItem(key);if(['light','dark','system'].includes(stored))preference=stored}catch{}
 function applyPalette(value,remember=false){
  const name=Object.hasOwn(palettes,value)?value:'default';document.documentElement.dataset.palette=name;
  if(remember)try{localStorage.setItem(paletteKey,name)}catch{}
  const select=document.getElementById('desktopPalette');if(select)select.value=name;
 }
 function applyTheme(value,remember=false){
  preference=['light','dark','system'].includes(value)?value:'system';
  const theme=preference==='system'?(system.matches?'dark':'light'):preference,root=document.documentElement;
  if(root.dataset.theme!==theme){root.classList.add('theme-fade');clearTimeout(applyTheme.fade);applyTheme.fade=setTimeout(()=>root.classList.remove('theme-fade'),280)}
  root.dataset.themeMode=preference;root.dataset.theme=theme;root.style.colorScheme=theme;
  if(remember)try{localStorage.setItem(key,preference)}catch{}
  document.querySelectorAll('[data-theme-toggle]').forEach(button=>{button.textContent=theme==='dark'?'☾ 夜间':'☀ 白天';button.setAttribute('role','switch');button.setAttribute('aria-checked',String(theme==='dark'));button.setAttribute('aria-label','夜间模式');button.title=theme==='dark'?'切换到白天模式':'切换到夜间模式'});
  const select=document.getElementById('desktopThemeMode');if(select)select.value=preference;
  window.dispatchEvent(new Event('donote-theme-change'));
 }
 let palette='default';try{palette=localStorage.getItem(paletteKey)||palette}catch{}applyPalette(palette);
 window.DoNoteAppearance={palettes,applyPalette,applyTheme};
 applyTheme(preference);
 document.addEventListener('DOMContentLoaded',()=>applyTheme(preference),{once:true});
 document.addEventListener('click',e=>{if(e.target.closest('[data-theme-toggle]'))applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark',true)});
 system.addEventListener('change',()=>{if(preference==='system')applyTheme('system')});
 window.addEventListener('storage',e=>{if(e.key===key)applyTheme(e.newValue);if(e.key===paletteKey)applyPalette(e.newValue)});
})();
