/**
 * [INPUT]: 接收经过管理令牌鉴权的 HTTP 请求、持久化状态目录与原子事务函数。
 * [OUTPUT]: 提供 handleSyncV1，实现 /status、/events(SSE 实时推送)、/blobs/check、/blobs/:sha256 与 /delta（含 PDF/PPT 批注合并与 E2EE 密文信封）。
 * [POS]: 多端在线工作台服务端同步层，支持零信任端到端加密信封存储、批注级细粒度合并与毫秒级变更广播。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { promises as fs, createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROTOCOL_VERSION = 'donote-sync-v1';
const MAX_SYNC_BLOB = 2 * 1024 * 1024 * 1024; // 2 GiB per content-addressed attachment
const SHA_RE = /^[a-f0-9]{64}$/;

export async function createSyncStore(rootDir) {
  const syncDir = path.join(rootDir, 'sync-v1');
  const blobsDir = path.join(syncDir, 'blobs');
  await fs.mkdir(blobsDir, { recursive: true, mode: 0o700 });
  return {
    syncDir,
    blobsDir,
    subscribers: new Map() // profileId -> Set<res>
  };
}

function broadcastSyncEvent(syncStore, profileId, payload) {
  const subs = syncStore.subscribers?.get(profileId);
  if (!subs?.size) return;
  const frame = `event: sync-change\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...subs]) {
    try {
      client.write(frame);
    } catch {
      subs.delete(client);
    }
  }
}

function isNewerRevision(incoming, existing) {
  if (!existing) return true;
  const inTime = String(incoming.updatedAt || '');
  const exTime = String(existing.updatedAt || '');
  if (inTime !== exTime) return inTime > exTime;
  const inRev = Number(incoming.syncMeta?.rev || 0);
  const exRev = Number(existing.syncMeta?.rev || 0);
  if (inRev !== exRev) return inRev > exRev;
  return String(incoming.syncMeta?.deviceId || '') >= String(existing.syncMeta?.deviceId || '');
}

function validE2eeEnvelope(env) {
  return !!env && typeof env === 'object' && env.v === 1
    && typeof env.salt === 'string' && env.salt.length <= 128
    && typeof env.iv === 'string' && env.iv.length <= 128
    && typeof env.ct === 'string' && env.ct.length > 0 && env.ct.length <= 24 * 1024 * 1024;
}

function markTime(m) {
  return String(m?.updatedAt || m?.createdAt || '');
}

function mergeServerPlainAnnotations(existing = {}, incoming = {}) {
  const tombMap = new Map();
  for (const t of [...(existing.tombstones || []), ...(incoming.tombstones || [])]) {
    if (!t || typeof t.id !== 'string' || !t.deletedAt) continue;
    const prev = tombMap.get(t.id);
    if (!prev || String(t.deletedAt) > String(prev.deletedAt)) {
      tombMap.set(t.id, { id: t.id, deletedAt: String(t.deletedAt) });
    }
  }
  const markMap = new Map();
  for (const m of existing.marks || []) {
    if (m?.id) markMap.set(m.id, m);
  }
  for (const m of incoming.marks || []) {
    if (!m?.id) continue;
    const cur = markMap.get(m.id);
    if (!cur || markTime(m) >= markTime(cur)) markMap.set(m.id, m);
  }
  const marks = [];
  for (const m of markMap.values()) {
    const tomb = tombMap.get(m.id);
    if (tomb && String(tomb.deletedAt) >= markTime(m)) continue;
    if (tomb && markTime(m) > String(tomb.deletedAt)) tombMap.delete(m.id);
    marks.push(m);
  }
  marks.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  const tombstones = [...tombMap.values()].slice(-1000);
  const changed = JSON.stringify(marks) !== JSON.stringify(existing.marks || [])
    || JSON.stringify(tombstones) !== JSON.stringify(existing.tombstones || []);
  return { marks, tombstones, changed };
}

export async function handleSyncV1({ req, res, url, route, who, owner, fail, identifier, bounded, jsonBody, transact, getState, log, syncStore, reply }) {
  if (!route.startsWith('/api/sync/v1/')) return false;
  owner(who);

  const { blobsDir } = syncStore;

  if (route === '/api/sync/v1/status' && req.method === 'GET') {
    const profileId = url.searchParams.get('profileId') || 'default';
    const state = getState();
    const space = state.syncSpaces?.[profileId];
    const blobCount = Object.keys(state.syncBlobs || {}).length;
    reply({
      ok: true,
      protocol: PROTOCOL_VERSION,
      capabilities: ['delta-v1', 'crdt-annotations', 'sse-events', 'e2ee-v1'],
      profileId,
      cursor: space?.cursor || 0,
      recordCount: Object.keys(space?.records || {}).length,
      annotationBundleCount: Object.keys(space?.annotations || {}).length,
      tombstoneCount: Object.keys(space?.tombstones || {}).length,
      blobCount,
      e2eeActive: !!space?.e2eeActive,
      realtimeSubscribers: syncStore.subscribers?.get(profileId)?.size || 0,
      devices: Object.values(space?.devices || {})
    });
    return true;
  }

  if (route === '/api/sync/v1/events' && req.method === 'GET') {
    const profileId = url.searchParams.get('profileId') || 'default';
    if (!identifier(profileId)) throw fail('无效的工作台 profileId。');
    const cursor = getState().syncSpaces?.[profileId]?.cursor || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ profileId, cursor, protocol: PROTOCOL_VERSION })}\n\n`);

    let set = syncStore.subscribers.get(profileId);
    if (!set) {
      set = new Set();
      syncStore.subscribers.set(profileId, set);
    }
    set.add(res);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 18000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (!set.size) syncStore.subscribers.delete(profileId);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return true;
  }

  if (route === '/api/sync/v1/blobs/check' && req.method === 'POST') {
    const body = await jsonBody(req, 2 * 1024 * 1024);
    if (!Array.isArray(body.hashes) || body.hashes.length > 5000) {
      throw fail('附件哈希列表格式无效。');
    }
    const state = getState();
    const known = state.syncBlobs || {};
    const missing = [];
    for (const raw of body.hashes) {
      const sha = String(raw || '').toLowerCase();
      if (!SHA_RE.test(sha)) throw fail('无效的 SHA-256 指纹：' + raw);
      if (!known[sha]) missing.push(sha);
    }
    reply({ missing });
    return true;
  }

  const blobMatch = route.match(/^\/api\/sync\/v1\/blobs\/([a-fA-F0-9]{64})$/);
  if (blobMatch && req.method === 'PUT') {
    const expectedSha = blobMatch[1].toLowerCase();
    const targetPath = path.join(blobsDir, expectedSha + '.blob');
    const tempPath = targetPath + '.' + crypto.randomUUID() + '.tmp';
    const hasher = crypto.createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        req,
        new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > MAX_SYNC_BLOB) return cb(fail('单个同步附件超过 2 GiB 上限。', 413));
            hasher.update(chunk);
            cb(null, chunk);
          }
        }),
        createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
      );
      const actualSha = hasher.digest('hex');
      if (actualSha !== expectedSha) {
        throw fail('上传附件内容与声明的 SHA-256 指纹不一致。', 400);
      }
      await fs.rename(tempPath, targetPath).catch(async err => {
        if (err.code === 'EEXIST') await fs.unlink(tempPath).catch(() => {});
        else throw err;
      });
      const mime = bounded(req.headers['content-type'], 150) ? req.headers['content-type'] : 'application/octet-stream';
      await transact(s => {
        s.syncBlobs ??= {};
        s.syncBlobs[expectedSha] = { sha256: expectedSha, size, mime, storedAt: new Date().toISOString() };
        log(s, 'owner', 'sync-blob-stored', { sha256: expectedSha.slice(0, 16), size });
      });
      reply({ ok: true, sha256: expectedSha, size }, 201);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
    return true;
  }

  if (blobMatch && req.method === 'GET') {
    const sha = blobMatch[1].toLowerCase();
    const meta = getState().syncBlobs?.[sha];
    const targetPath = path.join(blobsDir, sha + '.blob');
    if (!meta) throw fail('远端不存在该 SHA-256 附件。', 404);
    try {
      await fs.access(targetPath);
    } catch {
      throw fail('远端附件块文件缺失。', 404);
    }
    res.writeHead(200, {
      'Content-Type': meta.mime || 'application/octet-stream',
      'Content-Length': meta.size
    });
    await pipeline(createReadStream(targetPath), res);
    return true;
  }

  if (route === '/api/sync/v1/delta' && req.method === 'POST') {
    const input = await jsonBody(req, 48 * 1024 * 1024);
    if (!identifier(input.profileId)) throw fail('无效的工作台 profileId。');
    const sinceSeq = Math.max(0, Number(input.sinceSeq || 0) || 0);
    const deviceId = bounded(input.deviceId, 64) ? input.deviceId : 'dev-unknown';
    const deviceName = bounded(input.deviceName, 60) ? input.deviceName : '工作台节点';
    const incomingRecords = Array.isArray(input.records) ? input.records : [];
    const incomingTombstones = Array.isArray(input.tombstones) ? input.tombstones : [];
    const incomingAnnotations = Array.isArray(input.annotations) ? input.annotations : [];
    if (incomingRecords.length > 50000 || incomingAnnotations.length > 20000) {
      throw fail('单次同步条目数量超出上限。');
    }

    let changedCursor = 0;
    const result = await transact(s => {
      s.syncSpaces ??= {};
      const space = (s.syncSpaces[input.profileId] ??= {
        profileId: input.profileId,
        cursor: 0,
        topics: [],
        folders: [],
        metaEnvelope: null,
        metaSeq: 0,
        e2eeActive: false,
        records: {},
        recordSeq: {},
        annotations: {},
        annotationSeq: {},
        tombstones: {},
        devices: {}
      });
      space.annotations ??= {};
      space.annotationSeq ??= {};

      const cursorBefore = space.cursor;
      let metaChanged = false;
      space.devices[deviceId] = {
        deviceId,
        deviceName,
        lastSeenAt: new Date().toISOString()
      };

      if (input.metaEnvelope && validE2eeEnvelope(input.metaEnvelope.e2ee)) {
        const prevMetaTime = String(space.metaEnvelope?.updatedAt || '');
        const nextMetaTime = String(input.metaEnvelope.updatedAt || new Date().toISOString());
        if (!space.metaEnvelope || nextMetaTime >= prevMetaTime && JSON.stringify(input.metaEnvelope.e2ee) !== JSON.stringify(space.metaEnvelope.e2ee)) {
          space.metaEnvelope = { updatedAt: nextMetaTime, e2ee: input.metaEnvelope.e2ee };
          space.e2eeActive = true;
          space.topics = [];
          space.folders = [];
          metaChanged = true;
        }
      } else {
        if (Array.isArray(input.topics)) {
          const mergedTopics = [...new Set([...(space.topics || []), ...input.topics.filter(t => bounded(t, 60, true))])].slice(0, 100);
          if (JSON.stringify(mergedTopics) !== JSON.stringify(space.topics || [])) {
            space.topics = mergedTopics;
            metaChanged = true;
          }
        }
        if (Array.isArray(input.folders)) {
          const byId = new Map((space.folders || []).map(f => [f.id, f]));
          for (const f of input.folders) {
            if (f && identifier(f.id) && bounded(f.name, 60, true)) byId.set(f.id, f);
          }
          const nextFolders = [...byId.values()].slice(0, 300);
          if (JSON.stringify(nextFolders) !== JSON.stringify(space.folders || [])) {
            space.folders = nextFolders;
            metaChanged = true;
          }
        }
      }

      let accepted = 0;
      for (const rec of incomingRecords) {
        if (!rec || !identifier(rec.id)) continue;
        const hasE2ee = validE2eeEnvelope(rec.e2ee);
        if (!hasE2ee && !bounded(rec.title, 240, true)) continue;
        if (hasE2ee) space.e2eeActive = true;
        const tomb = space.tombstones[rec.id];
        if (tomb && String(tomb.deletedAt || '') > String(rec.updatedAt || '')) continue;
        const existing = space.records[rec.id];
        if (!existing || isNewerRevision(rec, existing) && JSON.stringify(rec) !== JSON.stringify(existing)) {
          space.cursor += 1;
          space.records[rec.id] = rec;
          space.recordSeq[rec.id] = space.cursor;
          delete space.tombstones[rec.id];
          accepted++;
        }
      }

      for (const tomb of incomingTombstones) {
        if (!tomb || !identifier(tomb.id) || !bounded(tomb.deletedAt, 80, true)) continue;
        const curRec = space.records[tomb.id];
        if (!curRec || String(tomb.deletedAt) > String(curRec.updatedAt || '')) {
          if (curRec || !space.tombstones[tomb.id]) {
            delete space.records[tomb.id];
            space.cursor += 1;
            space.tombstones[tomb.id] = { id: tomb.id, deletedAt: tomb.deletedAt, seq: space.cursor, deviceId };
          }
        }
      }

      let acceptedAnnotations = 0;
      for (const ann of incomingAnnotations) {
        if (!ann || !identifier(ann.fileId)) continue;
        const curAnn = space.annotations[ann.fileId];
        if (validE2eeEnvelope(ann.e2ee)) {
          space.e2eeActive = true;
          if (!curAnn || !curAnn.e2ee || isNewerRevision(ann, curAnn) && JSON.stringify(ann.e2ee) !== JSON.stringify(curAnn.e2ee)) {
            space.cursor += 1;
            space.annotations[ann.fileId] = {
              fileId: ann.fileId,
              updatedAt: String(ann.updatedAt || new Date().toISOString()),
              syncMeta: ann.syncMeta || { rev: 1, deviceId },
              e2ee: ann.e2ee
            };
            space.annotationSeq[ann.fileId] = space.cursor;
            acceptedAnnotations++;
          }
        } else if (Array.isArray(ann.marks)) {
          const merged = mergeServerPlainAnnotations(curAnn?.e2ee ? {} : curAnn, ann);
          if (!curAnn || curAnn.e2ee || merged.changed) {
            space.cursor += 1;
            space.annotations[ann.fileId] = {
              fileId: ann.fileId,
              updatedAt: String(ann.updatedAt || new Date().toISOString()),
              marks: merged.marks.slice(0, 5000),
              tombstones: merged.tombstones
            };
            space.annotationSeq[ann.fileId] = space.cursor;
            acceptedAnnotations++;
          }
        }
      }

      if (metaChanged) {
        if (space.cursor === cursorBefore) space.cursor += 1;
        space.metaSeq = space.cursor;
      }

      if (space.cursor > cursorBefore) {
        changedCursor = space.cursor;
        log(s, 'owner', 'sync-delta', {
          profileId: input.profileId,
          deviceId,
          accepted,
          acceptedAnnotations,
          e2ee: !!space.e2eeActive,
          cursor: space.cursor
        });
      }

      const deltaRecords = Object.values(space.records).filter(r => (space.recordSeq[r.id] || 0) > sinceSeq);
      const deltaAnnotations = Object.values(space.annotations).filter(a => (space.annotationSeq[a.fileId] || 0) > sinceSeq);
      const deltaTombstones = Object.values(space.tombstones).filter(t => (t.seq || 0) > sinceSeq);
      return {
        protocol: PROTOCOL_VERSION,
        cursor: space.cursor,
        accepted,
        acceptedAnnotations,
        e2eeActive: !!space.e2eeActive,
        totalRecords: Object.keys(space.records).length,
        topics: space.topics,
        folders: space.folders,
        metaEnvelope: (space.metaSeq || 0) > sinceSeq ? space.metaEnvelope : null,
        records: deltaRecords,
        annotations: deltaAnnotations,
        tombstones: deltaTombstones
      };
    });

    if (changedCursor > 0) {
      broadcastSyncEvent(syncStore, input.profileId, {
        profileId: input.profileId,
        cursor: changedCursor,
        sourceDeviceId: deviceId,
        updatedAt: new Date().toISOString()
      });
    }

    reply(result);
    return true;
  }

  throw fail('未知的同步接口路径。', 404);
}
