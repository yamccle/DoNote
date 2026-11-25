/**
 * [INPUT]: 读取本机 IndexedDB 记录状态、附件内容摘要与远端 /api/sync/v1 节点响应。
 * [OUTPUT]: 暴露 window.DoNoteSync，维护稳定设备标识、单调版本戳 syncMeta、内容寻址 SHA-256 指纹与增量同步握手。
 * [POS]: 离线优先向多端在线工作台演进的同步底座，支持局域网或自建节点间增量同步记录与去重附件。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(function () {
  const DEVICE_ID_KEY = 'donote-sync-device-id';
  const DEVICE_NAME_KEY = 'donote-sync-device-name';
  const ENDPOINT_KEY = 'donote-sync-endpoint';
  const MAX_TOMBSTONES = 500;
  let syncing = false;

  function getDeviceId() {
    try {
      let id = localStorage.getItem(DEVICE_ID_KEY);
      if (!id || !/^dev-[a-z0-9]{8,32}$/i.test(id)) {
        id = 'dev-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        localStorage.setItem(DEVICE_ID_KEY, id);
      }
      return id;
    } catch {
      return 'dev-local';
    }
  }

  function getDeviceName() {
    try {
      return (localStorage.getItem(DEVICE_NAME_KEY) || '').trim() || '本机桌面工作台';
    } catch {
      return '本机桌面工作台';
    }
  }

  function setDeviceName(name) {
    const clean = String(name || '').trim().slice(0, 40) || '本机桌面工作台';
    try { localStorage.setItem(DEVICE_NAME_KEY, clean); } catch {}
    refreshSettingsCard();
    return clean;
  }

  function cursorStorageKey(profileId) {
    return 'donote-sync-cursor/' + profileId;
  }

  function tombstoneStorageKey(profileId) {
    return 'donote-sync-tombstones/' + profileId;
  }

  function readSyncCursor(profileId) {
    try {
      return Math.max(0, Number(localStorage.getItem(cursorStorageKey(profileId)) || 0) || 0);
    } catch {
      return 0;
    }
  }

  function writeSyncCursor(profileId, seq) {
    try { localStorage.setItem(cursorStorageKey(profileId), String(Math.max(0, Number(seq) || 0))); } catch {}
  }

  function readTombstones(profileId) {
    try {
      const parsed = JSON.parse(localStorage.getItem(tombstoneStorageKey(profileId)) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function recordTombstone(profileId, ids) {
    if (!profileId || !ids) return;
    const list = readTombstones(profileId);
    const now = new Date().toISOString();
    const deviceId = getDeviceId();
    for (const id of ids) {
      if (!id) continue;
      const existing = list.find(entry => entry.id === id);
      if (existing) {
        existing.deletedAt = now;
        existing.rev = (existing.rev || 1) + 1;
        existing.deviceId = deviceId;
      } else {
        list.push({ id, deletedAt: now, rev: 1, deviceId });
      }
    }
    try {
      localStorage.setItem(tombstoneStorageKey(profileId), JSON.stringify(list.slice(-MAX_TOMBSTONES)));
    } catch {}
  }

  function stampRecordMutation(saved, previous) {
    if (!saved || typeof saved !== 'object') return saved;
    const prevRev = Number(previous?.syncMeta?.rev || saved.syncMeta?.rev || 0) || 0;
    saved.syncMeta = {
      rev: prevRev + 1,
      deviceId: getDeviceId(),
      updatedAt: saved.updatedAt || new Date().toISOString()
    };
    return saved;
  }

  function getReadinessSummary(profile = typeof activeProfile === 'function' ? activeProfile() : null) {
    if (!profile) {
      return { deviceId: getDeviceId(), deviceName: getDeviceName(), totalRecords: 0, stampedRecords: 0, totalAttachments: 0, hashedAttachments: 0, remoteCursor: 0 };
    }
    const recs = profile.records || [];
    let stampedRecords = 0;
    let totalAttachments = 0;
    let hashedAttachments = 0;
    for (const r of recs) {
      if (r.syncMeta?.rev > 0) stampedRecords++;
      for (const a of r.attachments || []) {
        totalAttachments++;
        if (typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(a.sha256)) hashedAttachments++;
      }
    }
    return {
      deviceId: getDeviceId(),
      deviceName: getDeviceName(),
      totalRecords: recs.length,
      stampedRecords,
      totalAttachments,
      hashedAttachments,
      remoteCursor: readSyncCursor(profile.id)
    };
  }

  async function ensureAttachmentHashes({ onProgress } = {}) {
    if (typeof ready === 'undefined' || !ready) return { updated: 0 };
    const profileId = appState.activeId;
    const p = activeProfile();
    if (!p) return { updated: 0 };

    const missing = [];
    for (const note of p.records) {
      for (const att of note.attachments || []) {
        if (!att.sha256 || !/^[a-f0-9]{64}$/i.test(att.sha256)) {
          missing.push({ noteId: note.id, attId: att.id, name: att.name });
        }
      }
    }
    if (!missing.length) {
      refreshSettingsCard();
      return { updated: 0 };
    }

    const computed = new Map();
    for (let i = 0; i < missing.length; i++) {
      if (appState.activeId !== profileId) throw new Error('工作台已切换，指纹计算已中止。');
      const item = missing[i];
      onProgress?.(i, missing.length, item.name);
      try {
        const blob = await readBlob(item.attId, profileId);
        const hash = await fileDigest(blob);
        computed.set(item.noteId + ':' + item.attId, hash);
      } catch {}
    }

    if (!computed.size) return { updated: 0 };
    const next = structuredClone(appState);
    const target = next.profiles.find(entry => entry.id === profileId);
    let updated = 0;
    for (const note of target.records) {
      if (!note.syncMeta) {
        note.syncMeta = { rev: 1, deviceId: getDeviceId(), updatedAt: note.updatedAt || note.date || new Date().toISOString() };
      }
      for (const att of note.attachments || []) {
        const hash = computed.get(note.id + ':' + att.id);
        if (hash) {
          att.sha256 = hash;
          updated++;
        }
      }
    }
    await commitState(next);
    refreshSettingsCard();
    return { updated };
  }

  function normalizeSyncUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) throw new Error('请填写同步服务地址（例如 http://127.0.0.1:4318）。');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('同步服务地址格式无效。');
    }
    return url.origin;
  }

  function resolveEffectiveConnection(rawUrl, rawToken) {
    const fallbackConn = typeof bridgeConnection !== 'undefined' ? bridgeConnection : null;
    const base = normalizeSyncUrl(rawUrl || fallbackConn?.base || document.getElementById('bridgeUrl')?.value || 'http://127.0.0.1:4318');
    const token = String(rawToken || fallbackConn?.token || document.getElementById('bridgeAdminToken')?.value || '').trim();
    if (!token) throw new Error('请填写同步管理令牌，或先在「AI 管理」启动连接本机服务。');
    try { localStorage.setItem(ENDPOINT_KEY, base); } catch {}
    return { base, token };
  }

  async function syncFetchJson(base, token, route, { method = 'GET', body } = {}) {
    const res = await fetch(base + route, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(45000)
    });
    if (!res.ok) {
      let msg = '同步服务返回 HTTP ' + res.status;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  async function probeNode(rawUrl, rawToken) {
    const { base, token } = resolveEffectiveConnection(rawUrl, rawToken);
    const profileId = appState?.activeId || 'default';
    return syncFetchJson(base, token, '/api/sync/v1/status?profileId=' + encodeURIComponent(profileId));
  }

  function isRemoteNewer(remoteRec, localRec) {
    if (!localRec) return true;
    const rTime = String(remoteRec.updatedAt || '');
    const lTime = String(localRec.updatedAt || '');
    if (rTime !== lTime) return rTime > lTime;
    const rRev = Number(remoteRec.syncMeta?.rev || 0);
    const lRev = Number(localRec.syncMeta?.rev || 0);
    if (rRev !== lRev) return rRev > lRev;
    return String(remoteRec.syncMeta?.deviceId || '') > String(localRec.syncMeta?.deviceId || '');
  }

  async function syncNow(rawUrl, rawToken) {
    if (syncing) throw new Error('正在执行多端同步，请稍候…');
    if (typeof ensureReady === 'function' && !ensureReady()) throw new Error('本地记录库尚未就绪。');
    syncing = true;
    const profileId = appState.activeId;
    const updateTask = (detail, percent, state = 'running') => {
      window.DoNoteTasks?.upsert?.('multi-device-sync', {
        kind: 'sync',
        title: '多端增量同步',
        detail,
        percent,
        state
      });
    };

    try {
      const { base, token } = resolveEffectiveConnection(rawUrl, rawToken);
      updateTask('正在校验本机附件内容寻址指纹…', 12);
      await ensureAttachmentHashes({
        onProgress: (done, total, name) => updateTask('正在计算附件指纹 ' + (done + 1) + '/' + total + ' · ' + name, Math.round((done / Math.max(1, total)) * 25))
      });

      const p = activeProfile();
      const allHashes = new Map();
      for (const note of p.records) {
        for (const att of note.attachments || []) {
          if (att.sha256 && /^[a-f0-9]{64}$/i.test(att.sha256)) {
            allHashes.set(att.sha256.toLowerCase(), { att, noteId: note.id });
          }
        }
      }

      if (allHashes.size) {
        updateTask('正在比对远端去重附件库…', 35);
        const { missing = [] } = await syncFetchJson(base, token, '/api/sync/v1/blobs/check', {
          method: 'POST',
          body: { profileId, hashes: [...allHashes.keys()] }
        });
        for (let i = 0; i < missing.length; i++) {
          const hash = missing[i];
          const holder = allHashes.get(hash);
          if (!holder) continue;
          updateTask('正在上传新增附件 (' + (i + 1) + '/' + missing.length + ') · ' + holder.att.name, 35 + Math.round(((i + 1) / missing.length) * 25));
          const blob = await readBlob(holder.att.id, profileId);
          const putRes = await fetch(base + '/api/sync/v1/blobs/' + hash, {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': holder.att.mime || 'application/octet-stream',
              'X-Profile-Id': profileId
            },
            body: blob,
            signal: AbortSignal.timeout(180000)
          });
          if (!putRes.ok) {
            let errText = '附件上传失败 HTTP ' + putRes.status;
            try { errText = (await putRes.json()).error || errText; } catch {}
            throw new Error(errText);
          }
        }
      }

      updateTask('正在交换增量记录与目录树…', 68);
      const sinceSeq = readSyncCursor(profileId);
      const pushedRecords = p.records.map(r => {
        const clone = structuredClone(r);
        if (!clone.syncMeta) clone.syncMeta = { rev: 1, deviceId: getDeviceId(), updatedAt: clone.updatedAt || clone.date || new Date().toISOString() };
        return clone;
      });
      const delta = await syncFetchJson(base, token, '/api/sync/v1/delta', {
        method: 'POST',
        body: {
          profileId,
          profileName: p.name,
          deviceId: getDeviceId(),
          deviceName: getDeviceName(),
          sinceSeq,
          categories: p.categories,
          topics: p.topics,
          folders: p.folders || [],
          records: pushedRecords,
          tombstones: readTombstones(profileId)
        }
      });

      if (appState.activeId !== profileId) throw new Error('工作台已切换，未写入远端变更。');
      const incoming = Array.isArray(delta.records) ? delta.records : [];
      const remoteTombstones = Array.isArray(delta.tombstones) ? delta.tombstones : [];
      const writes = [];
      let pulledCount = 0;

      const next = structuredClone(appState);
      const target = next.profiles.find(entry => entry.id === profileId);
      if (Array.isArray(delta.topics)) {
        for (const tag of delta.topics) {
          if (typeof tag === 'string' && tag.trim() && !target.topics.includes(tag) && target.topics.length < MAX_TOPICS) {
            target.topics.push(tag);
          }
        }
      }
      if (Array.isArray(delta.folders) && delta.folders.length) {
        target.folders = target.folders || [];
        for (const f of delta.folders) {
          if (!target.folders.some(item => item.id === f.id)) target.folders.push(f);
        }
        if (!validRecordFolders(target.folders)) target.folders = p.folders || [];
      }

      const localById = new Map(target.records.map(r => [r.id, r]));
      const existingHashes = new Map();
      for (const r of target.records) {
        for (const a of r.attachments || []) {
          if (a.sha256) existingHashes.set(a.sha256.toLowerCase(), a.id);
        }
      }

      for (const remoteRec of incoming) {
        if (!remoteRec?.id) continue;
        const localRec = localById.get(remoteRec.id);
        if (!isRemoteNewer(remoteRec, localRec)) continue;
        for (const att of remoteRec.attachments || []) {
          const alreadyLocal = localRec?.attachments?.some(x => x.id === att.id);
          if (alreadyLocal) continue;
          const sha = String(att.sha256 || '').toLowerCase();
          if (!/^[a-f0-9]{64}$/.test(sha)) continue;
          let blob;
          const donorId = existingHashes.get(sha);
          if (donorId) {
            blob = await readBlob(donorId, profileId);
          } else {
            updateTask('正在拉取远端附件 · ' + att.name, 84);
            const blobRes = await fetch(base + '/api/sync/v1/blobs/' + sha, {
              headers: { Authorization: 'Bearer ' + token },
              signal: AbortSignal.timeout(180000)
            });
            if (!blobRes.ok) throw new Error('拉取远端附件失败：' + att.name);
            const raw = await blobRes.blob();
            if ((await fileDigest(raw)) !== sha) throw new Error('远端附件 SHA-256 校验失败：' + att.name);
            blob = new Blob([raw], { type: att.mime || 'application/octet-stream' });
          }
          writes.push({ key: fileKey(profileId, att.id), blob });
        }
        if (validate(remoteRec)) {
          localById.set(remoteRec.id, remoteRec);
          pulledCount++;
        }
      }

      const deletedIds = new Set(remoteTombstones.map(t => t.id));
      let deletedCount = 0;
      for (const delId of deletedIds) {
        const cur = localById.get(delId);
        const tomb = remoteTombstones.find(t => t.id === delId);
        if (cur && tomb && String(tomb.deletedAt || '') > String(cur.updatedAt || '')) {
          localById.delete(delId);
          deletedCount++;
        }
      }

      if (pulledCount > 0 || deletedCount > 0 || writes.length > 0) {
        target.records = [...localById.values()];
        await commitState(next, writes);
        render();
      }
      writeSyncCursor(profileId, delta.cursor || sinceSeq);
      refreshSettingsCard();

      const summary = '同步完成 · 远端游标 #' + (delta.cursor || 0) + '，拉取更新 ' + pulledCount + ' 条';
      updateTask(summary, 100, 'done');
      return { cursor: delta.cursor || 0, pulledCount, deletedCount, serverRecords: delta.totalRecords || target.records.length };
    } catch (error) {
      updateTask(error.message || '同步失败', null, 'error');
      throw error;
    } finally {
      syncing = false;
    }
  }

  function refreshSettingsCard() {
    const metaEl = document.getElementById('settingsSyncDeviceMeta');
    const nameInput = document.getElementById('settingsSyncDeviceName');
    const endpointInput = document.getElementById('settingsSyncEndpoint');
    const info = getReadinessSummary();
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = info.deviceName;
    }
    if (endpointInput && !endpointInput.value) {
      try {
        endpointInput.value = localStorage.getItem(ENDPOINT_KEY) || 'http://127.0.0.1:4318';
      } catch {}
    }
    if (metaEl) {
      const hashText = info.totalAttachments
        ? '附件指纹 ' + info.hashedAttachments + '/' + info.totalAttachments
        : '暂无附件';
      metaEl.textContent = '节点 ' + info.deviceId + ' · ' + hashText + ' · 同步游标 #' + info.remoteCursor;
    }
  }

  function bindSettingsControls() {
    refreshSettingsCard();
    const nameInput = document.getElementById('settingsSyncDeviceName');
    const hashBtn = document.getElementById('settingsSyncPrepareHashes');
    const probeBtn = document.getElementById('settingsSyncProbeBtn');
    const syncBtn = document.getElementById('settingsSyncNowBtn');
    const endpointInput = document.getElementById('settingsSyncEndpoint');
    const tokenInput = document.getElementById('settingsSyncToken');
    const statusText = document.getElementById('settingsSyncStatusText');

    if (nameInput && !nameInput.__syncBound) {
      nameInput.__syncBound = true;
      nameInput.onchange = () => setDeviceName(nameInput.value);
    }
    if (hashBtn && !hashBtn.__syncBound) {
      hashBtn.__syncBound = true;
      hashBtn.onclick = async () => {
        hashBtn.disabled = true;
        try {
          if (statusText) statusText.textContent = '正在扫描并补齐本机附件 SHA-256 指纹…';
          const { updated } = await ensureAttachmentHashes();
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
          const res = await probeNode(endpointInput?.value, tokenInput?.value);
          if (statusText) {
            statusText.textContent = '握手成功 · 协议 ' + res.protocol + ' · 节点已存 ' + res.recordCount + ' 条记录、' + res.blobCount + ' 份去重附件（游标 #' + res.cursor + '）';
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
          const res = await syncNow(endpointInput?.value, tokenInput?.value);
          if (statusText) {
            statusText.textContent = '同步完成 · 远端游标 #' + res.cursor + '，本次拉取更新 ' + res.pulledCount + ' 条，节点共 ' + res.serverRecords + ' 条记录。';
          }
          toast('多端增量同步已完成');
        } catch (error) {
          if (statusText) statusText.textContent = '同步未完成：' + error.message;
        } finally {
          syncBtn.disabled = false;
        }
      };
    }
  }

  document.addEventListener('workspace-records-changed', refreshSettingsCard);
  window.addEventListener('DOMContentLoaded', () => setTimeout(bindSettingsControls, 80), { once: true });
  setTimeout(bindSettingsControls, 150);

  window.DoNoteSync = {
    deviceId: getDeviceId,
    deviceName: getDeviceName,
    setDeviceName,
    stampRecordMutation,
    recordTombstone,
    getReadinessSummary,
    ensureAttachmentHashes,
    probeNode,
    syncNow,
    refreshSettingsCard
  };
})();
