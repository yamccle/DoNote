/**
 * [INPUT]: 读取批注条目集合、删除墓碑以及用户在「多端协同」设置的端到端加密口令。
 * [OUTPUT]: 暴露 window.DoNoteSyncCrypto，提供 PDF/PPT 批注元素级 CRDT 合并与 PBKDF2-HKDF-AES256GCM 端到端加解密。
 * [POS]: 多端同步安全与无冲突合并内核，供 pdf-annotations.js、presentation-preview.js 与 sync-foundation.js 调用。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

(function () {
  const E2EE_STORAGE_KEY = 'donote-sync-e2ee-pass';
  const MARK_TOMB_PREFIX = 'donote-mark-tombs/';
  const MAX_MARK_TOMBS = 1000;
  const PBKDF2_ITERATIONS = 210000;
  const BLOB_MAGIC = new Uint8Array([0x44, 0x4e, 0x45, 0x31]); // "DNE1"
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const masterKeyCache = new Map();

  function markTombKey(profileId, fileId) {
    return MARK_TOMB_PREFIX + profileId + '/' + fileId;
  }

  function readMarkTombstones(profileId, fileId) {
    if (!profileId || !fileId) return [];
    try {
      const raw = JSON.parse(localStorage.getItem(markTombKey(profileId, fileId)) || '[]');
      return Array.isArray(raw) ? raw.filter(item => item && typeof item.id === 'string' && typeof item.deletedAt === 'string') : [];
    } catch {
      return [];
    }
  }

  function writeMarkTombstones(profileId, fileId, list) {
    if (!profileId || !fileId) return;
    try {
      const clean = (Array.isArray(list) ? list : [])
        .filter(item => item && typeof item.id === 'string' && typeof item.deletedAt === 'string')
        .slice(-MAX_MARK_TOMBS);
      if (clean.length) localStorage.setItem(markTombKey(profileId, fileId), JSON.stringify(clean));
      else localStorage.removeItem(markTombKey(profileId, fileId));
    } catch {}
  }

  function recordMarkTombstones(profileId, fileId, ids, deletedAt = new Date().toISOString()) {
    if (!profileId || !fileId || !Array.isArray(ids) || !ids.length) return;
    const list = readMarkTombstones(profileId, fileId);
    const byId = new Map(list.map(item => [item.id, item]));
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      const prev = byId.get(id);
      if (!prev || deletedAt >= prev.deletedAt) {
        byId.set(id, { id, deletedAt });
      }
    }
    writeMarkTombstones(profileId, fileId, [...byId.values()]);
  }

  function markTimestamp(mark) {
    return String(mark?.updatedAt || mark?.createdAt || '');
  }

  function isPptSlideLevelComment(mark) {
    return mark?.kind === 'comment'
      && Array.isArray(mark.rects) && mark.rects.length === 0
      && Array.isArray(mark.points) && mark.points.length === 0;
  }

  // 元素级 LWW-Element-Set + PPT 同页离线并发批注无损归并
  function mergeAnnotationBundle(localBundle = {}, remoteBundle = {}) {
    const localMarks = Array.isArray(localBundle.marks) ? localBundle.marks : [];
    const remoteMarks = Array.isArray(remoteBundle.marks) ? remoteBundle.marks : [];
    const localTombs = Array.isArray(localBundle.tombstones) ? localBundle.tombstones : [];
    const remoteTombs = Array.isArray(remoteBundle.tombstones) ? remoteBundle.tombstones : [];

    const tombMap = new Map();
    for (const tomb of [...localTombs, ...remoteTombs]) {
      if (!tomb || typeof tomb.id !== 'string' || !tomb.deletedAt) continue;
      const cur = tombMap.get(tomb.id);
      if (!cur || String(tomb.deletedAt) > String(cur.deletedAt)) {
        tombMap.set(tomb.id, { id: tomb.id, deletedAt: String(tomb.deletedAt) });
      }
    }

    const markMap = new Map();
    for (const mark of localMarks) {
      if (mark?.id) markMap.set(mark.id, structuredClone(mark));
    }
    for (const rMark of remoteMarks) {
      if (!rMark?.id) continue;
      const lMark = markMap.get(rMark.id);
      if (!lMark || markTimestamp(rMark) > markTimestamp(lMark)
        || (markTimestamp(rMark) === markTimestamp(lMark) && JSON.stringify(rMark) > JSON.stringify(lMark))) {
        markMap.set(rMark.id, structuredClone(rMark));
      }
    }

    const surviving = [];
    for (const mark of markMap.values()) {
      const tomb = tombMap.get(mark.id);
      if (tomb && String(tomb.deletedAt) >= markTimestamp(mark)) continue;
      if (tomb && markTimestamp(mark) > String(tomb.deletedAt)) tombMap.delete(mark.id);
      surviving.push(mark);
    }

    // 若两台设备离线在同一页 PPT 新建了不同 ID 的页级批注，自动无损拼接正文并收敛为单条记录
    const slideByPage = new Map();
    const finalMarks = [];
    for (const mark of surviving) {
      if (!isPptSlideLevelComment(mark)) {
        finalMarks.push(mark);
        continue;
      }
      const existing = slideByPage.get(mark.page);
      if (!existing) {
        slideByPage.set(mark.page, mark);
        finalMarks.push(mark);
      } else {
        const primary = markTimestamp(mark) >= markTimestamp(existing) ? mark : existing;
        const secondary = primary === mark ? existing : mark;
        const pNote = String(primary.note || '').trim();
        const sNote = String(secondary.note || '').trim();
        if (sNote && !pNote.includes(sNote)) {
          primary.note = (pNote ? pNote + '\n\n---\n' + sNote : sNote).slice(0, 29000);
          primary.updatedAt = new Date().toISOString();
        }
        const idx = finalMarks.indexOf(existing);
        if (idx >= 0) finalMarks[idx] = primary;
        slideByPage.set(mark.page, primary);
        tombMap.set(secondary.id, { id: secondary.id, deletedAt: primary.updatedAt || new Date().toISOString() });
      }
    }

    finalMarks.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    const mergedTombs = [...tombMap.values()].slice(-MAX_MARK_TOMBS);
    const localJson = JSON.stringify(localMarks);
    const mergedJson = JSON.stringify(finalMarks);
    const remoteJson = JSON.stringify(remoteMarks);
    return {
      marks: finalMarks,
      tombstones: mergedTombs,
      localChanged: localJson !== mergedJson,
      remoteNeedsUpdate: remoteJson !== mergedJson
    };
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function getPassphrase() {
    try { return localStorage.getItem(E2EE_STORAGE_KEY) || ''; } catch { return ''; }
  }

  function setPassphrase(pass) {
    const clean = String(pass || '').trim();
    try {
      if (clean) localStorage.setItem(E2EE_STORAGE_KEY, clean);
      else localStorage.removeItem(E2EE_STORAGE_KEY);
    } catch {}
    return clean;
  }

  function isE2eeEnabled() {
    return getPassphrase().length > 0;
  }

  async function getHkdfMasterKey(passphrase) {
    const pass = String(passphrase || '').trim();
    if (!pass) throw new Error('未设置端到端加密口令。');
    if (masterKeyCache.has(pass)) return masterKeyCache.get(pass);

    const task = (async () => {
      const baseKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode('donote-e2ee-pass-v1:' + pass),
        'PBKDF2',
        false,
        ['deriveBits']
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: encoder.encode('donote-e2ee-master-salt-v1'),
          iterations: PBKDF2_ITERATIONS
        },
        baseKey,
        256
      );
      return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    })().catch(err => {
      masterKeyCache.delete(pass);
      throw err;
    });

    masterKeyCache.set(pass, task);
    return task;
  }

  async function deriveItemAesKey(passphrase, saltBytes, contextLabel) {
    const hkdfKey = await getHkdfMasterKey(passphrase);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: saltBytes,
        info: encoder.encode('donote-e2ee-item-v1:' + contextLabel)
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function sealJson(payload, passphrase, contextLabel = 'json') {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await deriveItemAesKey(passphrase, salt, contextLabel);
    const plaintext = encoder.encode(JSON.stringify(payload));
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
    return {
      v: 1,
      alg: 'PBKDF2-HKDF-AES256GCM',
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(cipherBuf))
    };
  }

  async function openJson(envelope, passphrase, contextLabel = 'json') {
    if (!envelope || envelope.v !== 1 || !envelope.salt || !envelope.iv || !envelope.ct) {
      throw new Error('端到端加密信封格式无效。');
    }
    if (!String(passphrase || '').trim()) {
      throw new Error('远端数据已启用端到端加密（E2EE），请先在「设置 → 多端协同」输入同步加密口令。');
    }
    try {
      const salt = base64ToBytes(envelope.salt);
      const iv = base64ToBytes(envelope.iv);
      const ct = base64ToBytes(envelope.ct);
      const aesKey = await deriveItemAesKey(passphrase, salt, contextLabel);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
      return JSON.parse(decoder.decode(plainBuf));
    } catch {
      throw new Error('端到端解密失败：同步加密口令不匹配或密文已被篡改。');
    }
  }

  async function sealRecord(record, passphrase) {
    const updatedAt = record.updatedAt || record.date || new Date().toISOString();
    const e2ee = await sealJson(record, passphrase, 'record:' + record.id);
    return {
      id: record.id,
      title: '[E2EE 加密记录]',
      updatedAt,
      syncMeta: record.syncMeta,
      e2ee
    };
  }

  async function openRecord(envelopeRecord, passphrase) {
    if (!envelopeRecord?.e2ee) return envelopeRecord;
    return openJson(envelopeRecord.e2ee, passphrase, 'record:' + envelopeRecord.id);
  }

  async function encryptBlob(blob, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await deriveItemAesKey(passphrase, salt, 'blob');
    const plainBytes = await blob.arrayBuffer();
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plainBytes);
    const cipherArr = new Uint8Array(cipherBuf);
    const framed = new Uint8Array(4 + 16 + 12 + cipherArr.length);
    framed.set(BLOB_MAGIC, 0);
    framed.set(salt, 4);
    framed.set(iv, 20);
    framed.set(cipherArr, 32);
    const cipherBlob = new Blob([framed], { type: 'application/octet-stream' });
    const hashBuf = await crypto.subtle.digest('SHA-256', framed);
    const cipherSha256 = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
    return { cipherBlob, cipherSha256 };
  }

  async function decryptBlob(cipherBlob, passphrase, mime = 'application/octet-stream') {
    if (!String(passphrase || '').trim()) {
      throw new Error('远端附件已启用端到端加密（E2EE），请先输入同步加密口令。');
    }
    const bytes = new Uint8Array(await cipherBlob.arrayBuffer());
    if (bytes.length < 48 || bytes[0] !== 0x44 || bytes[1] !== 0x4e || bytes[2] !== 0x45 || bytes[3] !== 0x31) {
      throw new Error('加密附件二进制帧头无效。');
    }
    const salt = bytes.subarray(4, 20);
    const iv = bytes.subarray(20, 32);
    const ct = bytes.subarray(32);
    try {
      const aesKey = await deriveItemAesKey(passphrase, salt, 'blob');
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
      return new Blob([plainBuf], { type: mime });
    } catch {
      throw new Error('附件端到端解密失败：加密口令不匹配或数据损坏。');
    }
  }

  window.DoNoteSyncCrypto = {
    readMarkTombstones,
    writeMarkTombstones,
    recordMarkTombstones,
    mergeAnnotationBundle,
    getPassphrase,
    setPassphrase,
    isE2eeEnabled,
    sealJson,
    openJson,
    sealRecord,
    openRecord,
    encryptBlob,
    decryptBlob
  };
})();
