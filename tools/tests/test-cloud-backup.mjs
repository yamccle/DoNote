/**
 * [INPUT]: 读取桌面云备份传输源码。
 * [OUTPUT]: 验证 WebDAV 和网盘同步文件夹的快照往返与失败保护。
 * [POS]: 仅访问回环 WebDAV 和独立临时目录。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../../work/desktop/', import.meta.url));
const probeSource = fileURLToPath(new URL('./CloudBackupProbe.cs', import.meta.url));
const csc = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const authorization = 'Basic ' + Buffer.from('qa-user:qa-password').toString('base64');
const payload = Buffer.alloc(4 * 1024 * 1024 + 71);
for (let offset = 0; offset < payload.length; offset++) payload[offset] = (offset * 17) % 251;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const xml = value => value.replace(/[<>&]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char]);
const toHref = path => path.split('/').map(segment =>
  encodeURIComponent(segment).replace(/%[0-9A-F]{2}/g, code => code.toLowerCase())).join('/');
const parentPath = path => path.replace(/\/$/, '').replace(/[^/]+$/, '');

function run(executable, args, { accepted = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    const timeout = setTimeout(() => child.kill(), 45_000);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal || (accepted ? code !== 0 : code === 0)) {
        reject(new Error(`测试程序退出状态不符（${code ?? signal}）\n${stdout}${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

function davFixture() {
  const files = new Map();
  const directories = new Set(['/dav/', '/dav/我的备份/']);
  const log = [];
  const faults = new Map();
  let redirectHits = 0;
  const server = createServer(async (request, response) => {
    try {
      const method = request.method;
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      log.push({ method, path });
      if (path === '/redirect-sink') {
        redirectHits++;
        response.writeHead(200).end('unexpected redirect');
        return;
      }
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DoNote test"' }).end();
        return;
      }
      const fault = faults.get(method);
      if (fault?.(path, response)) return;
      const directory = path.endsWith('/') ? path : path + '/';
      if (method === 'MKCOL') {
        if (directories.has(directory)) return response.writeHead(405).end();
        if (!directories.has(parentPath(directory))) return response.writeHead(409).end();
        directories.add(directory);
        response.writeHead(201).end();
      } else if (method === 'PROPFIND') {
        const findDirectory = directories.has(directory);
        if (!findDirectory && !files.has(path)) return response.writeHead(404).end();
        const base = findDirectory ? directory : path;
        const children = findDirectory && request.headers.depth !== '0'
          ? [...directories, ...files.keys()].filter(item => item !== directory && parentPath(item) === directory)
          : [];
        const rows = [base, ...children].map(item => {
          const collection = directories.has(item);
          const properties = collection ? '<d:collection/>' : '';
          const length = collection ? 0 : files.get(item).length;
          return `<d:response><d:href>${xml(toHref(item))}</d:href><d:propstat><d:prop><d:resourcetype>${properties}</d:resourcetype><d:getcontentlength>${length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        });
        response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1, 2' });
        response.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' + rows.join('') + '</d:multistatus>');
      } else if (method === 'PUT') {
        if (!directories.has(parentPath(path))) return response.writeHead(409).end();
        if (request.headers['if-none-match'] === '*' && files.has(path)) return response.writeHead(412).end();
        const parts = [];
        for await (const part of request) parts.push(part);
        const existed = files.has(path);
        files.set(path, Buffer.concat(parts));
        response.writeHead(existed ? 204 : 201).end();
      } else if (method === 'GET' || method === 'HEAD') {
        const content = files.get(path);
        if (!content) return response.writeHead(404).end();
        response.writeHead(200, { 'Content-Length': content.length, 'Content-Type': 'application/octet-stream' });
        response.end(method === 'HEAD' ? undefined : content);
      } else if (method === 'DELETE') {
        const found = files.delete(path) || directories.delete(directory);
        if (!found) return response.writeHead(404).end();
        for (const candidate of [...files.keys()]) if (candidate.startsWith(directory)) files.delete(candidate);
        for (const candidate of [...directories]) if (candidate.startsWith(directory)) directories.delete(candidate);
        response.writeHead(204).end();
      } else if (method === 'OPTIONS') {
        response.writeHead(200, { DAV: '1, 2', Allow: 'OPTIONS, PROPFIND, MKCOL, GET, HEAD, PUT, DELETE' }).end();
      } else {
        response.writeHead(405).end();
      }
    } catch (error) {
      response.destroy(error);
    }
  });
  return { server, files, directories, log, faults, redirectHits: () => redirectHits };
}

async function removeTestFolder(directory, parent) {
  const resolved = await realpath(directory);
  assert.equal(dirname(resolved), parent);
  assert.ok(basename(resolved).startsWith('donote-cloud-test-'));
  await rm(resolved, { recursive: true, force: true });
}

const names = {
  folders: 'DoNote-20261124T090001Z-a1b2c3d4',
  dav: 'DoNote-20261124T090002Z-aabbccdd',
  second: 'DoNote-20261124T090003Z-11223344',
  third: 'DoNote-20261124T090007Z-33445566',
  fourth: 'DoNote-20261124T090008Z-77889900',
  partial: 'DoNote-20261124T090004Z-abcdef12',
  cancelled: 'DoNote-20261124T090005Z-deadbeef',
  markerOnly: 'DoNote-20261124T090006Z-5555abcd'
};
const attachmentPath = '资料/测试资料/选区样本.bin';
const manifest = Buffer.from(JSON.stringify({
  format: 'analog-notes', version: 2, exportedAt: '2026-11-24T09:00:00Z',
  profile: { name: '投递测试', role: '', topics: [] },
  records: [{
    id: 'sample', date: '2026-11-24', body: '记录内容', title: '测试样本', type: 'resource',
    status: '待读', tags: [], pinned: false,
    attachments: [{
      id: 'sample-file', name: '选区样本.bin', path: attachmentPath,
      mime: 'application/octet-stream', size: payload.length, sha256: digest(payload)
    }]
  }]
}));

async function assertRestored(directory, name) {
  assert.deepEqual(await readFile(join(directory, name, 'backup.json')), manifest);
  assert.equal(digest(await readFile(join(directory, name, attachmentPath))), digest(payload));
}

function assertCommitMarker(archive, marker) {
  assert.ok(Buffer.isBuffer(archive) && archive.length > 0, '需要已发布 ZIP');
  const data = JSON.parse(marker.toString('utf8'));
  assert.equal(data.size, archive.length);
  assert.equal(data.sha256.toLowerCase(), digest(archive));
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

const parent = await realpath(tmpdir());
const directory = await mkdtemp(join(parent, 'donote-cloud-test-'));
const local = join(directory, 'sync-folder');
const source = join(directory, 'staged');
const restored = join(directory, 'restored');
const failedRestore = join(directory, 'failed-restore');
const fixture = davFixture();
const probe = join(directory, 'CloudBackupProbe.exe');
const listNames = output => output ? output.split(/\r?\n/).sort() : [];
try {
  await Promise.all([
    mkdir(local), mkdir(dirname(join(source, attachmentPath)), { recursive: true }),
    mkdir(restored), mkdir(failedRestore)
  ]);
  await Promise.all([
    writeFile(join(source, 'backup.json'), manifest),
    writeFile(join(source, attachmentPath), payload)
  ]);
  await run(csc, [
    '/nologo', '/target:exe', '/platform:x64', '/codepage:65001', '/out:' + probe,
    '/reference:System.Net.Http.dll', '/reference:System.Web.Extensions.dll',
    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    join(desktop, 'CloudBackupTransport.cs'), join(desktop, 'UpdatePackage.cs'), probeSource
  ]);
  const folder = (operation, name = '', path = source, accepted = true) =>
    run(probe, ['folder', operation, local, '', name, path], { accepted });
  const origin = await listen(fixture.server);
  const davBase = '/dav/我的备份/';
  const endpoint = origin + davBase;
  const dav = (operation, name = '', path = source, accepted = true, password = 'qa-password') =>
    run(probe, ['webdav', operation, endpoint, password, name, path], { accepted });
  const localZip = join(local, names.folders + '.zip');
  const localMarker = join(local, names.folders + '.complete.json');

  await folder('upload', names.folders);
  const folderArchive = await readFile(localZip);
  const folderMarker = await readFile(localMarker);
  assertCommitMarker(folderArchive, folderMarker);
  await folder('upload', names.folders, source, false);
  assert.deepEqual(await readFile(localZip), folderArchive);
  assert.deepEqual(await readFile(localMarker), folderMarker);
  await writeFile(join(local, names.partial + '.zip'), folderArchive);
  await writeFile(join(local, names.markerOnly + '.complete.json'), folderMarker);
  assert.deepEqual(listNames(await folder('list')), [names.folders]);
  await folder('download', names.folders, restored);
  await assertRestored(restored, names.folders);
  await folder('upload', names.partial, source, false);
  await folder('download', names.partial, failedRestore, false);
  await folder('download', names.markerOnly, failedRestore, false);
  assert.deepEqual(await readdir(failedRestore), []);
  await writeFile(join(local, 'keep-my-note.txt'), 'unrelated user file');
  await folder('upload', names.third);
  await folder('upload', names.fourth);
  assert.equal(await folder('prune', '2'), '1');
  assert.deepEqual(listNames(await folder('list')), [names.fourth, names.third].sort());
  assert.equal(await readFile(join(local, 'keep-my-note.txt'), 'utf8'), 'unrelated user file');
  console.log('PASS 网盘同步文件夹：快照与附件逐字节恢复，保留份数自动清理旧快照且不触碰无关文件，未完成快照不可选。');

  await dav('upload', names.dav);
  const remoteZipPath = davBase + names.dav + '.zip';
  const remoteMarkerPath = davBase + names.dav + '.complete.json';
  const remoteArchive = fixture.files.get(remoteZipPath);
  const remoteMarker = fixture.files.get(remoteMarkerPath);
  assertCommitMarker(remoteArchive, remoteMarker);
  const puts = fixture.log.filter(item => item.method === 'PUT').map(item => item.path);
  assert.ok(puts.indexOf(remoteZipPath) >= 0);
  assert.ok(puts.indexOf(remoteZipPath) < puts.indexOf(remoteMarkerPath), '必须在 ZIP 上传成功后提交标记');
  await dav('upload', names.second);
  await dav('upload', names.dav, source, false);
  assert.deepEqual(fixture.files.get(remoteZipPath), remoteArchive);
  assert.deepEqual(fixture.files.get(remoteMarkerPath), remoteMarker);
  assert.deepEqual(listNames(await dav('list')), [names.dav, names.second]);
  await dav('download', names.dav, restored);
  await assertRestored(restored, names.dav);
  fixture.files.set(davBase + 'unrelated.txt', Buffer.from('keep'));
  await dav('upload', names.third);
  await dav('upload', names.fourth);
  const logStart = fixture.log.length;
  assert.equal(await dav('prune', '2'), '2');
  assert.deepEqual(listNames(await dav('list')), [names.fourth, names.third].sort());
  assert.ok(fixture.files.has(davBase + 'unrelated.txt'));
  const deletes = fixture.log.slice(logStart).filter(item => item.method === 'DELETE').map(item => item.path);
  assert.ok(deletes.indexOf(davBase + names.dav + '.complete.json') < deletes.indexOf(davBase + names.dav + '.zip'), 'WebDAV 清理旧快照必须先删除完成标记再删除 ZIP');
  await dav('upload', names.dav);
  const republishedArchive = fixture.files.get(remoteZipPath);
  console.log('PASS WebDAV：认证、提交标记顺序、多版本列表、先删标记后删归档的保留份数清理和快照逐字节往返。');

  fixture.faults.set('PUT', (path, response) => {
    if (path !== davBase + names.partial + '.complete.json') return false;
    response.writeHead(507).end();
    return true;
  });
  await dav('upload', names.partial, source, false);
  fixture.faults.delete('PUT');
  assert.ok(!fixture.files.has(davBase + names.partial + '.complete.json'));
  fixture.files.set(davBase + names.partial + '.zip', republishedArchive);
  fixture.files.set(davBase + names.markerOnly + '.complete.json', remoteMarker);
  assert.deepEqual(listNames(await dav('list')), [names.dav, names.fourth, names.third].sort());
  await dav('cancel-upload', names.cancelled, source, false);
  assert.ok(!fixture.files.has(davBase + names.cancelled + '.complete.json'));

  const damaged = Buffer.from(republishedArchive);
  damaged[damaged.length - 3] ^= 1;
  fixture.files.set(remoteZipPath, damaged);
  await dav('download', names.dav, failedRestore, false);
  assert.deepEqual(await readdir(failedRestore), []);
  fixture.files.set(remoteZipPath, republishedArchive);
  await dav('list', '', source, false, 'incorrect');

  fixture.faults.set('PROPFIND', (path, response) => {
    response.writeHead(302, { Location: origin + '/redirect-sink' }).end();
    return true;
  });
  await dav('list', '', source, false);
  assert.equal(fixture.redirectHits(), 0);
  console.log('PASS WebDAV：失败和取消不可发布，校验失败不留下恢复目录，拒绝错误凭证和重定向。');
} finally {
  await closeServer(fixture.server);
  await removeTestFolder(directory, parent);
}
