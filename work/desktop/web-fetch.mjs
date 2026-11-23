import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const maxHtmlBytes = 100 * 1024 * 1024;
const maxImageBytes = 240 * 1024;
const maxStyleBytes = 90 * 1024;
const localSuffix = /(?:^|\.)(?:localhost|local|internal|lan|test|onion|invalid|home\.arpa)$/i;
const imageType = /^image\/(?:png|jpeg|gif|webp|avif)$/i;
const addressesByHost = new Map();

function publicAddress(value) {
  let url;
  try { url = new URL(value); } catch {}
  const host = url?.hostname.replace(/\.$/, '');
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.port || value.length > 2048 || !host.includes('.') || isIP(host) ||
      localSuffix.test(host)) {
    throw new Error('仅支持公开的 HTTP / HTTPS 网页地址。');
  }
  url.hash = '';
  return url;
}

function publicIp(address) {
  if (isIP(address) === 6) {
    if (!/^[23][\da-f]{3}:/i.test(address) || /^(?:2002|2001:db8|3fff):/i.test(address)) return false;
    const [first, second] = address.split(':');
    return first !== '2001' || parseInt(second || '0', 16) > 0x1ff;
  }
  const [a, b, c] = address.split('.').map(Number);
  return isIP(address) === 4 && a > 0 && a < 224 && ![10, 127].includes(a) &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99))) &&
    !(a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113);
}

async function resolvePublicAddresses(host, signal) {
  const entries = await lookup(host, { all: true });
  // Some local proxies synthesize benchmark-range addresses for every host.
  // Verify via public DNS and connect to the returned public IP, never the synthetic address.
  if (!entries.length || !entries.every(entry => /^198\.(?:18|19)\./.test(entry.address))) return entries;
  const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(4500)]);
  for (const [type, family] of [[1, 4], [28, 6]]) {
    const query = new URLSearchParams({ name: host, type: String(type), edns_client_subnet: '0.0.0.0/0' });
    const response = await fetch('https://dns.google/resolve?' + query, { redirect: 'error', signal: dnsSignal });
    if (!response.ok) break;
    const data = await response.json();
    if (data.Status !== 0 || data.TC) break;
    const resolved = (data.Answer || []).filter(record => record.type === type)
      .map(record => ({ address: record.data, family }));
    if (resolved.length) return resolved;
  }
  return [];
}

async function fetchPublic(url, kind, signal, redirects = 0) {
  let addresses = addressesByHost.get(url.hostname);
  if (!addresses) {
    addresses = resolvePublicAddresses(url.hostname, signal);
    addressesByHost.set(url.hostname, addresses);
  }
  const entries = await addresses;
  if (!entries.length || entries.some(entry => !publicIp(entry.address))) {
    throw new Error('网页解析到本机或内网地址，无法收藏。');
  }
  const chosen = entries.find(entry => entry.family === 4) ?? entries[0];
  const request = url.protocol === 'https:' ? https.request : http.request;
  const maxBytes = kind === 'page' ? maxHtmlBytes : kind === 'image' ? maxImageBytes : maxStyleBytes;
  // 许多站点（例如国内的 CSDN、部分 Cloudflare 站点）会拒绝非浏览器 UA，
  // 带上接近真实浏览器的请求头能显著降低 403 / 521 的概率。
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Accept': kind === 'page'
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      : kind === 'image' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : 'text/css,*/*;q=0.1',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': kind === 'page' ? 'document' : kind === 'image' ? 'image' : 'style',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Referer': url.origin + '/',
  };
  const options = {
    agent: false,
    autoSelectFamily: false,
    signal,
    lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
    headers: browserHeaders,
  };
  const response = await new Promise((resolve, reject) => {
    const connection = request(url, options, resolve);
    connection.once('error', reject);
    connection.end();
  });
  try {
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      if (redirects >= 5) throw new Error('网页跳转次数过多。');
      response.destroy();
      return fetchPublic(publicAddress(new URL(response.headers.location, url).href), kind, signal, redirects + 1);
    }
    if (response.statusCode !== 200) {
      const retryable = response.statusCode >= 500;
      const error = new Error('网页暂时无法读取（HTTP ' + response.statusCode + '）。');
      error.retryable = retryable;
      error.statusCode = response.statusCode;
      throw error;
    }
    const contentType = response.headers['content-type'] || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (kind === 'page' && mime === 'application/pdf') {
      throw new Error('这是一个 PDF 文件链接，请用「导入文件」把它加入资料库。');
    }
    if ((kind === 'page' && !['text/html', 'application/xhtml+xml'].includes(mime)) ||
        (kind === 'image' && !imageType.test(mime)) || (kind === 'style' && mime !== 'text/css')) {
      throw new Error('服务器没有返回支持的网页内容。');
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      throw new Error('网页服务器返回了无法处理的内容编码。');
    }
    if (Number(response.headers['content-length']) > maxBytes) throw new Error('网页内容过大。');
    let length = 0;
    const chunks = [];
    for await (const chunk of response) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('网页内容过大。');
      chunks.push(chunk);
    }
    return { url: url.href, mime, contentType, bytes: Buffer.concat(chunks, length) };
  } finally {
    response.destroy();
  }
}

function decodeText(bytes, contentType) {
  const head = bytes.subarray(0, 8192).toString('ascii');
  const encoding = /charset\s*=\s*["']?([\w.-]+)/i.exec(contentType)?.[1] ||
    /<meta\b[^>]*charset\s*=\s*["']?([\w.-]+)/i.exec(head)?.[1] || 'utf-8';
  try { return new TextDecoder(encoding).decode(bytes); } catch { return bytes.toString('utf8'); }
}

// 5xx / 连接抖动是常见瞬时问题（Cloudflare 的 521/503 尤其如此），重试几次即可。
async function fetchPageWithRetry(rawUrl, signal) {
  let lastError;
  const delays = [0, 450, 1100];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    if (signal.aborted) break;
    try {
      return await fetchPublic(publicAddress(rawUrl), 'page', signal);
    } catch (error) {
      lastError = error;
      const transient = error.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'].includes(error.code);
      if (!transient) break;
    }
  }
  throw lastError;
}

async function run(input) {
  if (input.kind !== 'assets') {
    const result = await fetchPageWithRetry(input.url, AbortSignal.timeout(22000));
    return { url: result.url, html: decodeText(result.bytes, result.contentType) };
  }
  const signal = AbortSignal.timeout(18000);
  const assets = {};
  const requested = input.assets.slice(0, 27);
  for (let index = 0; index < requested.length; index += 6) {
    if (signal.aborted) break;
    await Promise.all(requested.slice(index, index + 6).map(async asset => {
      if (asset.kind !== 'image' && asset.kind !== 'style') return;
      try {
        const result = await fetchPublic(publicAddress(asset.url), asset.kind, signal);
        assets[asset.url] = asset.kind === 'image'
          ? 'data:' + result.mime + ';base64,' + result.bytes.toString('base64')
          : decodeText(result.bytes, result.contentType);
      } catch {}
    }));
  }
  return { assets };
}

let input;
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 32000) throw new Error('网页请求过大。');
    chunks.push(chunk);
  }
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = await run(input);
  process.stdout.write(JSON.stringify({ type: 'yams-one-web-capture', id: input.id, ...result }));
} catch (error) {
  const blocked = /HTTP (?:403|429|503|521|522|523)/.exec(error.message || '');
  const message = ['AbortError', 'TimeoutError'].includes(error.name)
    ? '读取网页超时，站点可能较慢，请稍后重试。'
    : blocked
      ? '站点拒绝了自动抓取（' + blocked[0] + '），通常是防爬或需要登录。可以稍后重试，或在浏览器打开后复制正文。'
      : /[\u4e00-\u9fff]/u.test(error.message) ? error.message : '无法读取此网页，请检查网络及网页访问权限。';
  process.stdout.write(JSON.stringify({ type: 'yams-one-web-capture', id: input?.id, error: message }));
}
