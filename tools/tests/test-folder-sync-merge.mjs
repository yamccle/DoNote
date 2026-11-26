import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merge = require('../../work/desktop/folder-sync-merge.js');

const local = { id: 'a', updatedAt: '2026-11-01T00:00:00.000Z', syncMeta: { rev: 1, deviceId: 'local' }, title: '旧' };
const remote = { id: 'a', updatedAt: '2026-11-02T00:00:00.000Z', syncMeta: { rev: 1, deviceId: 'other' }, title: '新' };
assert.equal(merge.incomingRecords([local], [remote], []).length, 1);
assert.equal(merge.outgoingRecords([local], [remote], []).length, 0);

assert.equal(merge.outgoingRecords([remote], [local], []).length, 1);
assert.equal(merge.isRemoteNewer(
  { updatedAt: '2026-11-02T00:00:00.000Z', syncMeta: { rev: 2, deviceId: 'b' } },
  { updatedAt: '2026-11-02T00:00:00.000Z', syncMeta: { rev: 1, deviceId: 'a' } }
), true);
assert.equal(merge.isRemoteNewer(
  { updatedAt: '2026-11-02T00:00:00.000Z', syncMeta: { rev: 1, deviceId: 'b' } },
  { updatedAt: '2026-11-02T00:00:00.000Z', syncMeta: { rev: 1, deviceId: 'a' } }
), true);

const tomb = { id: 'a', deletedAt: '2026-11-03T00:00:00.000Z' };
assert.deepEqual(merge.incomingDeletes([remote], [tomb]), ['a']);
assert.equal(merge.incomingRecords([local], [remote], [tomb]).length, 0);
assert.equal(merge.outgoingTombstones([tomb], [remote]).length, 1);
assert.equal(merge.outgoingTombstones([tomb], [{ id: 'a', updatedAt: '2026-11-04T00:00:00.000Z' }]).length, 0);
assert.deepEqual(merge.retiredTombstoneIds([tomb], [{ id: 'a', updatedAt: '2026-11-04T00:00:00.000Z' }]), ['a']);

const folders = merge.mergeFolders(
  [{ id: 'f1', name: '旧', updatedAt: '2026-11-01T00:00:00.000Z' }],
  [{ id: 'f1', name: '新', updatedAt: '2026-11-02T00:00:00.000Z' }, { id: 'f2', name: '增' }]
);
assert.equal(folders.find(folder => folder.id === 'f1').name, '新');
assert.equal(folders.some(folder => folder.id === 'f2'), true);
assert.deepEqual(merge.mergeTopics(['文献'], ['文献', '方法'], 100), ['文献', '方法']);

console.log('PASS folder sync merge');
