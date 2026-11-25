/**
 * [INPUT]: 接收经过管理令牌鉴权的 HTTP 请求、持久化状态目录与原子事务函数。
 * [OUTPUT]: 提供 handleSyncV1，实现 /api/sync/v1/status、/blobs/check、/blobs/:sha256 与 /delta 增量同步协议。
 * [POS]: 多端在线工作台服务端同步层，以 SHA-256 内容寻址去重存储附件并维护单调变更游标。
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
  return { syncDir, blobsDir };
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
      profileId,
      cursor: space?.cursor || 0,
      recordCount: Object.keys(space?.records || {}).length,
      tombstoneCount: Object.keys(space?.tombstones || {}).length,
      blobCount,
      devices: Object.values(space?.devices || {})
    });
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
    const input = await jsonBody(req, 32 * 1024 * 1024);
    if (!identifier(input.profileId)) throw fail('无效的工作台 profileId。');
    const sinceSeq = Math.max(0, Number(input.sinceSeq || 0) || 0);
    const deviceId = bounded(input.deviceId, 64) ? input.deviceId : 'dev-unknown';
    const deviceName = bounded(input.deviceName, 60) ? input.deviceName : '工作台节点';
    const incomingRecords = Array.isArray(input.records) ? input.records : [];
    const incomingTombstones = Array.isArray(input.tombstones) ? input.tombstones : [];
    if (incomingRecords.length > 50000) throw fail('单次同步记录数量超出上限。');

    const result = await transact(s => {
      s.syncSpaces ??= {};
      const space = (s.syncSpaces[input.profileId] ??= {
        profileId: input.profileId,
        cursor: 0,
        topics: [],
        folders: [],
        records: {},
        recordSeq: {},
        tombstones: {},
        devices: {}
      });

      space.devices[deviceId] = {
        deviceId,
        deviceName,
        lastSeenAt: new Date().toISOString()
      };

      if (Array.isArray(input.topics)) {
        const mergedTopics = new Set([...(space.topics || []), ...input.topics.filter(t => bounded(t, 60, true))]);
        space.topics = [...mergedTopics].slice(0, 100);
      }
      if (Array.isArray(input.folders)) {
        const byId = new Map((space.folders || []).map(f => [f.id, f]));
        for (const f of input.folders) {
          if (f && identifier(f.id) && bounded(f.name, 60, true)) byId.set(f.id, f);
        }
        space.folders = [...byId.values()].slice(0, 300);
      }

      let accepted = 0;
      for (const rec of incomingRecords) {
        if (!rec || !identifier(rec.id) || !bounded(rec.title, 240, true)) continue;
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
          delete space.records[tomb.id];
          space.cursor += 1;
          space.tombstones[tomb.id] = { id: tomb.id, deletedAt: tomb.deletedAt, seq: space.cursor, deviceId };
        }
      }

      if (accepted > 0) {
        log(s, 'owner', 'sync-delta', { profileId: input.profileId, deviceId, accepted, cursor: space.cursor });
      }

      const deltaRecords = Object.values(space.records).filter(r => (space.recordSeq[r.id] || 0) > sinceSeq);
      const deltaTombstones = Object.values(space.tombstones).filter(t => (t.seq || 0) > sinceSeq);
      return {
        protocol: PROTOCOL_VERSION,
        cursor: space.cursor,
        accepted,
        totalRecords: Object.keys(space.records).length,
        topics: space.topics,
        folders: space.folders,
        records: deltaRecords,
        tombstones: deltaTombstones
      };
    });

    reply(result);
    return true;
  }

  throw fail('未知的同步接口路径。', 404);
}
