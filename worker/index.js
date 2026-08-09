const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1";
const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const XHS_BASE = "https://edith.xiaohongshu.com";
const XHS_MEDIA_HOST_CANDIDATES = [
  "https://edith.xiaohongshu.com",
  "https://creator.xiaohongshu.com",
  "https://www.xiaohongshu.com",
];
const XHS_PUBLISH_HOST_CANDIDATES = [
  "https://edith.xiaohongshu.com",
  "https://www.xiaohongshu.com",
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Depth, X-Brave-API-Key, X-Notion-API-Key, X-Feishu-Token, X-Xhs-Cookie, X-Rnote-API-Key, X-Xhs-Experiment-Ack, X-Netease-Cookie, X-WebDAV-Method, X-WebDAV-Depth, X-WebDAV-Range, X-GitHub-Method, X-GitHub-Api-Version, X-CF-Method, Mcp-Session-Id, Accept, Range",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(obj, { status = 200, origin } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

// ---- /fetch-webpage 用: SSRF 防护 + body 大小上限 ----
// 网页分享代理只抓用户粘贴的公网网页, 拒绝 loopback / 私有网段 / link-local / 内网后缀。
function isUnsafeFetchTarget(parsed) {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  // IPv6 唯一本地 (fc00::/7) / link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  return false;
}

// 读 Response body, 累加到 maxBytes 就停 (防超大页面打爆 worker)。
async function readBodyCapped(res, maxBytes) {
  const reader = (res.body && res.body.getReader) ? res.body.getReader() : null;
  if (!reader) return await res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      chunks.push(value);
      if (total >= maxBytes) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c.subarray(0, total - offset), offset); offset += c.length; }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function route(url) {
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "" || p === "/") return { kind: "web" };
  if (p === "/search") return { kind: "web" };
  if (p === "/news") return { kind: "news" };
  if (p === "/videos") return { kind: "videos" };
  if (p === "/images") return { kind: "images" };
  return null;
}

// ================================================================
//  小红书签名 — 基于 xhshow 逆向的真实算法
//  参考: https://github.com/Cloxl/xhshow
// ================================================================

// ---------- Pure-JS MD5 (RFC 1321) ----------
function md5(string) {
  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);   d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);  b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);      b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);   d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);   b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);  b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);     d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);   b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);  d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);   b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);       d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);  b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);   d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);   b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);   b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);   b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);   d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);  b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

  const encoder = new TextEncoder();
  const bytes = encoder.encode(string);
  let n = bytes.length;
  let tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let i;
  for (i = 0; i < n; i++) tail[i >> 2] |= bytes[i] << ((i % 4) << 3);
  // We need to handle longer strings properly
  let state = [1732584193, -271733879, -1732584194, 271733878];
  let nBlocks = ((n + 8) >> 6) + 1;
  let totalLen = nBlocks * 64;
  let buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[n] = 0x80;
  let dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, (n * 8) & 0xFFFFFFFF, true);
  dv.setUint32(totalLen - 4, Math.floor(n * 8 / 0x100000000), true);
  for (let offset = 0; offset < totalLen; offset += 64) {
    let k = [];
    for (let j = 0; j < 16; j++) k[j] = dv.getUint32(offset + j * 4, true);
    md5cycle(state, k);
  }
  const hex = [];
  for (let si = 0; si < 4; si++) {
    for (let bi = 0; bi < 4; bi++) {
      hex.push(((state[si] >> (bi * 8)) & 0xFF).toString(16).padStart(2, '0'));
    }
  }
  return hex.join('');
}

// ---------- Custom Base64 alphabets ----------
const STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_B64 = "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";
const X3_B64 = "MfgqrsbcyzPQRStuvC7mn501HIJBo2DEFTKdeNOwxWXYZap89+/A4UVLhijkl63G";

function translateB64(input, fromAlpha, toAlpha) {
  let out = "";
  for (const ch of input) {
    const idx = fromAlpha.indexOf(ch);
    out += idx >= 0 ? toAlpha[idx] : ch;
  }
  return out;
}

function bytesToStdB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function customB64Encode(bytes) {
  return translateB64(bytesToStdB64(bytes), STD_B64, CUSTOM_B64);
}

function x3B64Encode(bytes) {
  return translateB64(bytesToStdB64(bytes), STD_B64, X3_B64);
}

// ---------- 124-byte XOR key (from xhshow) ----------
const HEX_KEY = "71a302257793271ddd273bcee3e4b98d9d7935e1da33f5765e2ea8afb6dc77a51a499d23b67c20660025860cbf13d4540d92497f58686c574e508f46e1956344f39139bf4faf22a3eef120b79258145b2feb5193b6478669961298e79bedca646e1a693a926154a5a7a1bd1cf0dedb742f917a747a1e388b234f2277";

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}
const XOR_KEY = hexToBytes(HEX_KEY);

// ---------- Constants ----------
const VERSION_BYTES = [119, 104, 96, 41];
const CHECKSUM_FIXED_TAIL = [249, 65, 103, 103, 201, 181, 131, 99, 94, 7, 68, 250, 132, 21];

function intToLE(val, len = 4) {
  const arr = [];
  for (let i = 0; i < len; i++) { arr.push(val & 0xFF); val = Math.floor(val / 256); }
  return arr;
}

// Timestamp fingerprint with XOR key 41
function envFingerprintA(tsMs, xorKey) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  // Write as two 32-bit ints (little-endian) since BigInt may not be available everywhere
  dv.setUint32(0, tsMs & 0xFFFFFFFF, true);
  dv.setUint32(4, Math.floor(tsMs / 0x100000000) & 0xFFFFFFFF, true);
  const data = new Uint8Array(buf);
  const sum1 = (data[1] + data[2] + data[3] + data[4]) & 0xFF;
  const sum2 = (data[5] + data[6] + data[7]) & 0xFF;
  data[0] = (sum1 + sum2) & 0xFF;
  for (let i = 0; i < data.length; i++) data[i] ^= xorKey;
  return Array.from(data);
}

function envFingerprintB(tsMs) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, tsMs & 0xFFFFFFFF, true);
  dv.setUint32(4, Math.floor(tsMs / 0x100000000) & 0xFFFFFFFF, true);
  return Array.from(new Uint8Array(buf));
}

// ---------- Build the 124-byte payload ----------
function buildPayloadArray(md5Hex, a1Value, contentStr, timestampSec) {
  const payload = [];

  // [0-3] Version magic
  payload.push(...VERSION_BYTES);

  // [4-7] Random seed
  const seed = new Uint8Array(4);
  crypto.getRandomValues(seed);
  payload.push(...seed);
  const seedByte0 = seed[0];

  // [8-15] Env fingerprint A
  const tsMs = Math.floor(timestampSec * 1000);
  payload.push(...envFingerprintA(tsMs, 41));

  // [16-23] Env fingerprint B (offset timestamp)
  const offset = Math.floor(Math.random() * 40) + 10;
  payload.push(...envFingerprintB(Math.floor((timestampSec - offset) * 1000)));

  // [24-27] sequence value
  payload.push(...intToLE(Math.floor(Math.random() * 36) + 15));

  // [28-31] window props length
  payload.push(...intToLE(Math.floor(Math.random() * 301) + 900));

  // [32-35] content string length
  payload.push(...intToLE(contentStr.length));

  // [36-43] First 8 bytes of MD5, XOR'd with seedByte0
  const md5Bytes = hexToBytes(md5Hex);
  for (let i = 0; i < 8; i++) payload.push(md5Bytes[i] ^ seedByte0);

  // [44] a1 field length marker
  payload.push(52);

  // [45-96] a1 cookie value, padded/truncated to 52 bytes
  const a1Bytes = new TextEncoder().encode(a1Value);
  const a1Padded = new Uint8Array(52);
  a1Padded.set(a1Bytes.slice(0, 52));
  payload.push(...a1Padded);

  // [97] app identifier length marker
  payload.push(10);

  // [98-107] "xhs-pc-web"
  const appId = new TextEncoder().encode("xhs-pc-web");
  const appPadded = new Uint8Array(10);
  appPadded.set(appId.slice(0, 10));
  payload.push(...appPadded);

  // [108-109] fixed values
  payload.push(1);
  payload.push(1); // CHECKSUM_VERSION

  // [110] seed XOR 115
  payload.push(seedByte0 ^ 115);

  // [111-124] fixed tail
  payload.push(...CHECKSUM_FIXED_TAIL);

  return new Uint8Array(payload);
}

// ---------- XOR transform ----------
function xorTransform(payload) {
  const result = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    result[i] = i < XOR_KEY.length ? (payload[i] ^ XOR_KEY[i]) & 0xFF : payload[i] & 0xFF;
  }
  return result;
}

// ---------- CRC32 table for X-s-common ----------
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? ((0xEDB88320 ^ (c >>> 1)) >>> 0) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

// XHS variant of CRC32 — processes first 57 chars
function mrc(e) {
  let o = 0xFFFFFFFF;
  const len = Math.min(57, e.length);
  for (let n = 0; n < len; n++) {
    o = (CRC32_TABLE[(o & 255) ^ e.charCodeAt(n)] ^ (o >>> 8)) >>> 0;
  }
  return ((o ^ 0xFFFFFFFF) ^ 0xEDB88320) >>> 0;
}

// Generate X-s-common header value
function generateXsCommon(xs, xt, a1) {
  const common = {
    s0: 5, s1: "",
    x0: "1", x1: "3.6.8", x2: "Windows",
    x3: "xhs-pc-web", x4: "4.21.1",
    x5: a1, x6: xt, x7: xs,
    x8: "", x9: mrc(xt + xs), x10: 1
  };
  const jsonStr = JSON.stringify(common);
  const encoded = encodeURIComponent(jsonStr);
  const bytes = Array.from(encoded).map(c => c.charCodeAt(0));
  return customB64Encode(bytes);
}

// ---------- Generate X-s and X-t ----------
function signXs(method, uri, a1Value, postBody = null) {
  // Step 1: Build content string (POST 需要包含 body)
  let content = uri;
  if (method === "POST" && postBody) {
    content = uri + JSON.stringify(postBody);
  }

  // Step 2: MD5
  const md5Hex = md5(content);

  // Step 3: Build 124-byte payload
  const timestamp = Date.now() / 1000;
  const payloadArray = buildPayloadArray(md5Hex, a1Value, content, timestamp);

  // Step 4: XOR transform
  const xorResult = xorTransform(payloadArray);

  // Step 5: Custom Base64 → x3
  const x3Sig = x3B64Encode(Array.from(xorResult.slice(0, 124)));

  // Step 6: Signature data JSON
  const sigData = {
    x0: "4.2.6",
    x1: "xhs-pc-web",
    x2: "Windows",
    x3: "mns0301_" + x3Sig,
    x4: ""
  };

  // Step 7: Encode entire JSON with custom Base64
  const jsonStr = JSON.stringify(sigData);
  const jsonBytes = Array.from(new TextEncoder().encode(jsonStr));

  // Step 8: Final x-s
  const xs = "XYS_" + customB64Encode(jsonBytes);
  const xt = String(Math.floor(timestamp * 1000));

  return { xs, xt };
}

// ---------- Cookie parser ----------
function getCookieValue(cookieStr, key) {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
  return match ? match[1] : '';
}

// ---------- XHS API fetch ----------
// options: { baseUrl, origin, referer }
function xhsFetch(cookie, api, method = 'GET', body = null, options = {}) {
  const a1 = getCookieValue(cookie, 'a1');
  if (!a1) {
    return Promise.resolve({ ok: false, status: 401, data: { success: false, message: 'Cookie 中缺少 a1' } });
  }

  const { xs, xt } = signXs(method, api, a1, body);
  const xsCommon = generateXsCommon(xs, xt, a1);

  const originHost = options.origin || 'https://www.xiaohongshu.com';
  const refererUrl = options.referer || (originHost + '/');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cookie': cookie,
    'Origin': originHost,
    'Referer': refererUrl,
    'X-s': xs,
    'X-t': xt,
    'X-s-common': xsCommon,
    'X-b3-traceid': crypto.randomUUID().replace(/-/g, '').slice(0, 16),
  };

  const fetchOptions = { method, headers };
  if (method === 'POST' || method === 'PUT') {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
    if (body) fetchOptions.body = JSON.stringify(body);
  }

  const baseUrl = options.baseUrl || XHS_BASE;
  const url = `${baseUrl}${api}`;
  return fetch(url, fetchOptions).then(async (res) => {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  });
}


// ---------- XHS 图片上传 ----------
// 生成一个最小的有效 PNG 图片 (1080x1080 纯色)
function generateMinimalPNG() {
  // 生成一张 1x1 的深紫色 PNG，小红书会自动拉伸
  // PNG signature + IHDR + IDAT + IEND
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  // IHDR: 1x1, 8-bit RGB
  const ihdr = [
    0, 0, 0, 13, // chunk length
    73, 72, 68, 82, // "IHDR"
    0, 0, 0, 1, // width = 1
    0, 0, 0, 1, // height = 1
    8, 2, // 8-bit RGB
    0, 0, 0, // compression, filter, interlace
    // CRC32 of IHDR
    0x1E, 0x93, 0x09, 0x36
  ];
  // IDAT: deflated [filter_none(0), R, G, B] = [0, 88, 28, 120] (dark purple)
  // Raw deflate of [0, 88, 28, 120]: use stored block
  const rawData = new Uint8Array([0, 88, 28, 120]); // filter=0, R=88, G=28, B=120
  // Zlib: CMF=0x78, FLG=0x01 (no dict, low compression)
  // Stored block: BFINAL=1, BTYPE=00, LEN=4, NLEN=0xFFFB, data, Adler32
  const adler = adler32(rawData);
  const idat_data = new Uint8Array([
    0x78, 0x01, // zlib header
    0x01, // BFINAL=1, BTYPE=00 (stored)
    0x04, 0x00, 0xFB, 0xFF, // LEN=4, NLEN=~4
    ...rawData,
    (adler >> 24) & 0xFF, (adler >> 16) & 0xFF, (adler >> 8) & 0xFF, adler & 0xFF
  ]);
  const idat_crc = crc32Bytes([73, 68, 65, 84, ...idat_data]);
  const idat = [
    (idat_data.length >> 24) & 0xFF, (idat_data.length >> 16) & 0xFF,
    (idat_data.length >> 8) & 0xFF, idat_data.length & 0xFF,
    73, 68, 65, 84, // "IDAT"
    ...idat_data,
    (idat_crc >> 24) & 0xFF, (idat_crc >> 16) & 0xFF, (idat_crc >> 8) & 0xFF, idat_crc & 0xFF
  ];
  // IEND
  const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0xAE, 0x42, 0x60, 0x82];
  return new Uint8Array([...signature, ...ihdr, ...idat, ...iend]);
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc32Bytes(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc & 0xFF) ^ data[i]] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 获取 XHS 上传凭证
// ReaJason/xhs 使用 GET edith.xiaohongshu.com/api/media/v1/upload/web/permit?...
// 真实浏览器发布时 Origin 为 creator.xiaohongshu.com
async function getUploadCredentials(cookie, count = 1) {
  const params = { biz_name: 'spectrum', scene: 'image', file_count: count, version: '1', source: 'web' };
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const getApi = `/api/media/v1/upload/web/permit?${qs}`;
  const attempts = [];

  // 组合: host × origin，优先匹配 ReaJason 库 (edith + 无特殊 origin)
  const originCombos = [
    {}, // 默认 www.xiaohongshu.com
    { origin: 'https://creator.xiaohongshu.com', referer: 'https://creator.xiaohongshu.com/' },
  ];

  for (const baseUrl of XHS_MEDIA_HOST_CANDIDATES) {
    for (const originOpt of originCombos) {
      const result = await xhsFetch(cookie, getApi, 'GET', null, { baseUrl, ...originOpt });
     …33468 tokens truncated…风控/网关拦截错误，尝试切换发布 host 再试一次
          const needPublishHostFallback = images.length > 0
            && !result.data?.data?.note_id
            && [-9150, -9110].includes(Number(result.data?.result));
          if (needPublishHostFallback) {
            for (const host of XHS_PUBLISH_HOST_CANDIDATES) {
              if (host === XHS_BASE) continue;
              const retry = await xhsFetch(cookie, api, 'POST', publishBody, { baseUrl: host, ...publishOriginOpts });
              publishHostAttempts.push({
                baseUrl: host,
                origin: publishOriginOpts.origin,
                status: retry.status,
                ok: retry.ok,
                result: retry.data?.result,
                code: retry.data?.code,
                msg: retry.data?.msg || ''
              });
              if (retry.data?.data?.note_id || retry.data?.data?.id) {
                result = retry;
                steps.push('发布host回退成功: ' + host);
                break;
              }
              if (![-9150, -9110].includes(Number(retry.data?.result))) {
                result = retry;
                break;
              }
              result = retry;
            }
          }

          // 严格检查：必须有 note_id 才算真正发布成功
          const noteId = result.data?.data?.note_id || result.data?.data?.id || '';
          if (noteId) {
            return jsonResponse({
              success: true,
              note_id: noteId,
              message: '发布成功'
            }, { origin });
          }

          const resultCode = result.data?.result || result.data?.code;
          const rawText = typeof result.data?.raw === 'string' ? result.data.raw : '';
          const hadImages = images.length > 0;
          let failMessage = result.data?.msg || `发布失败 (${result.status})`;

          if (resultCode === -9150) {
            failMessage = '发布被拒(-9150)：疑似风控/技术升级拦截。可能原因：签名被检测、发布频率过高、账号异常。建议降低频率或更换 Cookie 后重试。';
          } else if (result.status >= 500 && /jarvis-gateway-default/i.test(rawText)) {
            failMessage = '小红书网关暂时不可用（jarvis-gateway-default）。这不是请求体字段错误，建议稍后重试。';
          }

          return jsonResponse({
            success: false,
            message: failMessage,
            debug: {
              steps,
              status: result.status,
              result_code: resultCode,
              had_images: hadImages,
              upload_diagnostics: uploadDiagnostics,
              publish_host_attempts: publishHostAttempts,
              raw: JSON.stringify(result.data).slice(0, 500)
            }
          }, { origin });
        } catch (e) {
          return jsonResponse({ success: false, message: `发布异常: ${e.message}` }, { status: 500, origin });
        }
      }

      // POST /xhs/comment - 评论笔记
      if (url.pathname === '/xhs/comment' && request.method === 'POST') {
        try {
          const body = await request.json();
          if (!body.note_id || !body.content) {
            return jsonResponse({ success: false, message: '缺少 note_id 或 content' }, { status: 400, origin });
          }

          const api = '/api/sns/web/v1/comment/post';
          const commentBody = {
            note_id: body.note_id,
            content: body.content,
            at_users: []
          };

          const result = await xhsFetch(cookie, api, 'POST', commentBody);

          // XHS 可能返回非2xx但body里success=true，以body为准
          if (result.data?.success || result.data?.code === 0 || result.data?.data?.comment) {
            return jsonResponse({ success: true, message: '评论成功' }, { origin });
          }

          return jsonResponse({
            success: false,
            message: result.data?.msg || `评论失败 (${result.status})`,
            debug: { status: result.status, raw: JSON.stringify(result.data).slice(0, 300) }
          }, { origin });
        } catch (e) {
          return jsonResponse({ success: false, message: `评论异常: ${e.message}` }, { status: 500, origin });
        }
      }

      return jsonResponse({ error: "Unknown XHS endpoint. Use /xhs/profile, /xhs/upload-test, /xhs/search, /xhs/feed, /xhs/publish, /xhs/comment" }, { status: 404, origin });
    }

    // ========== Replicate 代理 (写歌 App 用，给 ACE-Step 等模型走) ==========
    // 前端把 Authorization: Bearer r8_xxx 透传过来，Worker 只做路由 + CORS + CDN 兜底。
    //   POST /replicate/predictions          → 起任务 (透传 body 到 api.replicate.com)
    //   GET  /replicate/predictions/:id      → 轮询状态
    //   POST /replicate/predictions/:id/cancel → 取消任务
    //   GET  /replicate/file?url=...         → 下载 replicate.delivery 上的产物 (国内常超时)
    if (url.pathname.startsWith('/replicate/')) {
      // 1) 文件代下载：解决 replicate.delivery / pbxt.replicate.delivery 的国内访问问题
      if (url.pathname === '/replicate/file' && request.method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
          return jsonResponse({ error: 'Missing url parameter' }, { status: 400, origin });
        }
        let parsed;
        try {
          parsed = new URL(targetUrl);
        } catch {
          return jsonResponse({ error: 'Invalid URL' }, { status: 400, origin });
        }
        // 白名单：只放行 replicate 的产物 CDN
        const allowed = (host) => host === 'replicate.delivery'
          || host.endsWith('.replicate.delivery')
          || host === 'pbxt.replicate.com'
          || host.endsWith('.replicate.com');
        if (parsed.protocol !== 'https:' || !allowed(parsed.hostname)) {
          return jsonResponse({ error: 'Host not allowed' }, { status: 400, origin });
        }
        try {
          const upstream = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 sully-replicate-proxy',
              'Accept': '*/*',
            },
          });
          const respHeaders = new Headers(corsHeaders(origin));
          const ct = upstream.headers.get('Content-Type');
          if (ct) respHeaders.set('Content-Type', ct);
          const cl = upstream.headers.get('Content-Length');
          if (cl) respHeaders.set('Content-Length', cl);
          respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
          return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
        } catch (e) {
          return jsonResponse({ error: 'Replicate CDN fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
        }
      }

      // 2) API 转发：除 /file 外的所有路径，剥掉 /replicate 前缀转给 api.replicate.com
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (Replicate token)' }, { status: 401, origin });
      }
      const apiPath = url.pathname.replace(/^\/replicate/, ''); // e.g. /predictions
      const apiUrl = `https://api.replicate.com/v1${apiPath}${url.search || ''}`;
      const allowedMethods = ['GET', 'POST', 'DELETE'];
      if (!allowedMethods.includes(request.method)) {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      try {
        const forwardHeaders = {
          'Authorization': auth,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'sully-replicate-proxy',
        };
        const init = { method: request.method, headers: forwardHeaders };
        if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
          init.body = await request.text();
        }
        const upstream = await fetch(apiUrl, init);
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            ...corsHeaders(origin),
          },
        });
      } catch (e) {
        return jsonResponse({ error: 'Replicate upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 鱼声 Fish Audio TTS 代理 (静态部署绕 CORS, 纯透传) ==========
    // 前端 POST /fishaudio/tts?model=s2.1-pro  + Authorization: Bearer <fish key>
    // body = { text, reference_id, format, ... }；返回二进制音频(mp3)。
    // model 走 query：避免自定义 'model' header 触发 CORS 预检失败。
    // Worker 不读不存 key，只做 CORS + 转发 https://api.fish.audio/v1/tts。
    if (url.pathname === '/fishaudio/tts') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (Fish API key)' }, { status: 401, origin });
      }
      const model = (url.searchParams.get('model') || 's2.1-pro').trim();
      try {
        const upstream = await fetch('https://api.fish.audio/v1/tts', {
          method: 'POST',
          headers: {
            'Authorization': auth,
            'Content-Type': request.headers.get('Content-Type') || 'application/json',
            'model': model,
          },
          body: await request.text(),
        });
        const respHeaders = new Headers(corsHeaders(origin));
        respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'audio/mpeg');
        respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: 'Fish Audio upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 麦当劳 MCP 代理 (浏览器 CORS 兜底, 纯透传) ==========
    // 前端 POST /mcp/mcd  + Authorization: Bearer <user_mcp_token>
    // body 即 MCP JSON-RPC 报文 (initialize / tools/list / tools/call ...)
    // Worker 不读不存 token, 只做 CORS + 转发 https://mcp.mcd.cn
    if (url.pathname === '/mcp/mcd') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (McDonald\'s MCP token)' }, { status: 401, origin });
      }
      try {
        const fwdHeaders = {
          'Authorization': auth,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'Accept': request.headers.get('Accept') || 'application/json, text/event-stream',
          'User-Agent': 'aetheros-mcp-proxy/1.0',
        };
        const sid = request.headers.get('Mcp-Session-Id') || request.headers.get('mcp-session-id');
        if (sid) fwdHeaders['Mcp-Session-Id'] = sid;
        const upstream = await fetch('https://mcp.mcd.cn', {
          method: 'POST',
          headers: fwdHeaders,
          body: await request.text(),
        });
        const text = await upstream.text();
        const respHeaders = new Headers(corsHeaders(origin));
        const ct = upstream.headers.get('Content-Type');
        if (ct) respHeaders.set('Content-Type', ct);
        else respHeaders.set('Content-Type', 'application/json; charset=utf-8');
        const upSid = upstream.headers.get('Mcp-Session-Id') || upstream.headers.get('mcp-session-id');
        if (upSid) respHeaders.set('Mcp-Session-Id', upSid);
        return new Response(text, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: 'McDonald MCP upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 瑞幸 MCP 代理 (浏览器 CORS 兜底, 纯透传) ==========
    // 前端 POST /mcp/luckin  + Authorization: Bearer <user_mcp_token>
    // body 即 MCP JSON-RPC 报文 (initialize / tools/list / tools/call ...)
    // Worker 不读不存 token, 只做 CORS + 转发 https://gwmcp.lkcoffee.com/order/user/mcp
    // token 来源: 登录 https://open.lkcoffee.com 复制 (有效期约 1 个月)
    if (url.pathname === '/mcp/luckin') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (Luckin MCP token)' }, { status: 401, origin });
      }
      try {
        const fwdHeaders = {
          'Authorization': auth,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'Accept': request.headers.get('Accept') || 'application/json, text/event-stream',
          'User-Agent': 'aetheros-mcp-proxy/1.0',
        };
        const sid = request.headers.get('Mcp-Session-Id') || request.headers.get('mcp-session-id');
        if (sid) fwdHeaders['Mcp-Session-Id'] = sid;
        const upstream = await fetch('https://gwmcp.lkcoffee.com/order/user/mcp', {
          method: 'POST',
          headers: fwdHeaders,
          body: await request.text(),
        });
        const text = await upstream.text();
        const respHeaders = new Headers(corsHeaders(origin));
        const ct = upstream.headers.get('Content-Type');
        if (ct) respHeaders.set('Content-Type', ct);
        else respHeaders.set('Content-Type', 'application/json; charset=utf-8');
        const upSid = upstream.headers.get('Mcp-Session-Id') || upstream.headers.get('mcp-session-id');
        if (upSid) respHeaders.set('Mcp-Session-Id', upSid);
        return new Response(text, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: 'Luckin MCP upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 网易云音乐代理 (转发到 api-enhanced, 带边缘缓存 + 多上游容灾) ==========
    // 前端 POST /netease/<action> { ...body }
    // Worker 翻译成 api-enhanced 的 GET 参数形式并转发
    if (url.pathname.startsWith('/netease/')) {
      if (!NETEASE_UPSTREAMS || NETEASE_UPSTREAMS.length === 0) {
        return jsonResponse({
          error: "Worker 里 NETEASE_UPSTREAMS 还没配置",
          hint: "把 api-enhanced 部署到 Vercel/Deno Deploy, 拿到 URL 后改 worker/index.js 开头的 NETEASE_UPSTREAMS 数组, 然后重新部署 Worker"
        }, { status: 500, origin });
      }

      const action = url.pathname.replace('/netease/', '');
      const cookie = request.headers.get("X-Netease-Cookie") || "";
      let body = {};
      if (request.method === 'POST') {
        body = await request.json().catch(() => ({}));
      } else if (request.method === 'GET') {
        body = Object.fromEntries(url.searchParams.entries());
      }

      const upstreamPath = buildNeteaseUpstream(action, body, cookie);
      if (!upstreamPath) {
        return jsonResponse({
          error: "Unknown or unallowed netease action",
          hint: "支持: search, song/url, lyric, song/detail, login/status, login/cellphone, login/qr/key, login/qr/create, login/qr/check, captcha/sent, captcha/verify, user/detail, user/playlist, user/record, user/cloud, user/subcount, likelist, playlist/detail, playlist/track/all, recommend/songs, recommend/resource, personal_fm, daily_signin, toplist, toplist/detail, top/playlist, personalized, personalized/newsong, banner, comment/music, album, artists, artist/songs, mv/detail, mv/url 等"
        }, { status: 404, origin });
      }

      // ── 边缘缓存: 对公共数据(歌词/搜索/song/url 等) 命中直接返回 ──
      const ttl = NETEASE_CACHE_TTL[action] || 0;
      // song/url 受 VIP cookie 影响 → 用 has-cookie 分桶; 其余公共接口 cookie 不影响结果
      const cookieBucket = (action === 'song/url' && cookie) ? 'vip' : 'anon';
      const cacheKey = ttl > 0 ? buildCacheKey(action, body, cookieBucket) : null;
      if (cacheKey) {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          const text = await cached.text();
          return new Response(text, {
            status: cached.status,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-Sully-Cache': 'HIT',
              ...corsHeaders(origin),
            }
          });
        }
      }

      // ── 多上游 + 容灾: 随机打乱后依次尝试, 任意一个成功就返回 ──
      const { text, status, upstream, error } = await fetchFromAnyUpstream(upstreamPath);
      if (error) {
        return jsonResponse({
          error: "netease upstream fetch failed (all sources)",
          detail: error,
          tried: NETEASE_UPSTREAMS.length,
        }, { status: 502, origin });
      }

      const response = new Response(text, {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Sully-Cache': 'MISS',
          'X-Sully-Upstream': upstream,
          ...corsHeaders(origin),
        }
      });

      // ── 写回缓存 (异步, 不阻塞响应) ──
      if (cacheKey && status >= 200 && status < 400) {
        const cacheResp = new Response(text, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${ttl}`,
          }
        });
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(caches.default.put(cacheKey, cacheResp));
        } else {
          // dev 环境没有 ctx 时直接 fire-and-forget
          caches.default.put(cacheKey, cacheResp).catch(() => {});
        }
      }

      return response;
    }

    // ========== Brave Search 代理 ==========
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed. Use GET." }, { status: 405, origin });
    }

    const r = route(url);
    if (!r) {
      return jsonResponse({ error: "Not found.", hint: "Use /search, /news, /videos, /notion/*, /feishu/*, or /xhs/*" }, { status: 404, origin });
    }

    const q = url.searchParams.get("q")?.trim();
    if (!q) {
      return jsonResponse({ error: "Missing query param: q" }, { status: 400, origin });
    }

    const userKey = request.headers.get("X-Brave-API-Key")?.trim();
    if (!userKey) {
      return jsonResponse({ error: "Missing header: X-Brave-API-Key" }, { status: 401, origin });
    }

    const braveUrl = new URL(`${BRAVE_ENDPOINT}/${r.kind}/search`);
    braveUrl.searchParams.set("q", q);
    for (const k of ["count", "offset", "country", "safesearch", "spellcheck"]) {
      const v = url.searchParams.get(k);
      if (v) braveUrl.searchParams.set(k, v);
    }

    try {
      const braveRes = await fetch(braveUrl.toString(), {
        headers: { "Accept": "application/json", "X-Subscription-Token": userKey }
      });
      const text = await braveRes.text();
      return new Response(text, {
        status: braveRes.status,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
      });
    } catch (e) {
      return jsonResponse({ error: "Upstream fetch failed", detail: String(e) }, { status: 502, origin });
    }
  },
};
