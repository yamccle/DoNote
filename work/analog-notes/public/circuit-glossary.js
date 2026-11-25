/**
 * [INPUT]: 读取当前工作台的专业术语词库与翻译面板原文。
 * [OUTPUT]: 提供 circuitGlossaryMatches、openCircuitGlossary 与 bindCircuitGlossary。
 * [POS]: 嵌入翻译双栏卡片中段，命中专业术语时展示一键插入胶囊，未命中时收敛为轻量词库入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const circuitGlossaryDefaults=[
 ['ablation study','消融实验'],['confidence interval','置信区间'],
 ['ground truth','基准真值'],['state of the art','当前最优水平'],
 ['trade-off','权衡折中'],['bottleneck','性能瓶颈'],
 ['generalization','泛化能力'],['null hypothesis','零假设'],
 ['statistical significance','统计显著性'],['closed-form','解析闭式解'],
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
 dialog.className='circuit-glossary-dialog';
 dialog.innerHTML='<form method="dialog"><div class="modalhead"><h2>专业术语词库</h2><button type="submit" class="icon-button" value="cancel" aria-label="关闭">✕</button></div><div class="modalbody"><p class="section-note">可自定义本学科/本领域的双语对照词表，每行填写一组术语，外文与中文之间用等号（=）或制表符分隔。</p><textarea aria-label="术语库" rows="13" style="width:100%"></textarea><p class="form-message" role="status"></p></div><div class="modalfoot"><button type="button" class="secondary" data-default>恢复默认表</button><button type="submit" class="secondary" value="cancel">取消</button><button type="button" class="primary" data-save>保存术语</button></div></form>';
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
 const host=panel.querySelector('#pdfGlossarySlot');
 const bar=document.createElement('div');
 bar.className='pdf-glossary-bar';
 bar.innerHTML='<div class="pdf-glossary-head"><span class="pdf-glossary-title"></span><button type="button" class="link-button pdf-glossary-edit">术语库</button></div><div class="pdf-glossary-chips" data-terms></div>';
 if(host)host.replaceChildren(bar);
 else panel.querySelector('.pdf-translate-doc')?.after(bar);
 const title=bar.querySelector('.pdf-glossary-title');
 const terms=bar.querySelector('[data-terms]');
 const refresh=()=>{
  terms.replaceChildren();
  const matches=circuitGlossaryMatches(input.value,session.profileId);
  bar.classList.toggle('has-matches',matches.length>0);
  title.textContent=matches.length?'命中 '+matches.length+' 个专业术语（点击插入译文）':'未命中预设专业术语';
  terms.hidden=!matches.length;
  for(const [english,chinese] of matches){
   const chip=document.createElement('button');chip.type='button';chip.className='pdf-glossary-chip';
   chip.innerHTML='<span>'+esc(english)+'</span><i aria-hidden="true">→</i><b>'+esc(chinese)+'</b>';
   chip.title='点击将「'+chinese+'」插入译文光标处';
   chip.onclick=()=>{
    result.setRangeText(chinese,result.selectionStart,result.selectionEnd,'end');
    result.dispatchEvent(new Event('input'));
    result.focus();
   };
   terms.append(chip);
  }
 };
 input.addEventListener('input',refresh,{signal:session.controller.signal});
 bar.querySelector('.pdf-glossary-edit').onclick=()=>openCircuitGlossary(session.profileId,refresh);
 refresh();
 return refresh;
}
