#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const requireEnv = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};

const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requireEnv('CLOUDFLARE_API_TOKEN');
const scriptName = String(process.env.AMSG_SCRIPT_NAME || 'sullyos-amsg').trim();
const workerUrl = String(
  process.env.AMSG_WORKER_URL
  || 'https://sullyos-amsg.xuebing0229-sullyos.workers.dev',
).replace(/\/+$/, '');
const apiBase = 'https://api.cloudflare.com/client/v4';

const readJson = async (response) => {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare 返回非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok || body?.success === false) {
    const detail = Array.isArray(body?.errors)
      ? body.errors.map((item) => `${item?.code || '?'}: ${item?.message || 'unknown'}`).join('；')
      : `HTTP ${response.status}`;
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return body?.result;
};

const cf = async (path, init = {}) => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(init.headers || {}),
    },
  });
  return readJson(response);
};

const settingsPath =
  `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`;

// 先只读：token 权限不够、脚本名不对、账号不对时到这里就停，绝不碰线上代码。
const settings = await cf(settingsPath);
const currentBindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
const bindingNames = new Set(
  currentBindings
    .map((binding) => typeof binding?.name === 'string' ? binding.name : '')
    .filter(Boolean),
);

for (const required of ['DB', 'INSTANT_TICK', 'AMSG_MASTER_KEY']) {
  if (!bindingNames.has(required)) {
    throw new Error(`现有 Worker 缺少 ${required} binding；为避免误重建资源，本次拒绝部署`);
  }
}

const bundle = await readFile('worker/amsg/worker.bundle.js');
if (bundle.byteLength < 100 * 1024) {
  throw new Error(`AMSG bundle 异常偏小（${bundle.byteLength} bytes），拒绝覆盖`);
}
const sourceVersion = await readFile('utils/amsgBundleVersion.ts', 'utf8');
const versionMatch = sourceVersion.match(/AMSG_BUNDLE_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!versionMatch) throw new Error('读不到 AMSG_BUNDLE_VERSION');
const expectedVersion = versionMatch[1];

// Cloudflare 2026 Script Upload API 支持 inherit binding：值仍留在 Cloudflare，上传端只说“沿用这个名字”。
// 配 bindings_inherit=strict 后，只要任何一项不能继承，整次上传直接失败，不会静默丢 binding。
const inheritedBindings = [...bindingNames].map((name) => ({ type: 'inherit', name }));
const metadata = {
  main_module: 'worker.bundle.js',
  compatibility_date: settings?.compatibility_date || '2026-01-01',
  compatibility_flags: Array.isArray(settings?.compatibility_flags)
    ? settings.compatibility_flags
    : ['global_fetch_strictly_public'],
  bindings: inheritedBindings,
  observability: settings?.observability || { enabled: true, logs: { enabled: true } },
  ...(settings?.placement ? { placement: settings.placement } : {}),
};

const form = new FormData();
form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.set(
  'worker.bundle.js',
  new Blob([bundle], { type: 'application/javascript+module' }),
  'worker.bundle.js',
);

await cf(
  `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}?bindings_inherit=strict`,
  { method: 'PUT', body: form },
);

// 不打印任何 binding/secret；只验证新代码已经真正成为 production。
let verified = false;
let lastDetail = '';
for (let attempt = 0; attempt < 12; attempt += 1) {
  if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2500));
  try {
    const response = await fetch(
      `${workerUrl}/config-check?verify=${Date.now()}`,
      { headers: { 'Cache-Control': 'no-cache' } },
    );
    const body = await response.json();
    const data = body?.data || {};
    lastDetail = `HTTP ${response.status}; version=${data.workerVersion || 'missing'}; storyJobs=${String(data.storyJobs)}; storyTick=${String(data.storyTick)}`;
    if (
      response.ok
      && body?.success === true
      && data.workerVersion === expectedVersion
      && data.storyJobs === true
      && data.storyTick === true
    ) {
      verified = true;
      break;
    }
  } catch (error) {
    lastDetail = String(error?.message || error);
  }
}
if (!verified) {
  throw new Error(`脚本上传完成，但线上能力验收未通过：${lastDetail}`);
}

console.log(`sullyos-amsg 已完成代码更新并验收：workerVersion=${expectedVersion}, storyJobs=true, storyTick=true`);
