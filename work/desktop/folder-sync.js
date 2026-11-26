/**
 * [INPUT]: 读取本机记录、删除标记、批注，以及宿主列出的云盘同步文件夹。
 * [OUTPUT]: 按更新时间合并记录目录，并把本机已有的附件写回文件夹。打开某一份时再读取那一份。
 * [POS]: 设置页「云盘文件夹」。云盘客户端负责外网传输，不使用网址和令牌。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
 const merge = window.DoNoteFolderSyncMerge;
 const host = location.origin === 'https://yams-one.example' ? window.chrome?.webview : null;
 const pending = new Map();
 const SEEN_KEY = 'donote-folder-sync-seen';
 const TEXT_LIMIT = 700000;
 const CHUNK = 480 * 1024;
 let folderPath = '';
 let aligning = false;
 let again = false;
 let timer = 0;
 let seen = loadSeen();

 function loadSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); }
  catch { return {}; }
 }
 function saveSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
 }
 function resetSeen(folder) {
  seen = { folder, records: {}, tombs: {}, anns: {} };
  saveSeen();
 }
 function setStatus(text) {
  const status = document.getElementById('settingsFolderSyncStatus');
  if (status && text) status.textContent = text;
 }
 function request(action, parameters) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
   const timerId = setTimeout(() => { pending.delete(id); reject(new Error('同步文件夹没有响应。')); }, 180000);
   pending.set(id, { timerId, resolve, reject });
   host.postMessage(Object.assign({ type: 'folder-sync', id, action }, parameters || {}));
  });
 }
 function base64(bytes) {
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(raw);
 }
 function bytesFromBase64(value) {
  const raw = atob(value || '');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
 }
 async function listAll() {
  const files = [];
  let cursor = 0;
  let conflicts = false;
  for (;;) {
   const page = await request('list', { cursor });
   if (page.conflicts) conflicts = true;
   for (const file of page.files || []) files.push(file);
   if (page.next == null || page.next < 0) break;
   cursor = page.next;
  }
  return { files, conflicts };
 }
 function indexFiles(files) {
  const records = new Map();
  const tombs = new Map();
  const anns = new Map();
  const blobs = new Map();
  let library = null;
  for (const file of files) {
   if (file.kind === 'record') records.set(file.name, file);
   else if (file.kind === 'tombstone') tombs.set(file.name, file);
   else if (file.kind === 'annotation') anns.set(file.name, file);
   else if (file.kind === 'blob') blobs.set(String(file.name).toLowerCase(), Number(file.bytes));
   else if (file.kind === 'library') library = file;
  }
  return { records, tombs, anns, blobs, library };
 }
 async function cancelTransfer() {
  await request('cancel').catch(() => {});
 }
 async function writeText(kind, name, text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= TEXT_LIMIT) {
   await request('write', { kind, name, body: text });
   return;
  }
  await writeBytes(kind, name, bytes);
 }
 async function writeBytes(kind, name, bytes) {
  await request('put-start', { kind, name, size: bytes.length });
  try {
   for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK, seq++) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK));
    await request('put-chunk', { seq, data: base64(slice) });
   }
   await request('put-finish');
  } catch (error) {
   await cancelTransfer();
   throw error;
  }
 }
 async function readText(kind, name, bytes) {
  if (!bytes) {
   const small = await request('read', { kind, name });
   return small.body || '';
  }
  if (bytes <= TEXT_LIMIT) {
   const small = await request('read', { kind, name });
   return small.body || '';
  }
  return new TextDecoder().decode(await readBytes(kind, name));
 }
 async function readBytes(kind, name) {
  const started = await request('get-start', { kind, name });
  if (!started.size) {
   await cancelTransfer();
   return new Uint8Array();
  }
  const parts = [];
  try {
   for (let seq = 0, done = false; !done; seq++) {
    const chunk = await request('get-chunk', { seq });
    if (chunk.data) parts.push(bytesFromBase64(chunk.data));
    done = chunk.done;
   }
  } catch (error) {
   await cancelTransfer();
   throw error;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
 }
 function attachmentStamp(note) {
  return (note.attachments || []).map(item => item.id + ':' + String(item.sha256 || '')).sort().join('|');
 }
 function stubRecord(id, hit) {
  return { id, updatedAt: hit.updatedAt || '', syncMeta: { rev: hit.rev || 0, deviceId: hit.deviceId || '' } };
 }
 async function readChanged(kind, listed, bucket) {
  const fresh = new Map();
  const all = [];
  for (const [name, file] of listed) {
   const hit = bucket[name];
   if (hit && hit.mtime === file.mtime) {
    all.push(kind === 'tombstone' ? { id: name, deletedAt: hit.deletedAt } : stubRecord(name, hit));
    continue;
   }
   const text = await readText(kind, name, Number(file.bytes));
   if (!text) continue;
   let parsed;
   try { parsed = JSON.parse(text); }
   catch { continue; }
   if (!parsed || typeof parsed !== 'object') continue;
   if (kind === 'tombstone') parsed = { id: name, deletedAt: parsed.deletedAt };
   else {
    if (!parsed.id) parsed.id = name;
    if (kind === 'annotation' && !parsed.fileId) parsed.fileId = name;
   }
   fresh.set(name, parsed);
   all.push(parsed);
  }
  return { fresh, all };
 }
 async function localBlob(id, profileId) {
  const tx = database.transaction('files');
  const value = await reqResult(tx.objectStore('files').get(fileKey(profileId, id)));
  if (!(value instanceof Blob)) throw new Error('missing');
  return value;
 }
 async function pushBlob(att, blobs, profileId) {
  const sha = String(att.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return false;
  const listed = blobs.get(sha);
  if (listed != null && Number(att.size) === listed) return true;
  let blob;
  try { blob = await localBlob(att.id, profileId); }
  catch { return false; }
  if ((await fileDigest(blob)) !== sha) return false;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeBytes('blob', sha, bytes);
  blobs.set(sha, bytes.length);
  return true;
 }
 async function alignOnce() {
  if (typeof ready === 'undefined' || !ready || !appState) return;
  const profile = activeProfile();
  if (!profile) return;
  setStatus('正在对齐同步文件夹…');
  if (window.DoNoteSync?.ensureAttachmentHashes) await window.DoNoteSync.ensureAttachmentHashes();
  const listedRaw = await listAll();
  const listed = indexFiles(listedRaw.files);
  seen.records = seen.records || {};
  seen.tombs = seen.tombs || {};
  seen.anns = seen.anns || {};
  const remoteNotes = await readChanged('record', listed.records, seen.records);
  const remoteTombs = await readChanged('tombstone', listed.tombs, seen.tombs);
  const localTombs = window.DoNoteSync?.readTombstones?.(profile.id) || [];
  const tombstones = remoteTombs.all.concat(localTombs);
  const localRecords = profile.records || [];
  const apply = [];
  for (const note of merge.incomingRecords(localRecords, [...remoteNotes.fresh.values()], tombstones)) {
   if (typeof validate === 'function' && !validate(note)) continue;
   apply.push(structuredClone(note));
  }
  const removeIds = new Set(merge.incomingDeletes(localRecords, tombstones));
  const next = structuredClone(appState);
  const target = next.profiles.find(item => item.id === next.activeId);
  let remoteLibrary = null;
  if (listed.library) {
   const libraryText = await readText('library', '', Number(listed.library.bytes));
   if (libraryText) {
    try { remoteLibrary = JSON.parse(libraryText); }
    catch { remoteLibrary = null; }
   }
  }
  if (remoteLibrary) {
   const folders = merge.mergeFolders(target.folders, remoteLibrary.folders);
   if (typeof validRecordFolders !== 'function' || validRecordFolders(folders)) target.folders = folders;
   target.topics = merge.mergeTopics(target.topics, remoteLibrary.topics, typeof MAX_TOPICS === 'number' ? MAX_TOPICS : 100);
  }
  const libraryBody = JSON.stringify({ version: 1, folders: target.folders || [], topics: target.topics || [] });
  const remoteLibraryBody = JSON.stringify({ version: 1, folders: remoteLibrary?.folders || [], topics: remoteLibrary?.topics || [] });
  if (apply.length || removeIds.size || libraryBody !== remoteLibraryBody) {
   const byId = new Map(target.records.map(note => [note.id, note]));
   for (const id of removeIds) byId.delete(id);
   for (const note of apply) byId.set(note.id, note);
   target.records = [...byId.values()];
   await commitState(next);
   if (typeof render === 'function') render();
  }
  const current = activeProfile();
  const pushed = merge.outgoingRecords(current.records, remoteNotes.all, tombstones);
  const extra = current.records.filter(note => {
   const hit = seen.records[note.id];
   return hit && hit.hashes && hit.hashes !== attachmentStamp(note) && !pushed.some(item => item.id === note.id) && !merge.isRemoteNewer(stubRecord(note.id, hit), note);
  });
  const writtenIds = new Set();
  let wrote = 0;
  for (const note of pushed.concat(extra)) {
   for (const att of note.attachments || []) {
    if (!att.sha256) continue;
    await pushBlob(att, listed.blobs, current.id);
   }
   await writeText('record', note.id, JSON.stringify(note));
   seen.records[note.id] = {
    mtime: '',
    updatedAt: note.updatedAt || '',
    rev: note.syncMeta?.rev || 0,
    deviceId: note.syncMeta?.deviceId || '',
    hashes: attachmentStamp(note)
   };
   writtenIds.add(note.id);
   wrote++;
  }
  for (const tomb of merge.outgoingTombstones(tombstones, remoteNotes.all)) {
   await writeText('tombstone', tomb.id, JSON.stringify(tomb));
   if (listed.records.has(tomb.id)) await request('remove', { kind: 'record', name: tomb.id });
   seen.tombs[tomb.id] = { mtime: '', deletedAt: tomb.deletedAt };
  }
  for (const id of merge.retiredTombstoneIds(tombstones, current.records)) {
   if (listed.tombs.has(id)) await request('remove', { kind: 'tombstone', name: id });
   delete seen.tombs[id];
  }
  await alignAnnotations(listed, current);
  const currentLibrary = JSON.stringify({ version: 1, folders: current.folders || [], topics: current.topics || [] });
  if (currentLibrary !== remoteLibraryBody) await writeText('library', '', currentLibrary);
  for (const [name, file] of listed.records) {
   if (writtenIds.has(name)) continue;
   const fresh = remoteNotes.fresh.get(name);
   if (fresh) {
    seen.records[name] = {
     mtime: file.mtime,
     updatedAt: fresh.updatedAt || '',
     rev: fresh.syncMeta?.rev || 0,
     deviceId: fresh.syncMeta?.deviceId || '',
     hashes: attachmentStamp(fresh)
    };
   }
  }
  for (const [name, file] of listed.tombs) {
   const fresh = remoteTombs.fresh.get(name);
   if (fresh) seen.tombs[name] = { mtime: file.mtime, deletedAt: fresh.deletedAt };
  }
  saveSeen();
  const conflictText = listedRaw.conflicts ? ' 云盘留下了冲突副本，请在同步文件夹里处理。' : '';
  setStatus('已对齐目录。读入 ' + apply.length + ' 条，写出 ' + wrote + ' 条。附件在打开时再加载。' + conflictText);
 }
 async function alignAnnotations(listed, profile) {
  const bundles = await window.DoNoteSync?.collectAnnotationBundles?.(profile) || [];
  const remote = await readChanged('annotation', listed.anns, seen.anns);
  for (const bundle of remote.fresh.values()) {
   if (!bundle?.fileId || !window.DoNoteSyncCrypto?.mergeAnnotationBundle) continue;
   try { await localBlob(bundle.fileId, profile.id); }
   catch { continue; }
   await mergeAnnotationFile(bundle.fileId, profile.id, bundle);
   const file = listed.anns.get(bundle.fileId);
   if (file) seen.anns[bundle.fileId] = { mtime: file.mtime, updatedAt: bundle.updatedAt || '' };
  }
  for (const bundle of bundles) {
   const hit = seen.anns[bundle.fileId];
   if (hit && String(hit.updatedAt || '') >= String(bundle.updatedAt || '')) continue;
   await writeText('annotation', bundle.fileId, JSON.stringify(bundle));
   seen.anns[bundle.fileId] = { mtime: '', updatedAt: bundle.updatedAt || '' };
  }
 }
 async function mergeAnnotationFile(fileId, profileId, bundle) {
  if (!bundle || !window.DoNoteSyncCrypto?.mergeAnnotationBundle) return;
  let marks = [];
  try {
   const raw = await reqResult(database.transaction('workspace').objectStore('workspace').get(annotationKey(profileId, fileId)));
   marks = Array.isArray(raw) ? checkedAnnotations(raw) : [];
  } catch { marks = []; }
  const localTombs = window.DoNoteSyncCrypto.readMarkTombstones(profileId, fileId);
  const merged = window.DoNoteSyncCrypto.mergeAnnotationBundle(
   { marks, tombstones: localTombs },
   { marks: bundle.marks || [], tombstones: bundle.tombstones || [] }
  );
  window.DoNoteSyncCrypto.writeMarkTombstones(profileId, fileId, merged.tombstones);
  if (merged.localChanged) await putWorkspaceForFile(profileId, fileId, annotationKey(profileId, fileId), checkedAnnotations(merged.marks));
 }
 function findAttachment(id, profileId) {
  const profile = (appState?.profiles || []).find(item => item.id === profileId) || activeProfile();
  if (!profile) return null;
  for (const note of profile.records || []) {
   const att = (note.attachments || []).find(item => item.id === id);
   if (att) return att;
  }
  return null;
 }
 let loadChain = Promise.resolve();
 async function loadAttachment(id, profileId) {
  const run = loadChain.then(() => loadOneAttachment(id, profileId));
  loadChain = run.catch(() => {});
  return run;
 }
 async function loadOneAttachment(id, profileId) {
  if (!folderPath) return null;
  const att = findAttachment(id, profileId);
  if (!att) return null;
  const name = att.name || '这份附件';
  const sha = String(att.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('「' + name + '」还没有内容指纹，无法从同步文件夹读取。');
  let bytes;
  try { bytes = await readBytes('blob', sha); }
  catch (error) {
   if (/不存在|无法读写|没有响应/.test(error.message || '')) throw new Error('同步文件夹里还没有「' + name + '」。请等云盘客户端把这一份传到本机后再打开。');
   throw error;
  }
  const blob = new Blob([bytes], { type: att.mime || 'application/octet-stream' });
  if ((await fileDigest(blob)) !== sha) throw new Error('同步附件校验不一致：' + name);
  const tx = database.transaction('files', 'readwrite');
  tx.objectStore('files').put(blob, fileKey(profileId, id));
  await transactionDone(tx);
  try {
   const text = await readText('annotation', id, 1);
   if (text) await mergeAnnotationFile(id, profileId, JSON.parse(text));
  } catch { /* 批注还没到，不挡住这一份正文 */ }
  return blob;
 }
 async function align() {
  if (!host || !folderPath) return;
  if (aligning) { again = true; return; }
  aligning = true;
  const run = document.getElementById('settingsFolderSyncNow');
  if (run) run.disabled = true;
  try {
   do { again = false; await alignOnce(); }
   while (again);
  } catch (error) {
   setStatus(error.message || '文件夹对齐未完成。');
  } finally {
   aligning = false;
   if (run) run.disabled = false;
  }
 }
 function schedule() {
  if (!folderPath) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void align(); }, 1200);
 }
 if (host && merge) {
  host.addEventListener('message', event => {
   const data = event.data;
   if (!data || data.type === 'folder-sync-changed') {
    if (data?.type === 'folder-sync-changed') schedule();
    return;
   }
   if (data.type !== 'folder-sync-result') return;
   const entry = pending.get(data.id);
   if (!entry) return;
   clearTimeout(entry.timerId);
   pending.delete(data.id);
   if (data.error) entry.reject(new Error(data.error));
   else entry.resolve(data);
  });
  const choose = document.getElementById('settingsFolderSyncChoose');
  const run = document.getElementById('settingsFolderSyncNow');
  const path = document.getElementById('settingsFolderSyncPath');
  if (choose) choose.onclick = async () => {
   try {
    const result = await request('choose');
    if (result.cancelled) { setStatus('未选择文件夹。'); return; }
    folderPath = result.folder || '';
    if (path) path.value = folderPath;
    resetSeen(folderPath);
    setStatus('已记住这个同步文件夹。');
    schedule();
   } catch (error) { setStatus(error.message); }
  };
  if (run) run.onclick = () => { void align(); };
  request('status').then(result => {
   folderPath = result.folder || '';
   if (path && folderPath) path.value = folderPath;
   if (seen.folder && seen.folder !== folderPath) resetSeen(folderPath);
   if (folderPath) schedule();
  }).catch(() => {});
  document.addEventListener('workspace-records-changed', () => { if (!aligning) schedule(); });
  window.DoNoteFolderSync = { isAligning: () => aligning, loadAttachment };
 }
}
