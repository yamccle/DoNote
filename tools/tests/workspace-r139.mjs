/**
 * [INPUT]: 接收已初始化的 Playwright 页面实例 page，以及 Node.js 文件系统与 AI/Sync 桥接模块。
 * [OUTPUT]: 暴露 verifyPlatformEvolutionR139，端到端验证 r139 八大平台化演进特性。
 * [POS]: 由 tools/tests/workspace-excerpts.mjs 调用的 r139 专项自动化回归套件。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../../work/ai-bridge/server.mjs';

export async function verifyPlatformEvolutionR139(page) {
  // 1 & 2. 每日活跃使用足迹（无需新建记录即点亮今日）与成就殿宇十张卡牌体系
  const footprintAndCatalog = await page.evaluate(async () => {
    await switchView('all');
    const cards = window.DoNoteAchievements.cards;
    const p = activeProfile();
    const activeDays = [...window.DoNoteUsage.collectActiveDays(p)];
    const todayKey = today();
    const todayBarActive = !!document.querySelector('#dashboardSide .activity-bar-col.is-today .activity-bar-fill.has-value');
    const footText = document.querySelector('#dashboardSide .heat-foot')?.textContent || '';
    return {
      cardCount: cards.length,
      firstKind: cards[0]?.kind,
      firstTitle: cards[0]?.title,
      hasTodayActive: activeDays.includes(todayKey),
      todayBarActive,
      footText
    };
  });
  assert.equal(footprintAndCatalog.cardCount, 10);
  assert.equal(footprintAndCatalog.firstKind, 'analog-v1');
  assert.equal(footprintAndCatalog.firstTitle, '信号路径 · 初心');
  assert.equal(footprintAndCatalog.hasTodayActive, true);
  assert.equal(footprintAndCatalog.todayBarActive, true);
  assert.ok(footprintAndCatalog.footText.includes('天留下足迹'));

  // 解锁第 1 张彩蛋卡 + 验证文献卡自动解锁 + 模拟 7 天活跃解锁长期坚持卡
  const achievementResult = await page.evaluate(async () => {
    await window.openAnalogFlashcard();
    if (document.getElementById('analogFlashcard')?.open) {
      document.getElementById('analogFlashcard').close();
    }
    await window.DoNoteAchievements.evaluate();
    const beforeSevenDays = window.DoNoteAchievements.unlockedCount();
    const usageDays = [];
    for (let i = 0; i < 7; i++) {
      usageDays.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    window.DoNoteUsage.mergeFromBackup(activeProfile(), { usageDays, focusMinutes: 105 });
    await window.DoNoteAchievements.evaluate();
    const afterSevenDays = window.DoNoteAchievements.unlockedCount();
    const hasSevenDayCard = records.some(n => n.flashcardKind === 'time-days-7');
    const hasThirtyDayLocked = !records.some(n => n.flashcardKind === 'time-days-30');
    return { beforeSevenDays, afterSevenDays, hasSevenDayCard, hasThirtyDayLocked };
  });
  assert.equal(achievementResult.hasSevenDayCard, true);
  assert.equal(achievementResult.hasThirtyDayLocked, true);
  assert.ok(achievementResult.afterSevenDays > achievementResult.beforeSevenDays);

  // 4. 侧边栏宁缺毋滥微层次（左下不展示成就殿宇浮块）与成就殿宇展示验证
  const railCheck = await page.evaluate(() => {
    const libBtn = document.querySelector('#workspaceRail button[data-rail-view="resource"]');
    return {
      hasDivider: !!document.querySelector('#workspaceRail .rail-divider'),
      hasFootCard: !!document.getElementById('railFootprintCard'),
      cleanLabelText: libBtn?.textContent === names.resource,
      hasBadgeAttr: Number(libBtn?.dataset.railBadge || 0) > 0
    };
  });
  assert.deepEqual(railCheck, {
    hasDivider: true,
    hasFootCard: false,
    cleanLabelText: true,
    hasBadgeAttr: true
  });
  await page.evaluate(() => window.DoNoteAchievements.openHall());
  await page.waitForFunction(() => view === 'pinned' && tab === 'achievements');
  assert.equal(await page.locator('#records .achievement-tile').count(), 10);
  assert.ok(await page.locator('#records .achievement-tile.is-locked').count() >= 1);

  // 5. AI 管理页面精简优化：桌面端默认收起高级区与细粒度权限，保留全部能力
  await page.evaluate(() => document.getElementById('openAiManager').click());
  await page.locator('#aiManager[open]').waitFor();
  const aiManagerState = await page.evaluate(() => {
    const advOpen = document.getElementById('bridgeAdvancedOptions')?.open;
    const scopesOpen = document.getElementById('bridgeScopesFold')?.open;
    document.querySelector('[data-bridge-preset="read"]').click();
    const readScopes = [...document.querySelectorAll('[data-bridge-scope]:checked')].map(el => el.dataset.bridgeScope);
    document.getElementById('bridgeGrantFull').click();
    const fullCount = document.querySelectorAll('[data-bridge-scope]:checked').length;
    document.getElementById('aiManager').close();
    return { advOpen, scopesOpen, readScopes, fullCount };
  });
  assert.equal(aiManagerState.advOpen, false);
  assert.equal(aiManagerState.scopesOpen, false);
  assert.deepEqual(aiManagerState.readScopes.sort(), ['files:read', 'records:read']);
  assert.equal(aiManagerState.fullCount, 8);

  // 6. 全局拖拽篮板浮层 + 投递归档分拣台（清洗标题、即时新建多级子文件夹、打标签并解析 Markdown）
  const dropTriageOutcome = await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(['%PDF-1.4\n%test'], '[2026]_Cross_Disciplinary_Methods_final_v2.pdf', { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const overlayShown = !document.getElementById('globalDropOverlay').hidden;
    window.dispatchEvent(new Event('blur'));

    const f1 = new File(['%PDF-1.4\n1 0 obj<<>>endobj'], '[2026]_Causal_Inference_Notes_final.pdf', { type: 'application/pdf' });
    const f2 = new File(['# 实验方法提纲\n\n- 对照组设计\n- 显著性检验\n'], 'Experiment_Protocol_v3.md', { type: 'text/markdown' });
    window.openDropTriageWithFiles([f1, f2], { defaultType: 'study' });

    document.getElementById('dropCleanTitlesBtn').click();
    const cleanedTitles = [...document.querySelectorAll('#dropTriageList .drop-file-title')].map(el => el.value);
    document.getElementById('dropNewFolder').value = '2026 春季专题/因果推断';
    document.getElementById('dropCustomTags').value = '方法论, 拖拽分拣验证';
    document.getElementById('dropAutoOpen').checked = false;
    document.getElementById('dropTriageForm').requestSubmit();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && document.getElementById('dropTriageDialog').open) {
      await new Promise(r => setTimeout(r, 80));
    }
    const createdMd = records.find(r => r.title === 'Experiment Protocol' && r.type === 'study');
    const folderStr = createdMd ? folderPath(createdMd.folderId, 'study') : '';
    return {
      overlayShown,
      cleanedTitles,
      createdFound: !!createdMd,
      hasParsedHeading: (createdMd?.bodyHtml || '').includes('实验方法提纲'),
      folderStr,
      tags: createdMd?.tags || [],
      hasSyncMeta: (createdMd?.syncMeta?.rev || 0) >= 1
    };
  });
  assert.equal(dropTriageOutcome.overlayShown, true);
  assert.deepEqual(dropTriageOutcome.cleanedTitles, ['Causal Inference Notes', 'Experiment Protocol']);
  assert.equal(dropTriageOutcome.createdFound, true);
  assert.equal(dropTriageOutcome.hasParsedHeading, true);
  assert.equal(dropTriageOutcome.folderStr, '2026 春季专题 › 因果推断');
  assert.ok(dropTriageOutcome.tags.includes('拖拽分拣验证'));
  assert.equal(dropTriageOutcome.hasSyncMeta, true);

  // 3 & 8. 统一后台任务中心 + GitHub 在线更新检查与流式下载进度映射
  const updateAndTaskState = await page.evaluate(async () => {
    let cancelled = false;
    window.DoNoteTasks.upsert('mock-whisper', {
      kind: 'asr',
      title: '讲座视频语音识别',
      detail: '正在识别第 18 条字幕…',
      percent: 62,
      state: 'running',
      onCancel: () => {
        cancelled = true;
        window.DoNoteTasks.upsert('mock-whisper', { state: 'cancelled', detail: '已取消' });
      }
    });
    const activeCountDuringRun = window.DoNoteTasks.activeCount();
    const triggerActive = document.getElementById('taskCenterTrigger')?.classList.contains('is-active');
    window.DoNoteTasks.openPopover();
    const popoverOpen = document.getElementById('taskCenterPopover')?.matches(':popover-open');
    document.querySelector('#taskCenterList [data-task-id="mock-whisper"] .is-danger')?.click();
    document.getElementById('taskCenterPopover')?.hidePopover?.();

    const sent = [];
    const origPost = window.chrome.webview.postMessage;
    window.chrome.webview.postMessage = msg => {
      if (msg?.type === 'online-update') {
        sent.push(msg.action);
        if (msg.action === 'check') {
          queueMicrotask(() => window.qaRelease.post({
            type: 'online-update-result',
            id: msg.id,
            currentVersion: '26.1138.0084',
            remoteVersion: '26.1139.0085',
            tag: 'r139',
            hasUpdate: true,
            downloadMode: 'patch',
            assetName: 'DoNote-Update-26.1138.0084-to-r139.zip',
            assetSize: 4194304,
            releaseNotes: '### r139 更新\n- 新增 GitHub 自动在线更新'
          }));
        }
        return;
      }
      return origPost(msg);
    };
    try {
      document.getElementById('desktopSettingsButton').click();
      document.querySelector('#desktopSettings [data-settings-group="storage"]').click();
      document.getElementById('settingsCheckOnlineUpdate').click();
      await new Promise(r => setTimeout(r, 80));
      const strategyText = document.getElementById('onlineUpdateStrategy')?.textContent || '';
      const remoteText = document.getElementById('onlineUpdateRemote')?.textContent || '';
      window.qaRelease.post({
        type: 'online-update-progress',
        id: 'dl-1',
        assetName: 'DoNote-Update-26.1138.0084-to-r139.zip',
        received: 2306867,
        total: 4194304,
        percent: 55
      });
      const updateTask = window.DoNoteTasks.list().find(t => t.id === 'online-update');
      document.getElementById('onlineUpdateDialog').close();
      window.DoNoteTasks.upsert('online-update', { state: 'done', percent: 100, detail: '校验通过' });
      window.DoNoteTasks.clearCompleted();
      return {
        activeCountDuringRun,
        triggerActive,
        popoverOpen,
        cancelled,
        sent,
        strategyText,
        remoteText,
        updateTaskPercent: updateTask?.percent
      };
    } finally {
      window.chrome.webview.postMessage = origPost;
    }
  });
  assert.equal(updateAndTaskState.activeCountDuringRun, 1);
  assert.equal(updateAndTaskState.triggerActive, true);
  assert.equal(updateAndTaskState.popoverOpen, true);
  assert.equal(updateAndTaskState.cancelled, true);
  assert.deepEqual(updateAndTaskState.sent, ['check']);
  assert.ok(updateAndTaskState.strategyText.includes('增量极速补丁'));
  assert.ok(updateAndTaskState.remoteText.includes('26.1139.0085'));
  assert.equal(updateAndTaskState.updateTaskPercent, 55);

  // 7. 多端在线同步底座：本机附件 SHA-256 指纹补齐 + /api/sync/v1 真实节点去重与增量同步验证
  const hashSummary = await page.evaluate(async () => {
    await window.DoNoteSync.ensureAttachmentHashes();
    return window.DoNoteSync.getReadinessSummary();
  });
  assert.ok(hashSummary.deviceId.startsWith('dev-'));
  assert.ok(hashSummary.totalAttachments > 0);
  assert.equal(hashSummary.hashedAttachments, hashSummary.totalAttachments);

  const syncTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'donote-sync-v1-test-'));
  const adminToken = 'an_owner_' + crypto.randomBytes(24).toString('hex');
  const bridge = await createBridge({
    dataDir: syncTmp,
    adminToken,
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: ['https://yams-one.example']
  });
  try {
    const addr = await bridge.listen();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    const status0 = await (await fetch(`${baseUrl}/api/sync/v1/status?profileId=p_sync`, { headers })).json();
    assert.equal(status0.protocol, 'donote-sync-v1');
    assert.equal(status0.cursor, 0);

    const sampleBytes = Buffer.from('DoNote content-addressed deduplicated attachment payload');
    const sampleSha = crypto.createHash('sha256').update(sampleBytes).digest('hex');

    const check1 = await (await fetch(`${baseUrl}/api/sync/v1/blobs/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ hashes: [sampleSha] })
    })).json();
    assert.deepEqual(check1.missing, [sampleSha]);

    // 错误哈希上传应被服务端拒绝
    const badRes = await fetch(`${baseUrl}/api/sync/v1/blobs/${'0'.repeat(64)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/pdf' },
      body: sampleBytes
    });
    assert.equal(badRes.status, 400);

    // 正确 SHA-256 块上传后再次 check 应返回空列表（跨设备去重）
    const putRes = await fetch(`${baseUrl}/api/sync/v1/blobs/${sampleSha}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/pdf' },
      body: sampleBytes
    });
    assert.equal(putRes.status, 201);

    const check2 = await (await fetch(`${baseUrl}/api/sync/v1/blobs/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ hashes: [sampleSha] })
    })).json();
    assert.deepEqual(check2.missing, []);

    // 设备 A 推送记录，设备 B 从游标 0 增量拉取
    const pushA = await (await fetch(`${baseUrl}/api/sync/v1/delta`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId: 'p_sync',
        deviceId: 'dev-alpha0001',
        deviceName: '实验室台式机',
        sinceSeq: 0,
        topics: ['跨端协同'],
        records: [{
          id: 'rec_sync_1',
          type: 'resource',
          title: '跨设备增量同步验证论文',
          updatedAt: '2026-11-25T04:00:00.000Z',
          syncMeta: { rev: 1, deviceId: 'dev-alpha0001', updatedAt: '2026-11-25T04:00:00.000Z' },
          attachments: [{ id: 'att_1', name: 'paper.pdf', size: sampleBytes.length, mime: 'application/pdf', sha256: sampleSha }]
        }]
      })
    })).json();
    assert.equal(pushA.accepted, 1);
    assert.equal(pushA.cursor, 1);

    // 设备 B 增量拉取并按 SHA-256 下载去重附件字节验证
    const pullB = await (await fetch(`${baseUrl}/api/sync/v1/delta`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId: 'p_sync',
        deviceId: 'dev-beta0002',
        deviceName: '随身轻薄本',
        sinceSeq: 0,
        records: []
      })
    })).json();
    assert.equal(pullB.records.length, 1);
    assert.equal(pullB.records[0].title, '跨设备增量同步验证论文');
    const fetchedBlob = Buffer.from(await (await fetch(`${baseUrl}/api/sync/v1/blobs/${sampleSha}`, { headers })).arrayBuffer());
    assert.equal(fetchedBlob.equals(sampleBytes), true);

    const statusAfter = await (await fetch(`${baseUrl}/api/sync/v1/status?profileId=p_sync`, { headers })).json();
    assert.equal(statusAfter.recordCount, 1);
    assert.equal(statusAfter.blobCount, 1);
    assert.equal(statusAfter.devices.length, 2);

    // 验证前端 DoNoteSync.probeNode 请求组装与响应解析（test-workspace 沙箱拦截外部端口，注入转发钩子）
    const probeFromPage = await page.evaluate(async ({ statusPayload }) => {
      const origFetch = window.fetch;
      let capturedAuth = '';
      let capturedUrl = '';
      window.fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedAuth = init?.headers?.Authorization || '';
        return new Response(JSON.stringify(statusPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      try {
        const res = await window.DoNoteSync.probeNode('http://127.0.0.1:4318/', 'test_sync_token_1234567890');
        return { res, capturedUrl, capturedAuth };
      } finally {
        window.fetch = origFetch;
      }
    }, { statusPayload: statusAfter });
    assert.equal(probeFromPage.res.protocol, 'donote-sync-v1');
    assert.equal(probeFromPage.res.blobCount, 1);
    assert.ok(probeFromPage.capturedUrl.startsWith('http://127.0.0.1:4318/api/sync/v1/status?profileId='));
    assert.equal(probeFromPage.capturedAuth, 'Bearer test_sync_token_1234567890');
  } finally {
    await bridge.close();
    await fs.rm(syncTmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log('PASS r139 10-card achievement hall, daily usage footprints, online update, sidebar & AI manager polish, drop triage, task center and sync-v1');
}
