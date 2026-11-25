/**
 * [INPUT]: 接收已初始化的 Playwright 页面实例 page 与 Node.js AI/Sync 桥接服务 createBridge。
 * [OUTPUT]: 暴露 verifyRefinementsAndSyncProR140，端到端验证 r140 全部 13 项交互精修、视频多模态问答与零信任多端同步进阶能力。
 * [POS]: 由 tools/tests/workspace-excerpts.mjs 调用的 r140 专项自动化回归套件。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../../work/ai-bridge/server.mjs';

export async function verifyRefinementsAndSyncProR140(page) {
  // 1 & 4. 文献库文件夹卡片严格 60px 等高 + 默认按「最近打开 ↓」(recent-open) 排序
  const folderAndSortState = await page.evaluate(async () => {
    const next = structuredClone(appState);
    const p = next.profiles.find(item => item.id === next.activeId);
    p.folders = p.folders || [];
    const rootId = 'fld-isscc-root';
    if (!p.folders.some(f => f.id === rootId)) {
      p.folders.push({ id: rootId, name: 'ISSCC 馆藏测试', parentId: '', scope: 'resource' });
      p.folders.push({ id: 'fld-isscc-2019', name: 'ISSCC 2019', parentId: rootId, scope: 'resource' });
      p.folders.push({ id: 'fld-isscc-2020', name: 'ISSCC 2020 超长子目录计数回归测试文件夹', parentId: rootId, scope: 'resource' });
      for (let i = 1; i <= 12; i++) {
        p.folders.push({ id: 'fld-sub-2020-' + i, name: 'Session ' + i, parentId: 'fld-isscc-2020', scope: 'resource' });
      }
    }
    const oldResId = 'rec-old-opened-first';
    const newerResId = 'rec-new-unopened';
    if (!p.records.some(r => r.id === oldResId)) {
      p.records.push({
        id: oldResId, type: 'resource', title: '2021 经典旧文献（刚被打开）',
        body: '', tags: ['ADC'], date: '2021-02-15', status: '在读', folderId: rootId,
        createdAt: '2021-02-15T08:00:00.000Z', updatedAt: '2021-02-15T08:00:00.000Z',
        readerProgress: { kind: 'pdf', page: 3, scroll: 0, finished: false, lastOpened: '2099-01-01T12:00:00.000Z' },
        attachments: []
      });
      p.records.push({
        id: newerResId, type: 'resource', title: '2026 新入库但尚未打开文献',
        body: '', tags: ['ADC'], date: '2026-11-24', status: '待读', folderId: rootId,
        createdAt: '2026-11-24T08:00:00.000Z', updatedAt: '2026-11-24T08:00:00.000Z',
        attachments: []
      });
    }
    await commitState(next);

    switchView('journal');
    const journalSort = document.getElementById('sort').value;
    switchView('resource');
    const resourceDefaultSort = document.getElementById('sort').value;
    revealFolderLocation('resource', rootId);
    await new Promise(r => setTimeout(r, 40));

    const heights = [...document.querySelectorAll('#libraryFolders .library-folder-card')].map(el => Math.round(el.getBoundingClientRect().height));
    const renderedTitles = [...document.querySelectorAll('#records .card h3, #records .gallery-card h3')].map(el => el.textContent.trim());
    return { journalSort, resourceDefaultSort, heights, renderedTitles };
  });
  assert.equal(folderAndSortState.journalSort, 'date');
  assert.equal(folderAndSortState.resourceDefaultSort, 'recent-open');
  assert.ok(folderAndSortState.heights.length >= 2);
  for (const h of folderAndSortState.heights) {
    assert.ok(Math.abs(h - 60) <= 1, `Expected uniform 60px folder card height, got ${h}px`);
  }
  assert.equal(folderAndSortState.renderedTitles[0], '2021 经典旧文献（刚被打开）');

  // 2, 3 & 5. 四栏自适应偏好设置框 + 成就殿宇隐藏与恢复开关
  await page.evaluate(() => document.getElementById('desktopSettingsButton').click());
  await page.locator('#desktopSettings:popover-open').waitFor();
  const settingsAndAch = await page.evaluate(async () => {
    const dlgRect = document.getElementById('desktopSettings').getBoundingClientRect();
    document.querySelector('#desktopSettings [data-settings-group="sync"]').click();
    const tokenRect = document.getElementById('settingsSyncToken').getBoundingClientRect();

    document.querySelector('#desktopSettings [data-settings-group="appearance"]').click();
    const toggle = document.getElementById('desktopAchievementToggle');
    toggle.click(); // 关闭成就殿宇
    const disabledState = window.DoNoteAchievements.isEnabled();
    document.getElementById('desktopSettings').hidePopover();

    switchView('pinned');
    const tabHiddenWhenOff = document.getElementById('achievementTab')?.hidden !== false;

    window.DoNoteAchievements.setEnabled(true);
    render();
    const tabVisibleWhenOn = document.getElementById('achievementTab')?.hidden === false;
    return {
      settingsWidth: Math.round(dlgRect.width),
      tokenInputWidth: Math.round(tokenRect.width),
      disabledState,
      tabHiddenWhenOff,
      tabVisibleWhenOn
    };
  });
  assert.ok(settingsAndAch.settingsWidth >= 720, `Settings dialog should be spacious (>=720px), got ${settingsAndAch.settingsWidth}`);
  assert.ok(settingsAndAch.tokenInputWidth >= 200, `Sync token input should not be cramped, got ${settingsAndAch.tokenInputWidth}`);
  assert.equal(settingsAndAch.disabledState, false);
  assert.equal(settingsAndAch.tabHiddenWhenOff, true);
  assert.equal(settingsAndAch.tabVisibleWhenOn, true);

  // 7, 8, 10 & 11. 顶栏日期字号放大、莫兰迪低饱和类型色相、胶囊分页器与精细化行动统计计数
  const visualAndCountState = await page.evaluate(async () => {
    const next = structuredClone(appState);
    const p = next.profiles.find(item => item.id === next.activeId);
    p.records.push(
      { id: 'iss-solved-r140', type: 'issue', title: '已收敛偏置电流问题', body: 'ok', tags: [], date: today(), status: '已解决', createdAt: new Date().toISOString() },
      { id: 'iss-open-r140', type: 'issue', title: '待排查时钟馈通毛刺', body: 'todo', tags: [], date: today(), status: '待排查', createdAt: new Date().toISOString() },
      { id: 'pln-done-r140', type: 'plan', title: '已完成阶段一计划', body: '', tags: [], date: today(), planStart: '2026-11-01', planEnd: '2026-11-10', planTrack: '', status: '已完成', createdAt: new Date().toISOString() },
      { id: 'pln-run-r140', type: 'plan', title: '正在进行阶段二验证', body: '', tags: [], date: today(), planStart: '2026-11-20', planEnd: '2026-11-30', planTrack: '', status: '进行中', createdAt: new Date().toISOString() }
    );
    for (let i = 0; i < 22; i++) {
      p.records.push({
        id: 'old-lib-pager-' + i, type: 'resource', title: '2023 归档文献 #' + i,
        body: '', tags: [], date: '2023-05-10', status: '待读',
        createdAt: '2023-05-10T08:00:00.000Z', updatedAt: '2023-05-10T08:00:00.000Z', attachments: []
      });
    }
    await commitState(next);

    switchView('all');
    const dateFontPx = parseFloat(getComputedStyle(document.querySelector('#workspaceIntro .date-block')).fontSize);
    const activeRecords = records.filter(r => !r.flashcardKind);
    const totalIssues = activeRecords.filter(r => r.type === 'issue').length;
    const unresolvedIssues = activeRecords.filter(r => r.type === 'issue' && r.status !== '已解决').length;
    const totalResources = activeRecords.filter(r => r.type === 'resource' || r.type === 'paper').length;
    const sevenDaysAgo = today(new Date(Date.now() - 6 * 86400000));
    const recent7Resources = activeRecords.filter(r => (r.type === 'resource' || r.type === 'paper') && ((r.createdAt || r.attachments?.[0]?.addedAt || r.date || '').slice(0, 10) >= sevenDaysAgo)).length;
    const runningPlans = activeRecords.filter(r => r.type === 'plan' && r.status === '进行中').length;

    const railPlanBadge = Number(document.querySelector('#workspaceRail button[data-rail-view="plan"]')?.dataset.railBadge || 0);
    const railIssueBadge = Number(document.querySelector('#workspaceRail button[data-rail-view="issue"]')?.dataset.railBadge || 0);
    const railLibBadge = Number(document.querySelector('#workspaceRail button[data-rail-view="resource"]')?.dataset.railBadge || 0);
    const railJournalHasBadge = document.querySelector('#workspaceRail button[data-rail-view="journal"]')?.hasAttribute('data-rail-badge');

    const dashPaperVal = Number(document.querySelector('#dashboardTop .dashboard-card[data-widget-kind="paper"] .widget-value')?.textContent || -1);
    const dashIssueVal = Number(document.querySelector('#dashboardTop .dashboard-card[data-widget-kind="issue"] .widget-value')?.textContent || -1);
    const heatFootText = document.querySelector('#dashboardSide .heat-foot')?.textContent || '';
    const hasToneAttr = !!document.querySelector('#homeResume .bento-study-card[data-bento-tone]');

    switchView('resource');
    revealFolderLocation('resource', FOLDER_ALL);
    const pagerVisible = !document.getElementById('libraryPager').hidden;
    const hasPagerNums = document.querySelectorAll('#libraryPager .pager-num').length >= 2;
    const jumpBorderWidth = parseFloat(getComputedStyle(document.getElementById('libraryPageInput')).borderTopWidth || '0');

    return {
      dateFontPx,
      totalIssues, unresolvedIssues, railIssueBadge, dashIssueVal,
      totalResources, recent7Resources, railLibBadge, dashPaperVal,
      runningPlans, railPlanBadge, railJournalHasBadge,
      heatFootHasTotal: heatFootText.includes('共 '),
      hasToneAttr,
      pagerVisible, hasPagerNums, jumpBorderWidth
    };
  });
  assert.ok(visualAndCountState.dateFontPx >= 13.5, `Date label font should be enlarged (>=13.5px), got ${visualAndCountState.dateFontPx}`);
  assert.ok(visualAndCountState.totalIssues > visualAndCountState.unresolvedIssues);
  assert.equal(visualAndCountState.railIssueBadge, visualAndCountState.unresolvedIssues);
  assert.equal(visualAndCountState.dashIssueVal, visualAndCountState.unresolvedIssues);
  assert.ok(visualAndCountState.totalResources > visualAndCountState.recent7Resources);
  assert.equal(visualAndCountState.railLibBadge, visualAndCountState.recent7Resources);
  assert.equal(visualAndCountState.dashPaperVal, visualAndCountState.recent7Resources);
  assert.equal(visualAndCountState.railPlanBadge, visualAndCountState.runningPlans);
  assert.equal(visualAndCountState.railJournalHasBadge, false);
  assert.equal(visualAndCountState.heatFootHasTotal, false);
  assert.equal(visualAndCountState.hasToneAttr, true);
  assert.equal(visualAndCountState.pagerVisible, true);
  assert.equal(visualAndCountState.hasPagerNums, true);
  assert.equal(visualAndCountState.jumpBorderWidth, 0);

  // 9. 「管理研究方向」防污染拦截与一键无损收纳杂项
  const topicCurationOutcome = await page.evaluate(async () => {
    await put({
      id: 'rec-weekly-noise-test',
      type: 'journal',
      journalKind: 'weekly',
      title: '组会 2026-08-11 · 滤波器进展',
      body: '本周仿真汇报',
      tags: ['20260811', 'GmC_Filter_260811.pptx', '连续时间滤波器'],
      date: today(),
      status: '已记录'
    });
    const autoPromotedTopics = [...activeProfile().topics];
    const blockedNoisyWrite = !autoPromotedTopics.includes('20260811') && !autoPromotedTopics.includes('GmC_Filter_260811.pptx');

    const next = structuredClone(appState);
    const p = next.profiles.find(item => item.id === next.activeId);
    for (const legacy of ['20260811', 'GmC_Filter_260811.pptx', '零记录空方向A', '零记录空方向B', '零记录空方向C', '零记录空方向D']) {
      if (!p.topics.includes(legacy)) p.topics.push(legacy);
    }
    await commitState(next);

    document.getElementById('topicsBtn').click();
    await new Promise(r => setTimeout(r, 40));
    const bannerVisible = !document.getElementById('topicCleanupBanner')?.hidden;
    document.getElementById('topicDemoteNoiseBtn')?.click();
    const deadline1 = Date.now() + 3000;
    while (Date.now() < deadline1 && activeProfile().topics.includes('20260811')) {
      await new Promise(r => setTimeout(r, 40));
    }
    const recordTagsIntact = (records.find(r => r.id === 'rec-weekly-noise-test')?.tags || []).includes('20260811');

    document.getElementById('topicCleanUnusedBtn')?.click();
    const deadline2 = Date.now() + 3000;
    while (Date.now() < deadline2 && activeProfile().topics.includes('零记录空方向A')) {
      await new Promise(r => setTimeout(r, 40));
    }
    const finalTopics = [...activeProfile().topics];
    document.getElementById('topicsDialog').close();
    return { blockedNoisyWrite, bannerVisible, recordTagsIntact, finalTopics };
  });
  assert.equal(topicCurationOutcome.blockedNoisyWrite, true);
  assert.equal(topicCurationOutcome.bannerVisible, true);
  assert.equal(topicCurationOutcome.recordTagsIntact, true);
  assert.equal(topicCurationOutcome.finalTopics.includes('20260811'), false);
  assert.equal(topicCurationOutcome.finalTopics.includes('GmC_Filter_260811.pptx'), false);
  assert.equal(topicCurationOutcome.finalTopics.includes('零记录空方向A'), false);

  // 6. 视频阅读器「定格批注 | ✦ AI 助教问答」多模态问答、公式渲染、时间码跳播与存为定格批注
  const videoAiResult = await page.evaluate(async () => {
    const vidAttId = 'att-video-ai-r140';
    const vidBlob = new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' });
    await put({
      id: 'rec-video-ai-r140',
      type: 'resource',
      title: 'Basics of SAR ADCs Tutorial',
      body: '',
      tags: ['SAR ADC'],
      date: today(),
      status: '在读',
      videoSubtitles: {
        [vidAttId]: [
          { start: 60, end: 85, en: 'Quantization noise and SNR = 6.02N + 1.76 dB derivation', zh: '量化噪声与信噪比公式推导' }
        ]
      },
      attachments: [{ id: vidAttId, name: 'sar-adc-lecture.mp4', size: vidBlob.size, mime: 'video/mp4', addedAt: new Date().toISOString() }]
    }, [{ key: fileKey(appState.activeId, vidAttId), blob: vidBlob }]);

    const fileObj = records.find(r => r.id === 'rec-video-ai-r140').attachments[0];
    await openReadableAttachment(fileObj, vidBlob);

    const aiTab = document.querySelector('#reader [data-video-tab="ai"]');
    aiTab?.click();

    document.getElementById('readerAiUrl').value = 'https://api.example.com/v1';
    document.getElementById('readerAiModel').value = 'gpt-4o-mini-vision';
    document.getElementById('saveReaderAiSettings').click();

    const origFetch = window.fetch;
    let postedBody = null;
    window.fetch = async (url, init) => {
      if (String(url).includes('/chat/completions')) {
        postedBody = JSON.parse(init.body);
        const sse = [
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '在讲座 [01:15] 处推导了量化信噪比公式 $SNR = 6.02N + 1.76$ dB。' } }] }) + '\n\n',
          'data: [DONE]\n\n'
        ].join('');
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return origFetch(url, init);
    };

    try {
      const qInput = document.querySelector('#reader [data-video-ai-input]');
      qInput.value = '请总结当前页量化噪声推导';
      document.querySelector('#reader [data-video-ai-ask]').click();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !document.querySelector('#reader .ai-answer-body .ai-time-chip')) {
        await new Promise(r => setTimeout(r, 40));
      }
      const hasKatex = !!document.querySelector('#reader .ai-answer-body .katex');
      const timeChipText = document.querySelector('#reader .ai-answer-body .ai-time-chip')?.textContent || '';
      const saveFrameBtn = [...document.querySelectorAll('#reader .ai-actions button')].find(b => b.textContent.includes('存为定格批注'));
      saveFrameBtn?.click();
      await new Promise(r => setTimeout(r, 150));
      const frameCount = document.querySelectorAll('#reader .video-frame-list li').length;
      document.querySelector('#reader [data-close="reader"]')?.click();
      return {
        hasAiTab: !!aiTab,
        modelSent: postedBody?.model,
        hasKatex,
        timeChipText,
        frameCount
      };
    } finally {
      window.fetch = origFetch;
    }
  });
  assert.equal(videoAiResult.hasAiTab, true);
  assert.ok(typeof videoAiResult.modelSent === 'string' && videoAiResult.modelSent.length > 0);
  assert.equal(videoAiResult.hasKatex, true);
  assert.ok(videoAiResult.timeChipText.includes('01:15'));
  assert.equal(videoAiResult.frameCount, 1);

  // 13a. 启动静默检查新版本圆点提示（不弹窗打断，同步通知原生标题栏与设置齿轮）
  const silentUpdateState = await page.evaluate(async () => {
    const hostMessages = [];
    const origPost = window.chrome.webview.postMessage;
    window.chrome.webview.postMessage = msg => {
      hostMessages.push(msg);
      if (msg?.type === 'online-update' && msg.action === 'check' && String(msg.id).startsWith('silent-')) {
        queueMicrotask(() => window.qaRelease.post({
          type: 'online-update-result',
          id: msg.id,
          currentVersion: '26.1139.0085',
          remoteVersion: '26.1140.0086',
          tag: 'r140',
          hasUpdate: true,
          downloadMode: 'patch',
          assetName: 'DoNote-Update-26.1139.0085-to-r140.zip',
          assetSize: 655360,
          releaseNotes: '### r140 静默提示与多端加密同步'
        }));
        return;
      }
      return origPost(msg);
    };
    try {
      window.DoNoteSilentUpdate.checkNow();
      await new Promise(r => setTimeout(r, 80));
      const dialogStayedClosed = !document.getElementById('onlineUpdateDialog').open;
      const gearDot = document.getElementById('desktopSettingsButton').classList.contains('has-update-dot');
      const tabDot = document.querySelector('#desktopSettings [data-settings-group="storage"]').classList.contains('has-update-dot');
      const btnLabel = document.getElementById('settingsCheckOnlineUpdate').textContent;
      const notifiedNativeHost = hostMessages.includes('update-indicator:on');
      window.DoNoteSilentUpdate.setIndicator(false);
      return { dialogStayedClosed, gearDot, tabDot, btnLabel, notifiedNativeHost };
    } finally {
      window.chrome.webview.postMessage = origPost;
    }
  });
  assert.deepEqual(silentUpdateState, {
    dialogStayedClosed: true,
    gearDot: true,
    tabDot: true,
    btnLabel: '发现新版本 r140',
    notifiedNativeHost: true
  });

  // 12 & 13b/c/d. 已撤销助手凭证自动清理与彻底删除 + PDF/PPT 批注 CRDT 细粒度合并 + SSE 实时推送 + AES-256-GCM 端到端加密
  const crdtCheck = await page.evaluate(() => {
    const merged = window.DoNoteSyncCrypto.mergeAnnotationBundle(
      {
        marks: [
          { id: 'm-del', kind: 'highlight', page: 1, quote: 'old', note: '', color: '#f4d03f', rects: [[0.1, 0.1, 0.2, 0.05]], points: [], createdAt: '2026-11-25T01:00:00Z', updatedAt: '2026-11-25T01:00:00Z' },
          { id: 'm-pdf-a', kind: 'highlight', page: 2, quote: 'Device A quote', note: 'A 批注', color: '#f4d03f', rects: [[0.1, 0.2, 0.3, 0.04]], points: [], createdAt: '2026-11-25T02:00:00Z', updatedAt: '2026-11-25T02:00:00Z' },
          { id: 'm-ppt-s3-a', kind: 'comment', page: 3, quote: 'Slide 3', note: '台式机推导极点', color: '#77cfa0', rects: [], points: [], createdAt: '2026-11-25T02:10:00Z', updatedAt: '2026-11-25T02:10:00Z' }
        ],
        tombstones: []
      },
      {
        marks: [
          { id: 'm-pdf-b', kind: 'pen', page: 5, quote: '', note: '', color: '#7eb6f3', rects: [], points: [[0.2, 0.2], [0.4, 0.4]], createdAt: '2026-11-25T02:05:00Z', updatedAt: '2026-11-25T02:05:00Z' },
          { id: 'm-ppt-s3-b', kind: 'comment', page: 3, quote: 'Slide 3', note: '笔记本补充零点补偿', color: '#77cfa0', rects: [], points: [], createdAt: '2026-11-25T02:15:00Z', updatedAt: '2026-11-25T02:15:00Z' },
          { id: 'm-ppt-s8-b', kind: 'comment', page: 8, quote: 'Slide 8', note: '版图对称性核查', color: '#f3a35c', rects: [], points: [], createdAt: '2026-11-25T02:20:00Z', updatedAt: '2026-11-25T02:20:00Z' }
        ],
        tombstones: [{ id: 'm-del', deletedAt: '2026-11-25T03:00:00Z' }]
      }
    );
    const ids = merged.marks.map(m => m.id);
    const slide3 = merged.marks.find(m => m.page === 3 && m.kind === 'comment');
    return {
      ids,
      slide3Note: slide3?.note || '',
      hasDeleted: ids.includes('m-del'),
      slide8Preserved: merged.marks.some(m => m.page === 8)
    };
  });
  assert.equal(crdtCheck.hasDeleted, false);
  assert.ok(crdtCheck.ids.includes('m-pdf-a') && crdtCheck.ids.includes('m-pdf-b'));
  assert.equal(crdtCheck.slide8Preserved, true);
  assert.ok(crdtCheck.slide3Note.includes('台式机推导极点') && crdtCheck.slide3Note.includes('笔记本补充零点补偿'));

  const bridgeTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'donote-r140-sync-e2ee-'));
  const adminToken = 'an_owner_' + crypto.randomBytes(24).toString('hex');
  await fs.writeFile(path.join(bridgeTmp, 'state.json'), JSON.stringify({
    version: 1,
    profiles: { 'p-test': { id: 'p-test', name: '测试工作台', categories: [], records: [] } },
    agents: [
      { id: 'ag-rev-1', name: 'EveryOne', profileId: 'p-test', tokenHash: '00', scopes: ['records:read'], revoked: true, createdAt: '2026-11-01T00:00:00Z' },
      { id: 'ag-rev-2', name: 'Doubao', profileId: 'p-test', tokenHash: '11', scopes: ['records:read'], revoked: true, createdAt: '2026-11-02T00:00:00Z' },
      { id: 'ag-live-1', name: 'WorkBuddy', profileId: 'p-test', tokenHash: '22', scopes: ['records:read'], revoked: false, createdAt: '2026-11-03T00:00:00Z' }
    ],
    tasks: [],
    files: {},
    subtitles: {},
    audit: []
  }, null, 2));

  const bridge = await createBridge({
    dataDir: bridgeTmp,
    adminToken,
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: ['https://yams-one.example']
  });

  try {
    const addr = await bridge.listen();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    const initialAgents = (await (await fetch(`${baseUrl}/api/admin/agents`, { headers })).json()).agents;
    assert.deepEqual(initialAgents.map(a => a.name), ['WorkBuddy']);
    const createdAgent = await (await fetch(`${baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profileId: 'p-test', name: 'TempGrok', scopes: ['records:read'] })
    })).json();
    assert.equal(createdAgent.agent.name, 'TempGrok');
    const revokeRes = await (await fetch(`${baseUrl}/api/admin/agents/${createdAgent.agent.id}/revoke`, { method: 'POST', headers })).json();
    assert.equal(revokeRes.deleted, true);
    const afterRevokeAgents = (await (await fetch(`${baseUrl}/api/admin/agents`, { headers })).json()).agents;
    assert.deepEqual(afterRevokeAgents.map(a => a.name), ['WorkBuddy']);

    const sseAbort = new AbortController();
    const sseEvents = [];
    const ssePromise = (async () => {
      const res = await fetch(`${baseUrl}/api/sync/v1/events?profileId=p-e2ee-r140`, {
        headers: { Authorization: `Bearer ${adminToken}`, Accept: 'text/event-stream' },
        signal: sseAbort.signal
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (!sseAbort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.includes('event: sync-change')) {
            const dataLine = chunk.split('\n').find(l => l.startsWith('data:'));
            if (dataLine) sseEvents.push(JSON.parse(dataLine.slice(5).trim()));
          }
        }
      }
    })().catch(() => {});

    await new Promise(r => setTimeout(r, 80));

    const sealedBundle = await page.evaluate(async () => {
      const pass = 'ZeroTrust#2026';
      const plainBytes = new TextEncoder().encode('CONFIDENTIAL_CIRCUIT_SCHEMATIC_PAYLOAD_2026');
      const plainBlob = new Blob([plainBytes], { type: 'application/pdf' });
      const plainSha = await fileDigest(plainBlob);
      const { cipherBlob, cipherSha256 } = await window.DoNoteSyncCrypto.encryptBlob(plainBlob, pass);
      const cipherArr = Array.from(new Uint8Array(await cipherBlob.arrayBuffer()));

      const secretRecord = {
        id: 'rec-secret-e2ee-1',
        type: 'paper',
        title: '机密架构推导：亚阈值带隙基准温度曲率补偿',
        body: '核心机密参数 alpha=0.418, Vref=612.4mV',
        tags: ['机密课题'],
        date: '2026-11-25',
        status: '在读',
        updatedAt: '2026-11-25T05:00:00.000Z',
        syncMeta: { rev: 1, deviceId: 'dev-lab01', updatedAt: '2026-11-25T05:00:00.000Z' },
        attachments: [{ id: 'att-sec-1', name: 'subthreshold-secret.pdf', size: plainBytes.length, mime: 'application/pdf', sha256: plainSha, e2eeBlob: { v: 1, cipherSha256 } }]
      };
      const sealedRec = await window.DoNoteSyncCrypto.sealRecord(secretRecord, pass);
      const sealedAnn = await window.DoNoteSyncCrypto.sealJson({
        marks: [{ id: 'mk-sec-1', kind: 'highlight', page: 4, quote: '机密曲率公式原文', note: '核心推导批注', color: '#f4d03f', rects: [[0.1, 0.1, 0.3, 0.04]], points: [], createdAt: '2026-11-25T05:01:00Z', updatedAt: '2026-11-25T05:01:00Z' }],
        tombstones: []
      }, pass, 'ann:att-sec-1');
      return { plainSha, cipherSha256, cipherArr, sealedRec, sealedAnn };
    });

    const putEncBlob = await fetch(`${baseUrl}/api/sync/v1/blobs/${sealedBundle.cipherSha256}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(sealedBundle.cipherArr)
    });
    assert.equal(putEncBlob.status, 201);

    const deltaPush = await (await fetch(`${baseUrl}/api/sync/v1/delta`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId: 'p-e2ee-r140',
        deviceId: 'dev-lab01',
        deviceName: '加密研究工作站',
        sinceSeq: 0,
        records: [sealedBundle.sealedRec],
        annotations: [{ fileId: 'att-sec-1', updatedAt: '2026-11-25T05:01:00Z', e2ee: sealedBundle.sealedAnn }],
        tombstones: []
      })
    })).json();
    assert.equal(deltaPush.e2eeActive, true);
    assert.equal(deltaPush.accepted, 1);
    assert.equal(deltaPush.acceptedAnnotations, 1);

    const sseDeadline = Date.now() + 3000;
    while (Date.now() < sseDeadline && sseEvents.length === 0) {
      await new Promise(r => setTimeout(r, 40));
    }
    assert.ok(sseEvents.length >= 1, 'Expected real-time SSE sync-change push notification');
    assert.equal(sseEvents[0].profileId, 'p-e2ee-r140');
    assert.equal(sseEvents[0].sourceDeviceId, 'dev-lab01');
    sseAbort.abort();
    await ssePromise;

    const diskStateRaw = await fs.readFile(path.join(bridgeTmp, 'state.json'), 'utf8');
    assert.equal(diskStateRaw.includes('亚阈值带隙基准'), false);
    assert.equal(diskStateRaw.includes('alpha=0.418'), false);
    assert.equal(diskStateRaw.includes('机密曲率公式原文'), false);
    const diskBlobRaw = await fs.readFile(path.join(bridgeTmp, 'sync-v1', 'blobs', `${sealedBundle.cipherSha256}.blob`));
    assert.equal(diskBlobRaw.includes(Buffer.from('CONFIDENTIAL_CIRCUIT_SCHEMATIC')), false);

    const deltaPull = await (await fetch(`${baseUrl}/api/sync/v1/delta`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profileId: 'p-e2ee-r140', deviceId: 'dev-laptop02', sinceSeq: 0, records: [], annotations: [], tombstones: [] })
    })).json();
    const fetchedCipherBytes = Array.from(Buffer.from(await (await fetch(`${baseUrl}/api/sync/v1/blobs/${sealedBundle.cipherSha256}`, { headers })).arrayBuffer()));

    const decryptedVerify = await page.evaluate(async ({ recEnv, annEnv, cipherArr, expectedSha }) => {
      let wrongRejected = false;
      try {
        await window.DoNoteSyncCrypto.openRecord(recEnv, 'WrongPassphrase!');
      } catch {
        wrongRejected = true;
      }
      const pass = 'ZeroTrust#2026';
      const openedRec = await window.DoNoteSyncCrypto.openRecord(recEnv, pass);
      const openedAnn = await window.DoNoteSyncCrypto.openJson(annEnv, pass, 'ann:att-sec-1');
      const cipherBlob = new Blob([new Uint8Array(cipherArr)]);
      const openedBlob = await window.DoNoteSyncCrypto.decryptBlob(cipherBlob, pass, 'application/pdf');
      const actualSha = await fileDigest(openedBlob);
      const openedText = await openedBlob.text();
      return {
        wrongRejected,
        title: openedRec.title,
        annQuote: openedAnn.marks[0]?.quote,
        shaMatched: actualSha === expectedSha,
        openedText
      };
    }, {
      recEnv: deltaPull.records[0],
      annEnv: deltaPull.annotations[0].e2ee,
      cipherArr: fetchedCipherBytes,
      expectedSha: sealedBundle.plainSha
    });

    assert.deepEqual(decryptedVerify, {
      wrongRejected: true,
      title: '机密架构推导：亚阈值带隙基准温度曲率补偿',
      annQuote: '机密曲率公式原文',
      shaMatched: true,
      openedText: 'CONFIDENTIAL_CIRCUIT_SCHEMATIC_PAYLOAD_2026'
    });
  } finally {
    await bridge.close();
    await fs.rm(bridgeTmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log('PASS r140 uniform folder cards, adaptive 4-tab settings, video AI Q&A, topic governance, Morandi tints, silent update dot, CRDT annotations, SSE push & E2EE sync');
}
