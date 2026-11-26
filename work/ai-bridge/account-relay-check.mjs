import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './server.mjs';

const dir = await mkdtemp(join(tmpdir(), 'donote-account-'));
const bridge = await createBridge({
  dataDir: dir,
  adminToken: 'test-admin-token-0123456789abcdef',
  host: '127.0.0.1',
  port: 0,
  allowedOrigins: ['http://127.0.0.1']
});
await bridge.listen();
const { port } = bridge.server.address();
const base = 'http://127.0.0.1:' + port;
try {
  const reg = await fetch(base + '/api/account/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
    body: JSON.stringify({ email: 'a@example.com', password: 'password1' })
  });
  const created = await reg.json();
  if (!reg.ok || !created.token?.startsWith('dn_')) throw new Error('register failed ' + reg.status);
  const login = await fetch(base + '/api/account/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
    body: JSON.stringify({ email: 'a@example.com', password: 'password1' })
  });
  const session = await login.json();
  if (!login.ok || session.accountId !== created.accountId) throw new Error('login failed');
  const plain = await fetch(base + '/api/sync/v1/delta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token, Origin: 'http://127.0.0.1' },
    body: JSON.stringify({ profileId: session.accountId, records: [{ id: 'n1', title: '明文' }] })
  });
  const denied = await plain.json();
  if (plain.status !== 400 || !String(denied.error).includes('密文')) throw new Error('plaintext was accepted ' + plain.status + ' ' + denied.error);
  console.log('PASS account relay login and ciphertext gate');
} finally {
  await bridge.close();
  await rm(dir, { recursive: true, force: true });
}
