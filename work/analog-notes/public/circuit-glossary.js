'use strict';

const circuitGlossaryDefaults=[
 ['successive approximation register','逐次逼近寄存器'],['successive approximation','逐次逼近'],
 ['operational transconductance amplifier','运算跨导放大器'],['operational amplifier','运算放大器'],
 ['phase-locked loop','锁相环'],['phase noise','相位噪声'],['charge pump','电荷泵'],
 ['voltage-controlled oscillator','压控振荡器'],['differential nonlinearity','微分非线性'],
 ['integral nonlinearity','积分非线性'],['effective number of bits','有效位数'],
 ['signal-to-noise and distortion ratio','信噪失真比'],['figure of merit','品质因数'],
 ['comparator','比较器'],['transconductance','跨导'],['sampling rate','采样率'],
 ['switching capacitor','开关电容'],['common-mode rejection ratio','共模抑制比'],
 ['power supply rejection ratio','电源抑制比'],['gain bandwidth product','增益带宽积'],
 ['slew rate','压摆率'],['thermal noise','热噪声'],['offset voltage','失调电压'],
 ['bandgap reference','带隙基准'],['low-dropout regulator','低压差稳压器']
];
const circuitGlossaryKey=profileId=>'donote-circuit-glossary/'+profileId;
function circuitGlossary(profileId=appState.activeId){
 try{
  const saved=JSON.parse(localStorage.getItem(circuitGlossaryKey(profileId)));
  if(Array.isArray(saved)&&saved.every(row=>Array.isArray(row)&&row.length===2&&row.every(value=>typeof value==='string')))return saved;
 }catch{}
 return circuitGlossaryDefaults;
}
function circuitGlossaryMatches(text,profileId){
 return circuitGlossary(profileId).filter(([english])=>new RegExp(
  '(?<![A-Za-z0-9])'+english.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9])','i').test(text));
}
function openCircuitGlossary(profileId,onSave){
 const dialog=document.createElement('dialog');
 dialog.innerHTML='<form method="dialog"><h2>模拟电路术语库</h2><p>每行填写一组术语，英文和中文之间用制表符或等号分隔。</p><textarea aria-label="术语库" rows="15" style="width:100%"></textarea><p role="status"></p><button type="button" data-default>恢复默认表</button> <button type="submit" value="cancel">取消</button> <button type="button" data-save>保存术语</button></form>';
 const input=dialog.querySelector('textarea'),status=dialog.querySelector('[role=status]');
 const fill=rows=>{input.value=rows.map(row=>row.join(' = ')).join('\n');};
 fill(circuitGlossary(profileId));
 dialog.querySelector('[data-default]').onclick=()=>fill(circuitGlossaryDefaults);
 dialog.querySelector('[data-save]').onclick=()=>{
  const lines=input.value.split('\n').map(line=>line.trim()).filter(Boolean);
  const rows=lines.map(line=>line.split(/\t|=/).map(value=>value.trim()));
  if(rows.length>500||rows.some(row=>row.length!==2||row.some(value=>!value||value.length>120))||
    new Set(rows.map(([term])=>term.toLowerCase())).size!==rows.length){
   status.textContent='请检查格式和重复术语。最多 500 条，每项 120 字。';return;
  }
  try{localStorage.setItem(circuitGlossaryKey(profileId),JSON.stringify(rows));}
  catch(error){status.textContent='保存术语库失败。';return;}
  dialog.close();onSave();
 };
 dialog.addEventListener('close',()=>dialog.remove(),{once:true});
 document.body.append(dialog);dialog.showModal();
}
function bindCircuitGlossary(session,panel,input,result){
 const section=document.createElement('details');
 section.innerHTML='<summary>术语核对</summary><p class="tiny">对照英文原文与推荐译法，点击术语可把译法插入译文。</p><div data-terms></div><button type="button" class="secondary">编辑术语库</button>';
 result.closest('textarea').after(section);
 const terms=section.querySelector('[data-terms]');
 const refresh=()=>{
  terms.replaceChildren();
  const matches=circuitGlossaryMatches(input.value,session.profileId);
  for(const [english,chinese] of matches){
   const button=document.createElement('button');button.type='button';button.className='secondary';
   button.textContent=english+' → '+chinese;
   button.onclick=()=>{result.setRangeText(chinese,result.selectionStart,result.selectionEnd,'end');result.focus();};
   terms.append(button);
  }
  if(!matches.length)terms.textContent='当前原文没有命中术语。';
 };
 input.addEventListener('input',refresh,{signal:session.controller.signal});
 section.addEventListener('toggle',refresh,{signal:session.controller.signal});
 section.querySelector(':scope > button').onclick=()=>openCircuitGlossary(session.profileId,refresh);
 refresh();
 return refresh;
}
