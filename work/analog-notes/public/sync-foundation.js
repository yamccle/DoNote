/**
 * [INPUT]: 读取本机 IndexedDB 记录状态、PDF/PPT 批注库、DoNoteSyncCrypto 加解密内核与远端 /api/sync/v1 节点响应。
 * [OUTPUT]: 暴露 window.DoNoteSync 核心协议接口，实现增量记录同步、PDF/PPT 批注级细粒度 CRDT 合并与 AES-256-GCM 端到端加密传输。
 * [POS]: 多端在线零信任工作台数据同步内核，与 sync-realtime.js (SSE 推送与设置面板绑定) 协同工作。
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
    try { return (localStorage.getItem(DEVICE_NAME_KEY) || '').trim() || '本机桌面工作台'; }
    catch { return '本机桌面工作台'; }
  }

  function setDeviceName(name) {
    const clean = String(name || '').trim().slice(0, 40) || '本机桌面工作台';
    try { localStorage.setItem(DEVICE_NAME_KEY, clean); } catch {}
    window.DoNoteSync.refreshSettingsCard?.();
    return clean;
  }

  const cursorStorageKey = profileId => 'donote-sync-cursor/' + profileId;
  const tombstoneStorageKey = profileId => 'donote-sync-tombstones/' + profileId;

  function readSyncCursor(profileId) {
    try { return Math.max(0, Number(localStorage.getItem(cursorStorageKey(profileId)) || 0) || 0); } catch { return 0; }
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
    try { localStorage.setItem(tombstoneStorageKey(profileId), JSON.stringify(list.slice(-MAX_TOMBSTONES))); } catch {}
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
    const e2eeEnabled = !!window.DoNoteSyncCrypto?.isE2eeEnabled?.();
    const realtimeConnected = !!window.DoNoteSync?.isRealtimeConnected?.();
    if (!profile) {
      return {
        deviceId: getDeviceId(), deviceName: getDeviceName(),
        totalRecords: 0, stampedRecords: 0, totalAttachments: 0, hashedAttachments: 0,
        remoteCursor: 0, e2eeEnabled, realtimeConnected
      };
    }
    const recs = profile.records || [];
    let stampedRecords = 0, totalAttachments = 0, hashedAttachments = 0;
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
      remoteCursor: readSyncCursor(profile.id),
      e2eeEnabled,
      realtimeConnected
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
      window.DoNoteSync.refreshSettingsCard?.();
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
    window.DoNoteSync.refreshSettingsCard?.();
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
    const savedEndpoint = (() => { try { return localStorage.getItem(ENDPOINT_KEY) || ''; } catch { return ''; } })();
    const base = normalizeSyncUrl(rawUrl || document.getElementById('settingsSyncEndpoint')?.value || savedEndpoint || fallbackConn?.base || document.getElementById('bridgeUrl')?.value || 'http://127.0.0.1:4318');
    const token = String(rawToken || document.getElementById('settingsSyncToken')?.value || fallbackConn?.token || document.getElementById('bridgeAdminToken')?.value || '').trim();
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
    const rTime = String(remoteRec.updatedAt || ''), lTime = String(localRec.updatedAt || '');
    if (rTime !== lTime) return rTime > lTime;
    const rRev = Number(remoteRec.syncMeta?.rev || 0), lRev = Number(localRec.syncMeta?.rev || 0);
    if (rRev !== lRev) return rRev > lRev;
    return String(remoteRec.syncMeta?.deviceId || '') > String(localRec.syncMeta?.deviceId || '');
  }

  async function readWorkspaceAnnotationMarks(profileId, fileId) {
    if (typeof database === 'undefined' || !database || typeof annotationKey !== 'function') return [];
    try {
      const raw = await reqResult(database.transaction('workspace').objectStore('workspace').get(annotationKey(profileId, fileId)));
      return Array.isArray(raw) ? checkedAnnotations(raw) : [];
    } catch {
      return [];
    }
  }

  async function collectLocalAnnotationBundles(profile) {
    const profileId = profile.id;
    const fileIds = new Set();
    for (const note of profile.records || []) {
      for (const att of note.attachments || []) {
        if (att?.id) fileIds.add(att.id);
      }
    }
    const bundles = [];
    for (const fileId of fileIds) {
      const marks = await readWorkspaceAnnotationMarks(profileId, fileId);
      const tombstones = window.DoNoteSyncCrypto?.readMarkTombstones?.(profileId, fileId) || [];
      if (!marks.length && !tombstones.length) continue;
      let latest = '';
      for (const m of marks) {
        const t = String(m.updatedAt || m.createdAt || '');
        if (t > latest) latest = t;
      }
      for (const tb of tombstones) {
        if (String(tb.deletedAt || '') > latest) latest = String(tb.deletedAt);
      }
      bundles.push({ fileId, updatedAt: latest || new Date().toISOString(), marks, tombstones });
    }
    return bundles;
  }

  async function uploadMissingSyncBlobs(base, token, profileId, preparedRecords, passphrase, updateTask) {
    const cryptoApi = window.DoNoteSyncCrypto;
    if (passphrase) {
      const encryptedUploads = new Map();
      for (const note of preparedRecords) {
        for (const att of note.attachments || []) {
          if (!att.sha256 || !/^[a-f0-9]{64}$/i.test(att.sha256)) continue;
          if (att.e2eeBlob?.cipherSha256 && /^[a-f0-9]{64}$/i.test(att.e2eeBlob.cipherSha256)) {
            encryptedUploads.set(att.e2eeBlob.cipherSha256, { att, cipherBlob: null });
          } else {
            const rawBlob = await readBlob(att.id, profileId);
            const { cipherBlob, cipherSha256 } = await cryptoApi.encryptBlob(rawBlob, passphrase);
            att.e2eeBlob = { v: 1, cipherSha256 };
            encryptedUploads.set(cipherSha256, { att, cipherBlob });
          }
        }
      }
      if (!encryptedUploads.size) return;
      updateTask('正在核对远端加密附件块…', 34);
      const { missing = [] } = await syncFetchJson(base, token, '/api/sync/v1/blobs/check', {
        method: 'POST', body: { profileId, hashes: [...encryptedUploads.keys()] }
      });
      for (let i = 0; i < missing.length; i++) {
        const entry = encryptedUploads.get(missing[i]);
        if (!entry) continue;
        updateTask('正在上传加密附件 (' + (i + 1) + '/' + missing.length + ')', 35 + Math.round(((i + 1) / missing.length) * 20));
        let cipherBlob = entry.cipherBlob;
        if (!cipherBlob) {
          const enc = await cryptoApi.encryptBlob(await readBlob(entry.att.id, profileId), passphrase);
          cipherBlob = enc.cipherBlob;
          entry.att.e2eeBlob = { v: 1, cipherSha256: enc.cipherSha256 };
        }
        const putRes = await fetch(base + '/api/sync/v1/blobs/' + entry.att.e2eeBlob.cipherSha256, {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-Profile-Id': profileId },
          body: cipherBlob,
          signal: AbortSignal.timeout(180000)
        });
        if (!putRes.ok) throw new Error('加密附件上传失败 HTTP ' + putRes.status);
      }
      return;
    }

    const allHashes = new Map();
    for (const note of preparedRecords) {
      for (const att of note.attachments || []) {
        if (att.sha256 && /^[a-f0-9]{64}$/i.test(att.sha256)) allHashes.set(att.sha256.toLowerCase(), att);
      }
    }
    if (!allHashes.size) return;
    updateTask('正在比对远端去重附件库…', 34);
    const { missing = [] } = await syncFetchJson(base, token, '/api/sync/v1/blobs/check', {
      method: 'POST', body: { profileId, hashes: [...allHashes.keys()] }
    });
    for (let i = 0; i < missing.length; i++) {
      const hash = missing[i], att = allHashes.get(hash);
      if (!att) continue;
      updateTask('正在上传新增附件 (' + (i + 1) + '/' + missing.length + ') · ' + att.name, 35 + Math.round(((i + 1) / missing.length) * 20));
      const putRes = await fetch(base + '/api/sync/v1/blobs/' + hash, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': att.mime || 'application/octet-stream', 'X-Profile-Id': profileId },
        body: await readBlob(att.id, profileId),
        signal: AbortSignal.timeout(180000)
      });
      if (!putRes.ok) throw new Error('附件上传失败 HTTP ' + putRes.status);
    }
  }

  async function syncNow(rawUrl, rawToken) {
    if (syncing) throw new Error('正在执行多端同步，请稍候…');
    if (typeof ensureReady === 'function' && !ensureReady()) throw new Error('本地记录库尚未就绪。');
    syncing = true;
    const profileId = appState.activeId;
    const cryptoApi = window.DoNoteSyncCrypto;
    const passphrase = cryptoApi?.getPassphrase?.() || '';
    const useE2ee = passphrase.length > 0;

    const updateTask = (detail, percent, state = 'running') => {
      window.DoNoteTasks?.upsert?.('multi-device-sync', {
        kind: 'sync', title: useE2ee ? '多端加密同步 (E2EE)' : '多端增量同步', detail, percent, state
      });
    };

    try {
      const { base, token } = resolveEffectiveConnection(rawUrl, rawToken);
      updateTask('正在校验本机附件内容寻址指纹…', 10);
      await ensureAttachmentHashes({
        onProgress: (done, total, name) => updateTask('正在计算附件指纹 ' + (done + 1) + '/' + total + ' · ' + name, Math.round((done / Math.max(1, total)) * 22))
      });

      const p = activeProfile();
      const preparedRecords = p.records.map(r => {
        const clone = structuredClone(r);
        if (!clone.syncMeta) clone.syncMeta = { rev: 1, deviceId: getDeviceId(), updatedAt: clone.updatedAt || clone.date || new Date().toISOString() };
        return clone;
      });
      await uploadMissingSyncBlobs(base, token, profileId, preparedRecords, passphrase, updateTask);

      updateTask('正在准备增量记录与 PDF/PPT 细粒度批注…', 60);
      const localAnnBundles = await collectLocalAnnotationBundles(p);
      const outboundRecords = useE2ee ? await Promise.all(preparedRecords.map(r => cryptoApi.sealRecord(r, passphrase))) : preparedRecords;
      const outboundAnnotations = useE2ee
        ? await Promise.all(localAnnBundles.map(async b => ({
            fileId: b.fileId, updatedAt: b.updatedAt, syncMeta: { rev: 1, deviceId: getDeviceId(), updatedAt: b.updatedAt },
            e2ee: await cryptoApi.sealJson({ marks: b.marks, tombstones: b.tombstones }, passphrase, 'ann:' + b.fileId)
          })))
        : localAnnBundles;
      const metaEnvelope = useE2ee
        ? { updatedAt: new Date().toISOString(), e2ee: await cryptoApi.sealJson({ topics: p.topics || [], folders: p.folders || [], categories: p.categories }, passphrase, 'meta:' + profileId) }
        : null;

      updateTask('正在与同步节点交换增量变更…', 72);
      const sinceSeq = readSyncCursor(profileId);
      const delta = await syncFetchJson(base, token, '/api/sync/v1/delta', {
        method: 'POST',
        body: {
          profileId, profileName: useE2ee ? '[E2EE]' : p.name, deviceId: getDeviceId(), deviceName: getDeviceName(), sinceSeq,
          ...(useE2ee ? { metaEnvelope } : { categories: p.categories, topics: p.topics, folders: p.folders || [] }),
          records: outboundRecords, annotations: outboundAnnotations, tombstones: readTombstones(profileId)
        }
      });

      if (appState.activeId !== profileId) throw new Error('工作台已切换，未写入远端变更。');
      const incomingRaw = Array.isArray(delta.records) ? delta.records : [];
      const incomingAnnRaw = Array.isArray(delta.annotations) ? delta.annotations : [];
      const remoteTombstones = Array.isArray(delta.tombstones) ? delta.tombstones : [];
      const writes = [];
      let pulledCount = 0, mergedAnnotationsCount = 0;

      const next = structuredClone(appState);
      const target = next.profiles.find(entry => entry.id === profileId);
      let incomingTopics = Array.isArray(delta.topics) ? delta.topics : [];
      let incomingFolders = Array.isArray(delta.folders) ? delta.folders : [];
      if (delta.metaEnvelope?.e2ee) {
        const openedMeta = await cryptoApi.openJson(delta.metaEnvelope.e2ee, passphrase, 'meta:' + profileId);
        if (Array.isArray(openedMeta?.topics)) incomingTopics = openedMeta.topics;
        if (Array.isArray(openedMeta?.folders)) incomingFolders = openedMeta.folders;
      }
      for (const tag of incomingTopics) {
        if (typeof tag === 'string' && tag.trim() && !target.topics.includes(tag) && target.topics.length < MAX_TOPICS) target.topics.push(tag);
      }
      if (incomingFolders.length) {
        target.folders = target.folders || [];
        for (const f of incomingFolders) if (!target.folders.some(item => item.id === f.id)) target.folders.push(f);
        if (typeof validRecordFolders === 'function' && !validRecordFolders(target.folders)) target.folders = p.folders || [];
      }

      const localById = new Map(target.records.map(r => [r.id, r]));
      const existingHashes = new Map();
      for (const r of target.records) for (const a of r.attachments || []) if (a.sha256) existingHashes.set(a.sha256.toLowerCase(), a.id);

      for (const rawRec of incomingRaw) {
        if (!rawRec?.id) continue;
        const remoteRec = rawRec.e2ee ? await cryptoApi.openRecord(rawRec, passphrase) : rawRec;
        const localRec = localById.get(remoteRec.id);
        if (!isRemoteNewer(remoteRec, localRec)) continue;

        for (const att of remoteRec.attachments || []) {
          if (localRec?.attachments?.some(x => x.id === att.id)) continue;
          const plainSha = String(att.sha256 || '').toLowerCase();
          if (!/^[a-f0-9]{64}$/.test(plainSha)) continue;
          let blob;
          const donorId = existingHashes.get(plainSha);
          if (donorId) {
            blob = await readBlob(donorId, profileId);
          } else if (att.e2eeBlob?.cipherSha256) {
            updateTask('正在下载并解密远端附件 · ' + att.name, 84);
            const blobRes = await fetch(base + '/api/sync/v1/blobs/' + String(att.e2eeBlob.cipherSha256).toLowerCase(), {
              headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(180000)
            });
            if (!blobRes.ok) throw new Error('拉取加密附件失败：' + att.name);
            blob = await cryptoApi.decryptBlob(await blobRes.blob(), passphrase, att.mime || 'application/octet-stream');
            if ((await fileDigest(blob)) !== plainSha) throw new Error('解密后附件 SHA-256 校验不一致：' + att.name);
          } else {
            updateTask('正在拉取远端附件 · ' + att.name, 84);
            const blobRes = await fetch(base + '/api/sync/v1/blobs/' + plainSha, {
              headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(180000)
            });
            if (!blobRes.ok) throw new Error('拉取远端附件失败：' + att.name);
            const raw = await blobRes.blob();
            if ((await fileDigest(raw)) !== plainSha) throw new Error('远端附件 SHA-256 校验失败：' + att.name);
            blob = new Blob([raw], { type: att.mime || 'application/octet-stream' });
          }
          writes.push({ key: fileKey(profileId, att.id), blob });
          existingHashes.set(plainSha, att.id);
        }
        const cleanRec = structuredClone(remoteRec);
        for (const att of cleanRec.attachments || []) delete att.e2eeBlob;
        if (validate(cleanRec)) { localById.set(cleanRec.id, cleanRec); pulledCount++; }
      }

      let deletedCount = 0;
      for (const tomb of remoteTombstones) {
        const cur = localById.get(tomb?.id);
        if (cur && String(tomb.deletedAt || '') > String(cur.updatedAt || '')) {
          localById.delete(tomb.id);
          deletedCount++;
        }
      }

      if (pulledCount > 0 || deletedCount > 0 || writes.length > 0 || target.topics.length !== p.topics.length || (target.folders || []).length !== (p.folders || []).length) {
        target.records = [...localById.values()];
        await commitState(next, writes);
        render();
      }

      const repushBundles = [];
      for (const rawAnn of incomingAnnRaw) {
        if (!rawAnn?.fileId || !cryptoApi?.mergeAnnotationBundle) continue;
        const remotePlain = rawAnn.e2ee
          ? await cryptoApi.openJson(rawAnn.e2ee, passphrase, 'ann:' + rawAnn.fileId)
          : { marks: rawAnn.marks || [], tombstones: rawAnn.tombstones || [] };
        const localMarks = await readWorkspaceAnnotationMarks(profileId, rawAnn.fileId);
        const localTombs = cryptoApi.readMarkTombstones(profileId, rawAnn.fileId);
        const merged = cryptoApi.mergeAnnotationBundle(
          { marks: localMarks, tombstones: localTombs },
          { marks: remotePlain.marks || [], tombstones: remotePlain.tombstones || [] }
        );
        cryptoApi.writeMarkTombstones(profileId, rawAnn.fileId, merged.tombstones);
        if (merged.localChanged && typeof putWorkspaceForFile === 'function' && typeof annotationKey === 'function') {
          const validated = checkedAnnotations(merged.marks);
          if (await putWorkspaceForFile(profileId, rawAnn.fileId, annotationKey(profileId, rawAnn.fileId), validated)) {
            mergedAnnotationsCount++;
            if (typeof readingSession !== 'undefined' && readingSession?.file?.id === rawAnn.fileId && readingSession.profileId === profileId) {
              readingSession.annotations = structuredClone(validated);
              if (typeof renderPdfSidebar === 'function') renderPdfSidebar(readingSession);
              if (typeof renderPdfMarks === 'function' && readingSession.pageBox) renderPdfMarks(readingSession);
            }
          }
        }
        if (useE2ee && merged.remoteNeedsUpdate) {
          const nowIso = new Date().toISOString();
          repushBundles.push({
            fileId: rawAnn.fileId, updatedAt: nowIso, syncMeta: { rev: Number(rawAnn.syncMeta?.rev || 1) + 1, deviceId: getDeviceId(), updatedAt: nowIso },
            e2ee: await cryptoApi.sealJson({ marks: merged.marks, tombstones: merged.tombstones }, passphrase, 'ann:' + rawAnn.fileId)
          });
        }
      }

      let finalCursor = delta.cursor || sinceSeq;
      if (repushBundles.length) {
        const repushRes = await syncFetchJson(base, token, '/api/sync/v1/delta', {
          method: 'POST', body: { profileId, deviceId: getDeviceId(), deviceName: getDeviceName(), sinceSeq: finalCursor, records: [], annotations: repushBundles, tombstones: [] }
        });
        finalCursor = repushRes.cursor || finalCursor;
      }

      writeSyncCursor(profileId, finalCursor);
      window.DoNoteSync.refreshSettingsCard?.();
      const summary = '同步完成 · 游标 #' + finalCursor + '，更新记录 ' + pulledCount + ' 条'
        + (mergedAnnotationsCount ? '，合并批注文档 ' + mergedAnnotationsCount + ' 份' : '')
        + (useE2ee ? '（AES-256-GCM 端到端加密）' : '');
      updateTask(summary, 100, 'done');
      return { cursor: finalCursor, pulledCount, deletedCount, mergedAnnotationsCount, e2ee: useE2ee, serverRecords: delta.totalRecords || target.records.length };
    } catch (error) {
      updateTask(error.message || '同步失败', null, 'error');
      throw error;
    } finally {
      syncing = false;
    }
  }

  window.DoNoteSync = {
    deviceId: getDeviceId,
    deviceName: getDeviceName,
    setDeviceName,
    readSyncCursor,
    isSyncing: () => syncing,
    resolveEffectiveConnection,
    stampRecordMutation,
    recordTombstone,
    getReadinessSummary,
    ensureAttachmentHashes,
    probeNode,
    syncNow
  };
})();
