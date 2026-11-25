/**
 * [INPUT]: 读取当前工作台的计划、保存网页和附件阅读进度。
 * [OUTPUT]: 渲染总览问候语、多彩 Bento 精读进度环卡片与近期计划卡片。
 * [POS]: 总览首屏核心交互层，复用阅读器与计划详情入口，阅读进度精确到单个附件。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

const BENTO_TONES = ['blue', 'amber', 'emerald', 'violet'];
const BENTO_ART = {
  pdf: '<svg class="bento-watermark" viewBox="0 0 88 88" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="18" y="12" width="46" height="60" rx="7"/><path d="M28 28h26M28 39h26M28 50h16"/><circle cx="62" cy="60" r="14"/><path d="m72 70 8 8"/></svg>',
  ppt: '<svg class="bento-watermark" viewBox="0 0 88 88" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="10" y="16" width="68" height="46" rx="8"/><path d="M44 62v14m-16 0h32M24 46l13-12 10 8 17-16"/></svg>',
  video: '<svg class="bento-watermark" viewBox="0 0 88 88" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="10" y="18" width="68" height="50" rx="10"/><polygon points="38,33 38,53 56,43" fill="currentColor" stroke="none"/><path d="M22 76h44"/></svg>',
  web: '<svg class="bento-watermark" viewBox="0 0 88 88" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="44" cy="44" r="30"/><ellipse cx="44" cy="44" rx="13" ry="30"/><path d="M15 36h58M15 52h58"/></svg>'
};

function recentHomeReadings(profile, limit = 4) {
  const reading = profile.reading || {};
  const items = [];
  function pushItem(record, file, openedAt, label, kindKey, pct) {
    const timestamp = Date.parse(openedAt);
    if (!Number.isFinite(timestamp)) return;
    const clamped = Math.max(4, Math.min(99, Math.round(Number(pct) || 12)));
    items.push({ record, file, timestamp, label, kindKey, pct: clamped });
  }
  for (const record of profile.records) {
    if (record.type !== 'resource') continue;
    const finished = record.status === '已读';
    if (record.webArticle) {
      if (finished) continue;
      const saved = getWebCheckpoint(record, profile.id);
      if (record.attachments?.some(file => file.webRole === 'article')) {
        const pct = Math.round((saved.scroll || 0) * 100);
        pushItem(record, null, saved.updatedAt, saved.mode === 'snapshot' ? '网页快照' : '网页 · 已读 ' + pct + '%', 'web', pct || 18);
      }
      continue;
    }
    const files = (record.attachments || []).filter(file => fileIsPdf(file) || fileIsVideo(file) || fileIsPresentation(file));
    if (!files.length || (finished && files.length === 1)) continue;
    const legacy = loadReadingCheckpoint(profile.id, record.id, reading[record.id] || record.readerProgress);
    const legacyFile = finished || record.attachments.some(file => reading[file.id]) ? null : legacyReadingAttachment(record, legacy);
    for (const file of files) {
      const saved = loadReadingCheckpoint(profile.id, file.id, reading[file.id]) || (legacyFile?.id === file.id ? legacy : null);
      if (!saved || saved.finished) continue;
      const isPpt = saved.kind === 'presentation' || fileIsPresentation(file);
      const isVideo = saved.kind === 'video';
      const kindLabel = isVideo ? '视频' : isPpt ? 'PPT' : 'PDF';
      const kindKey = isVideo ? 'video' : isPpt ? 'ppt' : 'pdf';
      const pct = isVideo
        ? (saved.duration > 0 ? (saved.time / saved.duration) * 100 : 20)
        : (saved.pages > 0 ? (saved.page / saved.pages) * 100 : 25);
      const label = [kindLabel, files.length > 1 ? file.name : '', progressLabel(saved)].filter(Boolean).join(' · ');
      pushItem(record, file, saved.lastOpened, label, kindKey, pct);
    }
  }
  return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

function renderProgressRing(pct) {
  const r = 18, c = +(2 * Math.PI * r).toFixed(2);
  const offset = +(c * (1 - pct / 100)).toFixed(2);
  return '<span class="bento-ring" aria-hidden="true"><svg viewBox="0 0 44 44">'
    + '<circle class="bento-ring-track" cx="22" cy="22" r="' + r + '"/>'
    + '<circle class="bento-ring-fill" cx="22" cy="22" r="' + r + '" stroke-dasharray="' + c + '" style="--ring-circumference:' + c + ';--ring-offset:' + offset + '"/>'
    + '</svg><b>' + pct + '%</b></span>';
}

function homeReadingMarkup(items) {
  if (!items.length) {
    return '<div class="bento-empty-hero">'
      + '<div class="bento-empty-copy"><p class="home-empty">暂无可继续阅读的资料，导入论文 PDF、课程 PPT 或公开网页即可开启精读进度追踪。</p>'
      + '<div class="bento-empty-actions">'
      + '<button type="button" class="home-link bento-cta-pill" data-home-library>打开资料库 <span aria-hidden="true">→</span></button>'
      + '<button type="button" class="home-link bento-cta-ghost" data-home-capture-web>收藏网页</button>'
      + '</div></div>' + BENTO_ART.pdf + '</div>';
  }
  const kindBadges = { pdf: 'PDF 文献', ppt: 'PPT 讲义', video: '课程视频', web: '离线网页' };
  const toneByKind = { pdf: 'blue', ppt: 'amber', video: 'emerald', web: 'violet' };
  const usedTones = new Set();
  const cards = items.map((item, idx) => {
    const { record, file, label, kindKey, pct } = item;
    let tone = toneByKind[kindKey] || 'blue';
    if (usedTones.has(tone)) tone = BENTO_TONES.find(t => !usedTones.has(t)) || BENTO_TONES[idx % BENTO_TONES.length];
    usedTones.add(tone);
    return '<button type="button" class="home-resume-entry bento-study-card" data-bento-tone="' + tone + '" style="--stagger-i:' + idx + '" title="' + esc(record.title) + '" data-home-resume="' + esc(record.id) + '" data-home-file="' + esc(file?.id || '') + '">'
      + '<span class="bento-card-top"><span class="bento-kind-pill">' + kindBadges[kindKey] + '</span><span class="home-resume-arrow" aria-hidden="true">↗</span></span>'
      + '<span class="home-resume-text"><strong>' + esc(record.title) + '</strong><small>' + esc(label) + '</small></span>'
      + '<span class="bento-card-foot">' + renderProgressRing(pct) + '</span>'
      + (BENTO_ART[kindKey] || BENTO_ART.pdf) + '</button>';
  });
  return '<div class="bento-study-grid count-' + items.length + '">' + cards.join('') + '</div>';
}

function homePlanMarkup(plans) {
  const day = today();
  const tones = ['blue', 'emerald', 'amber', 'violet'];
  return '<ul class="home-plan-list">' + plans.map((plan, idx) => {
    const remaining = countdownDays(plan.planEnd, day);
    const date = plan.planEnd.slice(5).replace('-', '/');
    const start = plan.planStart.slice(5).replace('-', '/');
    const deadline = remaining < 0 ? '已逾期' : remaining === 0 ? '今天截止' : date + ' 截止';
    const title = esc(plan.title);
    const tone = remaining < 0 ? 'overdue' : tones[idx % tones.length];
    return '<li><button type="button" class="home-plan-entry" data-plan-tone="' + tone + '" title="' + title + '" data-home-plan="' + esc(plan.id) + '">'
      + '<span class="home-plan-icon" aria-hidden="true">' + svg('calendar') + '</span>'
      + '<span class="home-plan-body"><span class="home-plan-name">' + title + '</span><small class="home-plan-range">' + esc(start + ' – ' + date) + '</small></span>'
      + '<time datetime="' + esc(plan.planEnd) + '"' + (remaining < 0 ? ' class="home-overdue"' : '') + '>' + deadline + '</time></button></li>';
  }).join('') + '</ul>';
}

function syncHomeGreeting(profile) {
  const host = $('workspaceIntro')?.firstElementChild;
  if (!host) return;
  let greet = $('homeGreeting');
  if (view !== 'all' || !profile) {
    if (greet) greet.hidden = true;
    return;
  }
  if (!greet) {
    greet = document.createElement('p');
    greet.id = 'homeGreeting';
    greet.className = 'home-greeting-eyebrow';
    host.prepend(greet);
  }
  const hour = new Date().getHours();
  const period = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  greet.textContent = period + '，' + (profile.name || '研究者') + ' · 欢迎回到灵感与文献工作台';
  greet.hidden = false;
}

function renderWorkspaceHome() {
  const home = $('workspaceHome'), profile = activeProfile();
  syncHomeGreeting(profile);
  home.hidden = view !== 'all' || !profile;
  if (home.hidden) return;
  const readings = recentHomeReadings(profile, 4);
  $('homeResume').innerHTML = '<div class="home-section-head"><h2>' + svg('book') + '正在精读</h2>'
    + (readings.length ? '<button type="button" class="home-link" data-home-library>全部资料 <span aria-hidden="true">→</span></button>' : '')
    + '</div>' + homeReadingMarkup(readings);
  const upcoming = $('homePlans');
  upcoming.hidden = !activeCategory('plan');
  if (upcoming.hidden) return;
  const plans = profile.records.filter(plan => plan.type === 'plan' && !archivedPlan(plan) && validPlanDates(plan.planStart, plan.planEnd))
    .sort((a, b) => a.planEnd.localeCompare(b.planEnd) || a.planStart.localeCompare(b.planStart)).slice(0, 4);
  upcoming.innerHTML = '<div class="home-plan-heading"><h2>' + svg('calendar') + '近期计划</h2>'
    + (plans.length ? '<button type="button" class="home-link" data-home-all-plans>全部计划 <span aria-hidden="true">→</span></button>' : '')
    + '</div>' + (plans.length ? homePlanMarkup(plans) : '<div class="home-plan-empty"><p class="home-empty">暂无待完成的计划，设定阶段目标让研究更有节奏。</p>'
      + '<button type="button" class="home-link bento-cta-pill" data-home-create-plan>＋ 新建计划</button></div>');
}

$('workspaceHome').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || !ready) return;
  if (button.hasAttribute('data-home-library')) { switchView('resource'); return; }
  if (button.hasAttribute('data-home-capture-web')) { $('captureWebPage')?.click(); return; }
  if (button.hasAttribute('data-home-all-plans')) { switchView('plan'); return; }
  if (button.hasAttribute('data-home-create-plan')) { openNewWorkspaceRecord('plan'); return; }
  if (button.dataset.homePlan) { showDetail(button.dataset.homePlan); return; }
  const record = records.find(note => note.id === button.dataset.homeResume && note.type === 'resource');
  if (!record) return;
  if (record.webArticle) { void openSavedWebpage(record); return; }
  const file = record.attachments?.find(item => item.id === button.dataset.homeFile);
  if (file) void openAttachment(file);
});
if (ready) renderWorkspaceHome();
