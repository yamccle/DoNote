/**
 * [INPUT]: 接收本机记录、文件夹里的记录和删除标记。
 * [OUTPUT]: 给出应读入的记录、应删除的编号、应写回的记录和应保留的删除标记。
 * [POS]: 云盘文件夹对齐的比较规则。不读写磁盘。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DoNoteFolderSyncMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function mapById(records) {
    const map = new Map();
    for (const note of records || []) {
      if (note && typeof note.id === 'string' && note.id) map.set(note.id, note);
    }
    return map;
  }

  function mapTombs(tombstones) {
    const map = new Map();
    for (const tomb of tombstones || []) {
      if (!tomb || typeof tomb.id !== 'string' || !tomb.id || typeof tomb.deletedAt !== 'string') continue;
      const prev = map.get(tomb.id);
      if (!prev || tomb.deletedAt > prev.deletedAt) map.set(tomb.id, tomb);
    }
    return map;
  }

  function isRemoteNewer(remoteRec, localRec) {
    if (!localRec) return true;
    const remoteTime = String(remoteRec.updatedAt || '');
    const localTime = String(localRec.updatedAt || '');
    if (remoteTime !== localTime) return remoteTime > localTime;
    const remoteRev = Number(remoteRec.syncMeta && remoteRec.syncMeta.rev || 0);
    const localRev = Number(localRec.syncMeta && localRec.syncMeta.rev || 0);
    if (remoteRev !== localRev) return remoteRev > localRev;
    return String(remoteRec.syncMeta && remoteRec.syncMeta.deviceId || '') > String(localRec.syncMeta && localRec.syncMeta.deviceId || '');
  }

  function tombWins(tomb, note) {
    return !!(tomb && String(tomb.deletedAt) > String(note && note.updatedAt || ''));
  }

  function incomingRecords(localRecords, remoteRecords, tombstones) {
    const local = mapById(localRecords);
    const tombs = mapTombs(tombstones);
    const apply = [];
    for (const remote of remoteRecords || []) {
      if (!remote || !remote.id) continue;
      if (tombWins(tombs.get(remote.id), remote)) continue;
      if (isRemoteNewer(remote, local.get(remote.id))) apply.push(remote);
    }
    return apply;
  }

  function incomingDeletes(localRecords, tombstones) {
    const tombs = mapTombs(tombstones);
    const ids = [];
    for (const note of localRecords || []) {
      if (note && note.id && tombWins(tombs.get(note.id), note)) ids.push(note.id);
    }
    return ids;
  }

  function outgoingRecords(localRecords, remoteRecords, tombstones) {
    const remote = mapById(remoteRecords);
    const tombs = mapTombs(tombstones);
    const push = [];
    for (const note of localRecords || []) {
      if (!note || !note.id || tombWins(tombs.get(note.id), note)) continue;
      const other = remote.get(note.id);
      if (!other || isRemoteNewer(note, other)) push.push(note);
    }
    return push;
  }

  function outgoingTombstones(tombstones, remoteRecords) {
    const remote = mapById(remoteRecords);
    const push = [];
    for (const tomb of mapTombs(tombstones).values()) {
      const other = remote.get(tomb.id);
      if (other && String(other.updatedAt || '') >= tomb.deletedAt) continue;
      push.push(tomb);
    }
    return push;
  }

  function retiredTombstoneIds(tombstones, records) {
    const notes = mapById(records);
    const ids = [];
    for (const tomb of mapTombs(tombstones).values()) {
      const note = notes.get(tomb.id);
      if (note && String(note.updatedAt || '') >= tomb.deletedAt) ids.push(tomb.id);
    }
    return ids;
  }

  function mergeFolders(localFolders, remoteFolders) {
    const byId = new Map();
    for (const folder of localFolders || []) if (folder && folder.id) byId.set(folder.id, folder);
    for (const folder of remoteFolders || []) {
      if (!folder || !folder.id) continue;
      const current = byId.get(folder.id);
      if (!current || String(folder.updatedAt || '') > String(current.updatedAt || '')) byId.set(folder.id, folder);
    }
    return [...byId.values()];
  }

  function mergeTopics(localTopics, remoteTopics, limit) {
    const cap = limit || 100;
    const seen = new Set();
    const topics = [];
    for (const tag of [...(localTopics || []), ...(remoteTopics || [])]) {
      if (typeof tag !== 'string') continue;
      const name = tag.trim();
      if (!name || name.length > 60 || seen.has(name)) continue;
      seen.add(name);
      topics.push(name);
      if (topics.length >= cap) break;
    }
    return topics;
  }

  return {
    isRemoteNewer,
    incomingRecords,
    incomingDeletes,
    outgoingRecords,
    outgoingTombstones,
    retiredTombstoneIds,
    mergeFolders,
    mergeTopics
  };
});
