/**
 * [INPUT]: 依赖 window.DoNoteSync 与 window.DoNoteSyncCrypto，读取「偏好设置 → 多端协同」面板控件。
 * [OUTPUT]: 为 window.DoNoteSync 挂载 SSE 实时变更事件流订阅（startRealtime/stopRealtime）与设置中心双向绑定。
 * [POS]: 多端在线同步的实时连接与界面控制层，实现远端变更毫秒级自动增量拉取。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(function () {
  const ENDPOINT_KEY = 'donote-sync-endpoint';
  const REALTIME_KEY = 'donote-sync-realtime';
  let realtimeAbort = null;
  let realtimeConnected = false;
  let realtimeReconnectTimer = 0;
  let realtimeSyncDebounce = 0;

  function isRealtimePreferred() {
    try { return localStorage.getItem(REALTIME_KEY) === 'on'; } catch { return false; }
  }

  function stopRealtime() {
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = 0;
    clearTimeout(realtimeSyncDebounce);
    realtimeSyncDebounce = 0;
    if (realtimeAbort) {
      realtimeAbort.abort();
      realtimeAbort = null;
    }
    realtimeConnected = false;
    refreshSettingsCard();
  }

  async function startRealtime(rawUrl, rawToken) {
    const sync = window.DoNoteSync;
    if (!sync) return false;
    stopRealtime();
    const { base, token } = sync.resolveEffectiveConnection(rawUrl, rawToken);
    const profileId = (typeof appState !== 'undefined' && appState?.activeId) || 'default';
    const controller = new AbortController();
    realtimeAbort = controller;

    const scheduleReconnect = () => {
      if (controller.signal.aborted || !isRealtimePreferred()) return;
      realtimeConnected = false;
      refreshSettingsCard();
      realtimeReconnectTimer = setTimeout(() => {
        if (isRealtimePreferred()) void startRealtime(base, token).catch(() => {});
      }, 4000);
    };

    (async () => {
      try {
        const res = await fetch(base + '/api/sync/v1/events?profileId=' + encodeURIComponent(profileId), {
          headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
          signal: controller.signal
        });
        if (!res.ok || !res.body) throw new Error('SSE HTTP ' + res.status);
        realtimeConnected = true;
        refreshSettingsCard();

        const reader = res.body.getReader();
        const textDecoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += textDecoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let eventName = 'message', dataLine = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
            }
            if (eventName === 'sync-change' && dataLine) {
              try {
                const payload = JSON.parse(dataLine);
                if (payload.sourceDeviceId !== sync.deviceId() && Number(payload.cursor || 0) > sync.readSyncCursor(profileId)) {
                  clearTimeout(realtimeSyncDebounce);
                  realtimeSyncDebounce = setTimeout(() => {
                    if (!sync.isSyncing()) void sync.syncNow(base, token).catch(() => {});
                  }, 220);
                }
              } catch {}
            }
          }
        }
        scheduleReconnect();
      } catch {
        scheduleReconnect();
      }
    })();

    return true;
  }

  function refreshSettingsCard() {
    const sync = window.DoNoteSync;
    if (!sync) return;
    const metaEl = document.getElementById('settingsSyncDeviceMeta');
    const nameInput = document.getElementById('settingsSyncDeviceName');
    const endpointInput = document.getElementById('settingsSyncEndpoint');
    const rtToggle = document.getElementById('settingsSyncRealtimeToggle');
    const rtMeta = document.getElementById('settingsSyncRealtimeMeta');
    const e2eeBadge = document.getElementById('settingsSyncE2eeBadge');
    const e2eeClear = document.getElementById('settingsSyncClearE2ee');
    const info = sync.getReadinessSummary();

    if (nameInput && document.activeElement !== nameInput) nameInput.value = info.deviceName;
    if (endpointInput && !endpointInput.value) {
      try { endpointInput.value = localStorage.getItem(ENDPOINT_KEY) || 'http://127.0.0.1:4318'; } catch {}
    }
    if (metaEl) {
      const hashText = info.totalAttachments ? '附件指纹 ' + info.hashedAttachments + '/' + info.totalAttachments : '暂无附件';
      metaEl.textContent = '节点 ' + info.deviceId + ' · ' + hashText + ' · 同步游标 #' + info.remoteCursor;
    }
    if (rtToggle) rtToggle.setAttribute('aria-checked', String(isRealtimePreferred() || realtimeConnected));
    if (rtMeta) {
      rtMeta.textContent = realtimeConnected
        ? '● 实时事件流已连接 · 远端节点产生更新时本机将自动增量同步'
        : '开启后保持轻量事件流连接，其他设备推送更新时本机在数秒内自动同步';
    }
    if (e2eeBadge) {
      e2eeBadge.textContent = info.e2eeEnabled ? '已启用 AES-256-GCM' : '未开启';
      e2eeBadge.classList.toggle('is-enabled', info.e2eeEnabled);
    }
    if (e2eeClear) e2eeClear.hidden = !info.e2eeEnabled;
  }

  function bindSettingsControls() {
    const sync = window.DoNoteSync;
    if (!sync) return;
    refreshSettingsCard();
    const nameInput = document.getElementById('settingsSyncDeviceName');
    const hashBtn = document.getElementById('settingsSyncPrepareHashes');
    const probeBtn = document.getElementById('settingsSyncProbeBtn');
    const syncBtn = document.getElementById('settingsSyncNowBtn');
    const endpointInput = document.getElementById('settingsSyncEndpoint');
    const tokenInput = document.getElementById('settingsSyncToken');
    const statusText = document.getElementById('settingsSyncStatusText');
    const rtToggle = document.getElementById('settingsSyncRealtimeToggle');
    const e2eeInput = document.getElementById('settingsSyncE2eePass');
    const e2eeSave = document.getElementById('settingsSyncSaveE2ee');
    const e2eeClear = document.getElementById('settingsSyncClearE2ee');
    const e2eeHint = document.getElementById('settingsSyncE2eeHint');

    if (nameInput && !nameInput.__syncBound) {
      nameInput.__syncBound = true;
      nameInput.onchange = () => sync.setDeviceName(nameInput.value);
    }
    if (hashBtn && !hashBtn.__syncBound) {
      hashBtn.__syncBound = true;
      hashBtn.onclick = async () => {
        hashBtn.disabled = true;
        try {
          if (statusText) statusText.textContent = '正在扫描并补齐本机附件 SHA-256 指纹…';
          const { updated } = await sync.ensureAttachmentHashes();
          if (statusText) statusText.textContent = updated ? '已补齐 ' + updated + ' 个附件的内容寻址指纹。' : '所有附件均已具备 SHA-256 去重指纹。';
        } catch (error) {
          if (statusText) statusText.textContent = error.message;
        } finally {
          hashBtn.disabled = false;
        }
      };
    }
    if (probeBtn && !probeBtn.__syncBound) {
      probeBtn.__syncBound = true;
      probeBtn.onclick = async () => {
        probeBtn.disabled = true;
        try {
          if (statusText) statusText.textContent = '正在与同步节点握手…';
          const res = await sync.probeNode(endpointInput?.value, tokenInput?.value);
          if (statusText) {
            statusText.textContent = '握手成功 · 协议 ' + res.protocol
              + (res.e2eeActive ? ' (E2EE 密文库)' : '')
              + ' · 节点已存 ' + res.recordCount + ' 条记录、' + (res.annotationBundleCount || 0) + ' 份批注包、'
              + res.blobCount + ' 份附件块（游标 #' + res.cursor + '）';
          }
        } catch (error) {
          if (statusText) statusText.textContent = '握手未通过：' + error.message;
        } finally {
          probeBtn.disabled = false;
        }
      };
    }
    if (syncBtn && !syncBtn.__syncBound) {
      syncBtn.__syncBound = true;
      syncBtn.onclick = async () => {
        syncBtn.disabled = true;
        try {
          if (statusText) statusText.textContent = '正在执行多端增量同步…';
          const res = await sync.syncNow(endpointInput?.value, tokenInput?.value);
          if (statusText) {
            statusText.textContent = '同步完成 · 远端游标 #' + res.cursor + '，更新记录 ' + res.pulledCount + ' 条'
              + (res.mergedAnnotationsCount ? '，无冲突合并批注 ' + res.mergedAnnotationsCount + ' 份' : '')
              + (res.e2ee ? ' · 端到端加密已生效' : '');
          }
          if (typeof toast === 'function') toast('多端增量同步已完成');
        } catch (error) {
          if (statusText) statusText.textContent = '同步未完成：' + error.message;
        } finally {
          syncBtn.disabled = false;
        }
      };
    }
    if (rtToggle && !rtToggle.__syncBound) {
      rtToggle.__syncBound = true;
      rtToggle.onclick = async event => {
        event.stopPropagation();
        const next = !isRealtimePreferred() && !realtimeConnected;
        try { localStorage.setItem(REALTIME_KEY, next ? 'on' : 'off'); } catch {}
        if (!next) {
          stopRealtime();
          if (typeof toast === 'function') toast('已关闭实时同步推送');
        } else {
          try {
            await startRealtime(endpointInput?.value, tokenInput?.value);
            if (typeof toast === 'function') toast('已开启 SSE 实时变更推送');
          } catch (error) {
            try { localStorage.setItem(REALTIME_KEY, 'off'); } catch {}
            refreshSettingsCard();
            if (statusText) statusText.textContent = error.message;
          }
        }
      };
    }
    if (e2eeSave && !e2eeSave.__syncBound) {
      e2eeSave.__syncBound = true;
      e2eeSave.onclick = () => {
        const val = String(e2eeInput?.value || '').trim();
        if (!val) {
          if (e2eeHint) e2eeHint.textContent = '请输入至少 6 位字符的端到端加密口令，或点击「关闭加密」恢复明文同步。';
          return;
        }
        if (val.length < 6) {
          if (e2eeHint) e2eeHint.textContent = '为保障密钥熵强度，加密口令请至少输入 6 个字符。';
          return;
        }
        window.DoNoteSyncCrypto?.setPassphrase(val);
        if (e2eeInput) e2eeInput.value = '';
        refreshSettingsCard();
        if (e2eeHint) e2eeHint.textContent = '✓ 已启用 PBKDF2 (210,000 次迭代) + AES-256-GCM 端到端加密，后续同步服务端仅保存密文。';
        if (typeof toast === 'function') toast('已启用端到端加密同步（E2EE）');
      };
    }
    if (e2eeClear && !e2eeClear.__syncBound) {
      e2eeClear.__syncBound = true;
      e2eeClear.onclick = () => {
        window.DoNoteSyncCrypto?.setPassphrase('');
        if (e2eeInput) e2eeInput.value = '';
        refreshSettingsCard();
        if (e2eeHint) e2eeHint.textContent = '已关闭端到端加密口令，恢复局域网明文同步模式。';
        if (typeof toast === 'function') toast('已关闭端到端加密');
      };
    }
    if (isRealtimePreferred() && !realtimeConnected) {
      try { void startRealtime(); } catch {}
    }
  }

  if (window.DoNoteSync) {
    Object.assign(window.DoNoteSync, {
      startRealtime,
      stopRealtime,
      isRealtimeConnected: () => realtimeConnected,
      refreshSettingsCard
    });
  }

  document.addEventListener('workspace-records-changed', refreshSettingsCard);
  window.addEventListener('DOMContentLoaded', () => setTimeout(bindSettingsControls, 80), { once: true });
  setTimeout(bindSettingsControls, 150);
})();
