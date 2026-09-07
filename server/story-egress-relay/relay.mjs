import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const HOST = process.env.SULLY_EGRESS_HOST || '127.0.0.1';
const PORT = Number(process.env.SULLY_EGRESS_PORT || 4873);
const TOKEN = String(process.env.SULLY_EGRESS_TOKEN || '');
const MAX_BODY_BYTES = Number(process.env.SULLY_EGRESS_MAX_BODY_BYTES || 2_500_000);
const REQUEST_TIMEOUT_MS = Number(process.env.SULLY_EGRESS_TIMEOUT_MS || 900_000);

if (!TOKEN) {
  console.error('[story-egress] SULLY_EGRESS_TOKEN is required');
  process.exit(1);
}

const json = (res, status, body) => {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

const sameSecret = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

const ipv4ToNumber = (value) => value.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
const inV4 = (value, network, bits) => {
  const ip = ipv4ToNumber(value);
  const base = ipv4ToNumber(network);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
};

const isBlockedIpv4 = (value) => [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].some(([network, bits]) => inV4(value, network, bits));

const isBlockedIpv6 = (value) => {
  const ip = value.toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  if (ip.startsWith('ff')) return true;
  if (ip.startsWith('2001:db8:')) return true;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
};

const assertPublicTarget = async (url) => {
  if (url.protocol !== 'https:') throw new Error('target must use https');
  if (url.username || url.password) throw new Error('target credentials are not allowed');
  if (url.hash) throw new Error('target fragment is not allowed');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('local target is not allowed');

  const literal = isIP(url.hostname);
  if (literal === 4 && isBlockedIpv4(url.hostname)) throw new Error('private/reserved target is not allowed');
  if (literal === 6 && isBlockedIpv6(url.hostname)) throw new Error('private/reserved target is not allowed');
  if (literal) return;

  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  if (!resolved.length) throw new Error('target DNS returned no address');
  for (const item of resolved) {
    if (item.family === 4 && isBlockedIpv4(item.address)) throw new Error('target DNS resolved to private/reserved IPv4');
    if (item.family === 6 && isBlockedIpv6(item.address)) throw new Error('target DNS resolved to private/reserved IPv6');
  }
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
]);

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, service: 'sullyos-story-egress', revision: 1 });
  }

  if (req.method !== 'POST' || req.url !== '/relay') {
    return json(res, 404, { ok: false, error: 'not found' });
  }

  if (!sameSecret(req.headers['x-sully-egress-token'], TOKEN)) {
    return json(res, 403, { ok: false, error: 'invalid relay token' });
  }

  const targetRaw = String(req.headers['x-sully-egress-target'] || '').trim();
  let target;
  try {
    target = new URL(targetRaw);
    await assertPublicTarget(target);
  } catch (error) {
    return json(res, 400, { ok: false, error: `invalid target: ${error?.message || error}` });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return json(res, Number(error?.statusCode || 400), { ok: false, error: error?.message || String(error) });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('relay timeout')), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(new Error('client disconnected'));
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });

  try {
    const upstreamHeaders = new Headers();
    const contentType = req.headers['content-type'];
    const authorization = req.headers.authorization;
    if (contentType) upstreamHeaders.set('Content-Type', String(contentType));
    if (authorization) upstreamHeaders.set('Authorization', String(authorization));

    const upstream = await fetch(target, {
      method: 'POST',
      headers: upstreamHeaders,
      body,
      signal: controller.signal,
      redirect: 'follow',
    });

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
    });
    responseHeaders['Cache-Control'] = responseHeaders['cache-control'] || 'no-store';

    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body).on('error', (error) => {
      console.error('[story-egress] upstream stream error', error);
      if (!res.destroyed) res.destroy(error);
    }).pipe(res);
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed) res.destroy(error);
      return;
    }
    const aborted = controller.signal.aborted;
    json(res, aborted ? 504 : 502, {
      ok: false,
      error: aborted ? 'relay aborted or timed out' : `relay fetch failed: ${error?.message || error}`,
    });
  } finally {
    clearTimeout(timeout);
    req.removeListener('aborted', abort);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;
server.listen(PORT, HOST, () => {
  console.log(`[story-egress] listening on http://${HOST}:${PORT}`);
});
