/**
 * [INPUT]: 接收邮箱与口令，依赖 scrypt 与既有 state 事务。
 * [OUTPUT]: 提供账号注册、登录，以及设备令牌识别。
 * [POS]: 账号中转的登录层。同步正文仍走 sync-v1 密文通道。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import crypto from 'node:crypto';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,80}\.[^\s@]{1,24}$/;

function emailOf(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) return '';
  return email;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

export function createAccountApi({ fail, digest, equalHash, bounded, jsonBody, transact, getState, log }) {
  function identifyDevice(token, state) {
    if (typeof token !== 'string' || !token.startsWith('dn_')) return null;
    const hash = digest(token);
    const device = (state.accountDevices || []).find(item => !item.revoked && equalHash(item.tokenHash, hash));
    if (!device) return null;
    return { accountId: device.accountId, id: device.id, owner: false, scopes: [], account: true };
  }

  async function handle(req, route, reply) {
    if (route !== '/api/account/register' && route !== '/api/account/login') return false;
    if (req.method !== 'POST') throw fail('只接受 POST。', 405);
    const input = await jsonBody(req, 65536);
    const email = emailOf(input.email);
    const password = String(input.password || '');
    if (!email) throw fail('请输入有效邮箱。');
    if (!bounded(password, 200, true) || password.length < 8) throw fail('口令至少 8 个字符。');
    if (route === '/api/account/register') {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(password, salt);
      const account = { id: 'acct-' + crypto.randomBytes(8).toString('hex'), email, passwordSalt: salt, passwordHash, createdAt: new Date().toISOString() };
      await transact(s => {
        s.accounts ??= [];
        if (s.accounts.some(item => item.email === email)) throw fail('这个邮箱已经注册。', 409);
        s.accounts.push(account);
        log(s, 'account', 'account-created', { accountId: account.id });
      });
    }
    const state = getState();
    const account = (state.accounts || []).find(item => item.email === email);
    if (!account || !equalHash(hashPassword(password, account.passwordSalt), account.passwordHash)) {
      throw fail('邮箱或口令不正确。', 401);
    }
    const token = 'dn_' + crypto.randomBytes(32).toString('base64url');
    const device = { id: crypto.randomUUID(), accountId: account.id, tokenHash: digest(token), createdAt: new Date().toISOString(), revoked: false };
    await transact(s => {
      s.accountDevices ??= [];
      s.accountDevices.push(device);
      log(s, account.id, 'account-login', { deviceId: device.id });
    });
    reply({ ok: true, accountId: account.id, token }, 201);
    return true;
  }

  return { handle, identifyDevice };
}
