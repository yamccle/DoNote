/**
 * [INPUT]: 读取当前工作台记录、阅读进度检查点、本地活跃日期与专注时长统计。
 * [OUTPUT]: 提供每日打开/使用足迹追踪器 DoNoteUsage 与十张典藏成就卡牌系统 DoNoteAchievements。
 * [POS]: 衔接总览活跃热力图与「成就殿宇」3D 翻面展示，兼顾入门即时反馈与长期学术陪伴。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(() => {
  const USAGE_PREFIX = 'donote-usage-v1/';

  function readUsageStore(profileId) {
    if (!profileId) return { days: {}, focusMinutes: 0 };
    try {
      const parsed = JSON.parse(localStorage.getItem(USAGE_PREFIX + profileId) || '{}');
      const days = parsed && typeof parsed.days === 'object' && !Array.isArray(parsed.days) ? parsed.days : {};
      const focusMinutes = Math.max(0, Math.floor(Number(parsed?.focusMinutes) || 0));
      return { days, focusMinutes };
    } catch {
      return { days: {}, focusMinutes: 0 };
    }
  }

  function writeUsageStore(profileId, store) {
    if (!profileId) return;
    try {
      const entries = Object.entries(store.days || {}).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(([a], [b]) => a.localeCompare(b)).slice(-400);
      localStorage.setItem(USAGE_PREFIX + profileId, JSON.stringify({
        days: Object.fromEntries(entries),
        focusMinutes: Math.max(0, Math.floor(Number(store.focusMinutes) || 0))
      }));
    } catch {}
  }

  function markTodayActive(addMinutes = 0) {
    const profile = typeof activeProfile === 'function' ? activeProfile() : null;
    if (!profile?.id) return;
    const day = today();
    const store = readUsageStore(profile.id);
    const prev = Number(store.days[day]) || 0;
    const nextMin = prev + Math.max(0, addMinutes);
    store.days[day] = Math.max(1, nextMin);
    if (addMinutes > 0) store.focusMinutes = (store.focusMinutes || 0) + addMinutes;
    else if (!store.focusMinutes) store.focusMinutes = 1;
    writeUsageStore(profile.id, store);
  }

  function collectActiveDays(profile) {
    const set = new Set();
    if (!profile) return set;
    const store = readUsageStore(profile.id);
    for (const d of Object.keys(store.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
    if (Array.isArray(profile.usageDays)) {
      for (const d of profile.usageDays) if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
    }
    for (const note of profile.records || []) {
      if (note.flashcardKind) continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(note.date || '')) set.add(note.date);
      const created = String(note.createdAt || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(created)) set.add(created);
      const updated = String(note.updatedAt || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(updated)) set.add(updated);
      const webOpened = String(note.webReading?.updatedAt || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(webOpened)) set.add(webOpened);
    }
    for (const cp of Object.values(profile.reading || {})) {
      const opened = String(cp?.lastOpened || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(opened)) set.add(opened);
    }
    if (profile.id === appState?.activeId) set.add(today());
    return set;
  }

  function getTotalFocusMinutes(profile) {
    if (!profile) return 0;
    const store = readUsageStore(profile.id);
    const archived = Math.max(0, Math.floor(Number(profile.focusMinutes) || 0));
    const daysCount = collectActiveDays(profile).size;
    return Math.max(store.focusMinutes || 0, archived, daysCount * 5);
  }

  window.DoNoteUsage = {
    markTodayActive,
    collectActiveDays,
    getTotalFocusMinutes,
    exportForBackup(profile) {
      const days = [...collectActiveDays(profile)].sort().slice(-400);
      return { usageDays: days, focusMinutes: getTotalFocusMinutes(profile) };
    },
    mergeFromBackup(profile, source) {
      if (!profile?.id || !source) return;
      const store = readUsageStore(profile.id);
      for (const d of source.usageDays || []) {
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !store.days[d]) store.days[d] = 1;
      }
      if (Number.isFinite(source.focusMinutes)) {
        store.focusMinutes = Math.max(store.focusMinutes || 0, Math.floor(source.focusMinutes));
      }
      writeUsageStore(profile.id, store);
    }
  };

  // 生成高雅暖羊皮纸蚀刻插画 SVG Data URI（与 001 卡面风格一脉相承）
  function makeCardArt(bgTop, bgBot, accent, motifSvg, emblem) {
    const svgXml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 480">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bgTop}"/>
          <stop offset="100%" stop-color="${bgBot}"/>
        </linearGradient>
        <radialGradient id="r" cx="50%" cy="40%" r="52%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="360" height="480" fill="url(#g)"/>
      <rect width="360" height="480" fill="url(#r)"/>
      <rect x="18" y="18" width="324" height="444" rx="12" fill="none" stroke="${accent}" stroke-opacity="0.32" stroke-width="1.2"/>
      <rect x="26" y="26" width="308" height="428" rx="8" fill="none" stroke="${accent}" stroke-opacity="0.16" stroke-dasharray="4 4"/>
      <text x="180" y="64" text-anchor="middle" fill="${accent}" fill-opacity="0.72" font-family="Georgia,serif" font-size="11" letter-spacing="4">${emblem}</text>
      <g transform="translate(180,232)" stroke="${accent}" fill="none" stroke-linecap="round" stroke-linejoin="round">${motifSvg}</g>
      <circle cx="180" cy="414" r="3" fill="${accent}" fill-opacity="0.5"/>
      <path d="M128 414h40M192 414h40" stroke="${accent}" stroke-opacity="0.32" stroke-width="1"/>
    </svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svgXml);
  }

  const ACHIEVEMENT_CARDS = [
    {
      kind: 'analog-v1', number: '001', title: '信号路径 · 初心', badge: '起源纪念',
      image: 'analog-flashcard.png',
      eyebrow: 'ORIGIN · ANALOG IC · 001',
      headline: '先理解信号路径，\n再优化每个指标。',
      quote: 'DoNote 诞生于模拟集成电路研究现场：从输入到输出，标出增益、带宽、噪声与反馈。无论后来走向哪门学科，回到第一性路径印证，始终是研究的起点。',
      rule: '建立工作台并开启第一次阅读或记录（或轻点关于页版本号 5 次）',
      progress(p) {
        const count = (p.records || []).filter(r => !r.flashcardKind).length;
        const unlocked = (p.records || []).some(r => r.flashcardKind === 'analog-v1');
        return { current: unlocked || count >= 1 ? 1 : 0, target: 1, unit: '次启程', auto: count >= 1 };
      }
    },
    {
      kind: 'scholar-first-doc', number: '002', title: '开卷有得', badge: '文献入门',
      image: makeCardArt('#f7f1e6', '#ebe0cc', '#7c5832',
        '<rect x="-56" y="-68" width="112" height="136" rx="8" stroke-width="2.2"/><path d="M-34-34h68M-34-12h68M-34 10h46" stroke-width="2"/><circle cx="32" cy="42" r="24" fill="#f7f1e6" stroke-width="2.2"/><path d="m49 59 18 18" stroke-width="2.6"/>',
        'FIRST DOCUMENT'),
      eyebrow: 'LITERATURE · 002',
      headline: '每一座知识大厦，\n都始于第一篇精读文献。',
      quote: '把散落在文件夹里的论文、讲义或网页正式收入资料库的那一刻，碎片信息便开始沉淀为可回溯的知识资产。',
      rule: '向「文献与媒体库」导入或收藏第 1 份资料',
      progress(p) {
        const docs = (p.records || []).filter(r => !r.flashcardKind && r.type === 'resource').length;
        return { current: Math.min(docs, 1), target: 1, unit: '份资料', auto: docs >= 1 };
      }
    },
    {
      kind: 'scholar-library-10', number: '003', title: '博观约取', badge: '馆藏积累',
      image: makeCardArt('#eef2f6', '#dde6f0', '#365880',
        '<rect x="-66" y="-52" width="28" height="110" rx="4" stroke-width="2"/><rect x="-32" y="-64" width="28" height="122" rx="4" stroke-width="2"/><rect x="2" y="-46" width="28" height="104" rx="4" stroke-width="2"/><g transform="rotate(-12 52 6)"><rect x="38" y="-50" width="28" height="108" rx="4" stroke-width="2"/></g><path d="M-78 62h156" stroke-width="2.2"/>',
        'CURATED LIBRARY'),
      eyebrow: 'COLLECTION · 003',
      headline: '广博涉猎而后精挑细选，\n方见学科全貌。',
      quote: '十份精选文献足以勾勒一个子领域的脉络。交叉比对不同作者的假设与边界，正是独立判断生根的地方。',
      rule: '「文献与媒体库」累计收录满 10 份文献、讲义或视频资料',
      progress(p) {
        const docs = (p.records || []).filter(r => !r.flashcardKind && r.type === 'resource').length;
        return { current: Math.min(docs, 10), target: 10, unit: '份资料', auto: docs >= 10 };
      }
    },
    {
      kind: 'scholar-annotator', number: '004', title: '不动笔墨', badge: '深度精读',
      image: makeCardArt('#f6efe8', '#eadbcf', '#8f4f2b',
        '<path d="M-52 52 -36 4 32-64 64-32 -4 36Z" stroke-width="2.2"/><path d="M20-52 52-20M-36 4 -4 36" stroke-width="1.8"/><path d="M-64 68h128" stroke-width="2"/><circle cx="-18" cy="-42" r="14" stroke-dasharray="3 3" stroke-width="1.6"/>',
        'DEEP ANNOTATION'),
      eyebrow: 'CLOSE READING · 004',
      headline: '阅读是借他人之眼，\n批注才是与作者对话。',
      quote: '高亮一处关键推导、留下一行页边批注，或将证据摘录回跳至课题记录——思考留下的锚点，胜过匆匆翻阅百页。',
      rule: '累计建立 3 条包含原文引用锚点（PDF / PPT / 网页摘录）或阅读笔记的记录',
      progress(p) {
        const notes = (p.records || []).filter(r => !r.flashcardKind && (r.type === 'paper' || r.pdfSource || r.webSource || (r.pdfEvidence && r.pdfEvidence.length))).length;
        return { current: Math.min(notes, 3), target: 3, unit: '条精读沉淀', auto: notes >= 3 };
      }
    },
    {
      kind: 'scholar-questioner', number: '005', title: '叩问真知', badge: '课题攻坚',
      image: makeCardArt('#eff4f1', '#dce8e1', '#2d6a54',
        '<circle cx="0" cy="0" r="68" stroke-width="2"/><circle cx="0" cy="0" r="46" stroke-dasharray="4 4" stroke-width="1.4"/><polygon points="26,-26 8,8 -26,26 -8,-8" stroke-width="2.2" fill="#2d6a54" fill-opacity="0.15"/><path d="M0-78v14M0 64v14M-78 0h14M64 0h14" stroke-width="2"/>',
        'INQUIRY & PROOF'),
      eyebrow: 'PROBLEM SOLVING · 005',
      headline: '提出一个好问题，\n往往比答案更接近本质。',
      quote: '把模糊的困惑拆解为可验证的假设，记录每一次受挫与闭环。被真正解决过的问题，会成为你最坚实的直觉。',
      rule: '累计记录满 5 项「问题与课题」且至少将 1 项推进至已解决',
      progress(p) {
        const issues = (p.records || []).filter(r => !r.flashcardKind && r.type === 'issue');
        const solved = issues.some(r => r.status === '已解决');
        const score = Math.min(issues.length, 4) + (solved && issues.length >= 5 ? 1 : 0);
        return { current: issues.length >= 5 && solved ? 5 : Math.min(score, 4), target: 5, unit: '项课题进展', auto: issues.length >= 5 && solved };
      }
    },
    {
      kind: 'scholar-architect', number: '006', title: '经纬有序', badge: '知识建构',
      image: makeCardArt('#f2f0f7', '#e3def0', '#534982',
        '<circle cx="0" cy="-48" r="14" stroke-width="2.2"/><circle cx="-48" cy="36" r="14" stroke-width="2.2"/><circle cx="48" cy="36" r="14" stroke-width="2.2"/><circle cx="0" cy="6" r="10" fill="#534982" fill-opacity="0.2" stroke-width="2"/><path d="M-8-36 -38 24M8-36 38 24M-34 36h68M0-34v30" stroke-width="1.8"/>',
        'TAXONOMY & PLAN'),
      eyebrow: 'SYSTEM ARCHITECT · 006',
      headline: '秩序赋予记忆结构，\n计划赋予探索节奏。',
      quote: '用文件夹梳理层级，用标签串联跨界主题，再用阶段计划锚定航向——外在的知识秩序，终将内化为清晰的思维框架。',
      rule: '建立归档文件夹、制定至少 1 项阶段计划，并积累 5 条带标签记录',
      progress(p) {
        const hasFolder = (p.folders || []).length >= 1;
        const hasPlan = (p.records || []).some(r => !r.flashcardKind && r.type === 'plan');
        const tagged = (p.records || []).filter(r => !r.flashcardKind && (r.tags || []).length > 0).length;
        const pts = (hasFolder ? 1 : 0) + (hasPlan ? 1 : 0) + Math.min(3, Math.floor(tagged / 2));
        const ok = hasFolder && hasPlan && tagged >= 5;
        return { current: ok ? 5 : Math.min(pts, 4), target: 5, unit: '项体系要素', auto: ok };
      }
    },
    {
      kind: 'time-days-7', number: '007', title: '晨昏七日', badge: '时间沉淀',
      image: makeCardArt('#f7f3e8', '#ece2c8', '#8a6829',
        '<circle cx="0" cy="0" r="64" stroke-width="2"/><path d="M-28-46A54 54 0 1 0 46 28 42 42 0 1 1 -28-46Z" stroke-width="2" fill="#8a6829" fill-opacity="0.14"/><g stroke-width="1.8"><circle cx="0" cy="-78" r="3"/><circle cx="55" cy="-55" r="3"/><circle cx="78" cy="0" r="3"/><circle cx="55" cy="55" r="3"/><circle cx="0" cy="78" r="3"/><circle cx="-55" cy="55" r="3"/><circle cx="-78" cy="0" r="3"/></g>',
        'SEVEN DAYS'),
      eyebrow: 'CONSISTENCY · 007',
      headline: '日拱一卒无有尽，\n功不唐捐终入海。',
      quote: '比一时灵感更珍贵的，是连续回到书案前的平静习惯。七个自然日的打开与耕耘，足以让思考进入稳定的心流节律。',
      rule: '累计在 7 个不同自然日打开并使用工作台（需随时间推移达成）',
      progress(p) {
        const days = collectActiveDays(p).size;
        return { current: Math.min(days, 7), target: 7, unit: '个活跃日', auto: days >= 7 };
      }
    },
    {
      kind: 'time-hours-5', number: '008', title: '潜心十刻', badge: '专注时长',
      image: makeCardArt('#eef3f6', '#dbe6ec', '#355f73',
        '<path d="M-42-64h84L14-4 42 64h-84L-14-4Z" stroke-width="2.2"/><path d="M-48-64h96M-48 64h96" stroke-width="2.6"/><path d="M-24 52h48L0 18Z" fill="#355f73" fill-opacity="0.24" stroke="none"/><circle cx="0" cy="-24" r="3" fill="#355f73"/>',
        'DEEP FOCUS · 5H'),
      eyebrow: 'IMMERSION · 008',
      headline: '唯有不被打扰的时光，\n能锻造真正的洞见。',
      quote: '三百分钟的沉浸阅读与推演，是快餐信息时代最奢侈的投入。时间流过字里行间的痕迹，都已沉淀在你的判断力之中。',
      rule: '在工作台中累计专注使用时长满 300 分钟（5 小时）',
      progress(p) {
        const mins = getTotalFocusMinutes(p);
        return { current: Math.min(mins, 300), target: 300, unit: '分钟专注', auto: mins >= 300 };
      }
    },
    {
      kind: 'time-days-30', number: '009', title: '弦歌不辍', badge: '长期主义',
      image: makeCardArt('#f0f4ee', '#dfe8da', '#42693e',
        '<path d="M0 68V-20" stroke-width="2.6"/><path d="M0 24C-34 20-52-4-48-34-18-36 0-12 0 24Z" stroke-width="2" fill="#42693e" fill-opacity="0.14"/><path d="M0 4C34 0 52-24 48-54 18-56 0-32 0 4Z" stroke-width="2" fill="#42693e" fill-opacity="0.14"/><circle cx="0" cy="-58" r="14" stroke-width="2"/><path d="M-36 68h72" stroke-width="2.2"/>',
        'THIRTY DAYS'),
      eyebrow: 'ENDURANCE · 009',
      headline: '流水不争先，\n争的是滔滔不绝。',
      quote: '三十个日夜的持续打开、阅读与复盘，让这里不再只是一款工具，而成为伴随你跨越课题周期的第二大脑。',
      rule: '累计在 30 个不同自然日打开并使用工作台（长期陪伴解锁）',
      progress(p) {
        const days = collectActiveDays(p).size;
        return { current: Math.min(days, 30), target: 30, unit: '个活跃日', auto: days >= 30 };
      }
    },
    {
      kind: 'master-pantheon', number: '010', title: '知识星河', badge: '殿堂终章',
      image: makeCardArt('#1d2433', '#121722', '#d4b475',
        '<ellipse cx="0" cy="0" rx="74" ry="28" transform="rotate(-24)" stroke-width="1.8"/><ellipse cx="0" cy="0" rx="74" ry="28" transform="rotate(24)" stroke-width="1.8"/><circle cx="0" cy="0" r="16" fill="#d4b475" fill-opacity="0.22" stroke-width="2.2"/><circle cx="-54" cy="-22" r="4" fill="#d4b475"/><circle cx="52" cy="24" r="4" fill="#d4b475"/><circle cx="0" cy="-68" r="3" fill="#d4b475"/>',
        'KNOWLEDGE COSMOS'),
      eyebrow: 'PANTHEON · 010',
      headline: '当点滴思考彼此相连，\n便成照亮未知的星河。',
      quote: '百篇记录与跨越半月的深耕在此交汇。从第一条信号路径出发，如今你已拥有一片完全属于自己、自主可控的知识宇宙。',
      rule: '工作台累计满 100 条记录且累计活跃满 15 天',
      progress(p) {
        const recs = (p.records || []).filter(r => !r.flashcardKind).length;
        const days = collectActiveDays(p).size;
        const pct = Math.min(50, Math.floor(Math.min(recs, 100) / 2)) + Math.min(50, Math.floor(Math.min(days, 15) / 15 * 50));
        const ok = recs >= 100 && days >= 15;
        return { current: ok ? 100 : pct, target: 100, unit: '% 综合达成', auto: ok };
      }
    }
  ];

  let evaluating = false;
  let evalTimer = null;
  let currentPreviewKind = 'analog-v1';

  function unlockedSet(profile) {
    const set = new Set();
    for (const note of profile?.records || []) {
      if (note.flashcardKind) set.add(note.flashcardKind);
    }
    return set;
  }

  async function unlockCardByKind(kind, { silent = false } = {}) {
    if (!ready || evaluating) return false;
    const card = ACHIEVEMENT_CARDS.find(c => c.kind === kind);
    const profile = activeProfile();
    if (!card || !profile) return false;
    if (unlockedSet(profile).has(kind)) return true;
    evaluating = true;
    try {
      const next = structuredClone(appState);
      const p = next.profiles.find(item => item.id === next.activeId);
      if (!p || p.records.some(r => r.flashcardKind === kind)) return true;
      p.records.push({
        id: crypto.randomUUID(),
        type: 'custom-achievement',
        title: '成就闪卡 ' + card.number + ' · ' + card.title,
        date: today(),
        body: card.headline + '\n' + card.quote,
        tags: [],
        status: '已解锁',
        pinned: false,
        attachments: [],
        flashcardKind: card.kind,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await commitState(next);
      if (!silent) {
        toast('已解锁典藏卡牌 NO.' + card.number + '「' + card.title + '」', {
          label: '前往成就殿宇',
          run: () => openAchievementHall()
        });
      }
      if (view === 'pinned' && tab === 'achievements') render();
      window.dispatchEvent(new CustomEvent('donote-achievements-updated'));
      document.dispatchEvent(new CustomEvent('donote-achievements-updated'));
      return true;
    } catch {
      return false;
    } finally {
      evaluating = false;
    }
  }

  async function evaluateAchievements() {
    if (!ready || evaluating) return;
    const profile = activeProfile();
    if (!profile) return;
    const unlocked = unlockedSet(profile);
    const newlyEarned = ACHIEVEMENT_CARDS.filter(card => !unlocked.has(card.kind) && card.progress(profile).auto);
    if (!newlyEarned.length) return;
    evaluating = true;
    try {
      const next = structuredClone(appState);
      const p = next.profiles.find(item => item.id === next.activeId);
      if (!p) return;
      const nowIso = new Date().toISOString();
      for (const card of newlyEarned) {
        if (p.records.some(r => r.flashcardKind === card.kind)) continue;
        p.records.push({
          id: crypto.randomUUID(),
          type: 'custom-achievement',
          title: '成就闪卡 ' + card.number + ' · ' + card.title,
          date: today(),
          body: card.headline + '\n' + card.quote,
          tags: [],
          status: '已解锁',
          pinned: false,
          attachments: [],
          flashcardKind: card.kind,
          createdAt: nowIso,
          updatedAt: nowIso
        });
      }
      await commitState(next);
      const first = newlyEarned[0];
      const msg = newlyEarned.length === 1
        ? '已解锁典藏卡牌 NO.' + first.number + '「' + first.title + '」'
        : '已解锁「' + first.title + '」等 ' + newlyEarned.length + ' 张典藏卡牌';
      toast(msg, { label: '查看殿宇', run: () => openAchievementHall() });
      if (view === 'pinned' && tab === 'achievements') render();
      window.dispatchEvent(new CustomEvent('donote-achievements-updated'));
      document.dispatchEvent(new CustomEvent('donote-achievements-updated'));
    } catch {}
    finally { evaluating = false; }
  }

  function scheduleEvaluation() {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(() => { void evaluateAchievements(); }, 700);
  }

  function openAchievementHall() {
    const dialog = $('analogFlashcard');
    if (dialog?.open) dialog.close();
    if ($('desktopSettings')?.matches(':popover-open')) $('desktopSettings').hidePopover();
    switchView('pinned');
    tab = 'achievements';
    render();
  }

  function populateFlashcardDialog(card, isUnlocked) {
    const dialog = $('analogFlashcard');
    if (!dialog || !card) return;
    currentPreviewKind = card.kind;
    const titleEl = $('analogFlashcardTitle');
    if (titleEl) titleEl.textContent = 'DoNote · 典藏闪卡 NO.' + card.number + ' · ' + card.title;
    const flip = $('flashcardFlip');
    if (flip) {
      flip.setAttribute('aria-pressed', 'false');
      const img = flip.querySelector('.analog-flashcard-front img');
      const num = flip.querySelector('.analog-flashcard-number');
      const backSmall = flip.querySelector('.analog-flashcard-back small');
      const backStrong = flip.querySelector('.analog-flashcard-back strong');
      const backSpan = flip.querySelector('.analog-flashcard-back span');
      if (img) { img.src = card.image; img.alt = card.title; }
      if (num) num.textContent = 'DoNote / ' + card.number + ' · ' + card.title;
      if (backSmall) backSmall.textContent = card.eyebrow;
      if (backStrong) backStrong.innerHTML = esc(card.headline).replace(/\n/g, '<br>');
      if (backSpan) backSpan.textContent = card.quote;
    }
    const saveBtn = $('flashcardSave');
    if (saveBtn) {
      saveBtn.textContent = isUnlocked ? '进入成就殿宇' : '前往成就殿宇查看进度';
      saveBtn.disabled = false;
    }
  }

  async function openCardPreview(kind = 'analog-v1', forceUnlockOrigin = false) {
    const dialog = $('analogFlashcard');
    if (!dialog) return;
    if ($('aboutDoNote')?.open) $('aboutDoNote').close();
    if ($('desktopSettings')?.matches(':popover-open')) $('desktopSettings').hidePopover();
    if (forceUnlockOrigin && kind === 'analog-v1') {
      await unlockCardByKind('analog-v1', { silent: false });
    }
    const card = ACHIEVEMENT_CARDS.find(c => c.kind === kind) || ACHIEVEMENT_CARDS[0];
    const unlocked = unlockedSet(activeProfile()).has(card.kind);
    populateFlashcardDialog(card, unlocked);
    if (!dialog.open) dialog.showModal();
  }

  function renderHallView() {
    const host = $('records');
    const isHall = view === 'pinned' && tab === 'achievements';
    host.classList.toggle('achievement-display', isHall);
    const searchRow = document.querySelector('.searchrow');
    if (searchRow) searchRow.hidden = isHall;
    if (!isHall) return;
    $('libraryPager').hidden = true;
    const profile = activeProfile();
    const unlocked = unlockedSet(profile);
    const activeDaysCount = collectActiveDays(profile).size;
    const focusMins = getTotalFocusMinutes(profile);

    const tiles = ACHIEVEMENT_CARDS.map(card => {
      const has = unlocked.has(card.kind);
      const prog = card.progress(profile);
      const pct = Math.max(0, Math.min(100, Math.round((prog.current / Math.max(1, prog.target)) * 100)));
      if (has) {
        return '<button type="button" class="achievement-tile is-unlocked" data-achievement="' + esc(card.kind) + '" aria-label="打开成就闪卡 ' + esc(card.number + ' ' + card.title) + '">'
          + '<div class="achievement-art-wrap"><img src="' + esc(card.image) + '" draggable="false" alt=""><em class="achievement-badge-pill">' + esc(card.badge) + '</em></div>'
          + '<div class="achievement-tile-meta"><span>NO. ' + esc(card.number) + ' · 已点亮</span><strong>' + esc(card.title) + '</strong><small>' + esc(card.rule) + '</small></div>'
          + '</button>';
      }
      return '<article class="achievement-tile is-locked" aria-label="未解锁闪卡 ' + esc(card.number + ' ' + card.title) + '">'
        + '<div class="achievement-locked-art"><span class="locked-no">NO. ' + esc(card.number) + '</span><em class="achievement-badge-pill is-muted">' + esc(card.badge) + '</em><i class="locked-emblem">✦</i></div>'
        + '<div class="achievement-tile-meta"><span>待解锁 · ' + prog.current + ' / ' + prog.target + ' ' + esc(prog.unit) + '</span><strong>' + esc(card.title) + '</strong><small>' + esc(card.rule) + '</small>'
        + '<div class="achievement-prog-bar" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct + '%"></i></div></div>'
        + '</article>';
    }).join('');

    host.innerHTML = '<section class="achievement-hall" aria-label="成就殿宇">'
      + '<div class="achievement-hall-heading">'
      + '<div><span>DONOTE · COLLECTIBLE CARDS</span><h3>成就殿宇</h3><p>第 001 号保留模拟集成电路「信号路径」初心，其余九张见证文献广度、精读深度与岁月长跑。</p></div>'
      + '<div class="achievement-hall-stats"><strong>已点亮 ' + unlocked.size + ' / ' + ACHIEVEMENT_CARDS.length + '</strong>'
      + '<small>累计活跃 ' + activeDaysCount + ' 天 · 专注约 ' + focusMins + ' 分钟</small></div>'
      + '</div>'
      + '<div class="achievement-grid">' + tiles + '</div></section>';

    host.querySelectorAll('[data-achievement]').forEach(btn => {
      btn.onclick = () => { void openCardPreview(btn.dataset.achievement, false); };
    });
  }

  window.DoNoteAchievements = {
    cards: ACHIEVEMENT_CARDS,
    unlockedCount: () => unlockedSet(activeProfile()).size,
    totalCount: ACHIEVEMENT_CARDS.length,
    openHall: openAchievementHall,
    openCard: openCardPreview,
    evaluate: evaluateAchievements
  };
  window.openAnalogFlashcard = () => openCardPreview('analog-v1', true);
  window.renderAchievementHall = renderHallView;

  // 绑定翻面弹窗交互与使用时长心跳
  window.addEventListener('DOMContentLoaded', () => {
    const dialog = $('analogFlashcard');
    const flip = $('flashcardFlip');
    const save = $('flashcardSave');
    if (flip && !flip.dataset.boundAchievement) {
      flip.dataset.boundAchievement = '1';
      flip.addEventListener('dragstart', e => e.preventDefault());
      flip.addEventListener('click', () => flip.setAttribute('aria-pressed', String(flip.getAttribute('aria-pressed') !== 'true')));
    }
    if (save && !save.dataset.boundAchievement) {
      save.dataset.boundAchievement = '1';
      save.addEventListener('click', () => openAchievementHall());
    }
    dialog?.querySelectorAll('[data-close-flashcard]').forEach(btn => {
      if (!btn.dataset.boundAchievement) {
        btn.dataset.boundAchievement = '1';
        btn.addEventListener('click', () => dialog.close());
      }
    });
  });

  document.addEventListener('workspace-records-changed', () => {
    markTodayActive(0);
    scheduleEvaluation();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ready) {
      markTodayActive(0);
      scheduleEvaluation();
    }
  });
  setInterval(() => {
    if (!ready || document.visibilityState !== 'visible') return;
    markTodayActive(1);
    scheduleEvaluation();
  }, 60000);
  setTimeout(() => {
    if (ready) {
      markTodayActive(0);
      scheduleEvaluation();
    }
  }, 900);
})();
