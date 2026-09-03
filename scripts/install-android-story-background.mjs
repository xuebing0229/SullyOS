import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = String(config.appId || '').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(appId)) {
  throw new Error(`无效 appId: ${appId}`);
}

const packageDir = path.join(root, 'android', 'app', 'src', 'main', 'java', ...appId.split('.'));
const pluginDir = path.join(packageDir, 'plugins');
const mainPath = path.join(packageDir, 'MainActivity.java');
const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');

await Promise.all([access(mainPath), access(manifestPath), access(gradlePath)]);
await mkdir(pluginDir, { recursive: true });

for (const name of ['SullyStoryBackgroundPlugin.java', 'SullyStoryKeepAliveService.java']) {
  const source = await readFile(path.join(root, 'native', 'android', name), 'utf8');
  await writeFile(path.join(pluginDir, name), source.replaceAll('__APP_ID__', appId));
}
// 清掉 9/3 试验过的“原生直接请求模型”实现；新版只保留 WebView SSE + 原生保活。
await rm(path.join(pluginDir, 'SullyStoryBackgroundService.java'), { force: true });

let main = await readFile(mainPath, 'utf8');
const importLine = `import ${appId}.plugins.SullyStoryBackgroundPlugin;`;
if (!main.includes(importLine)) {
  main = main.replace(/^package .+;$/m, line => `${line}\n\n${importLine}`);
}
if (!main.includes('registerPlugin(SullyStoryBackgroundPlugin.class);')) {
  main = main.replace(
    'super.onCreate(savedInstanceState);',
    'registerPlugin(SullyStoryBackgroundPlugin.class);\n        super.onCreate(savedInstanceState);',
  );
}

const rendererPolicyMarker =
  'setRendererPriorityPolicy(android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT, false);';
if (!main.includes(rendererPolicyMarker)) {
  const anchor = 'super.onCreate(savedInstanceState);';
  if (!main.includes(anchor)) throw new Error('MainActivity 缺少可用的 onCreate/super.onCreate');
  main = main.replace(anchor, [
    anchor,
    '        // ForegroundService/WakeLock 保护的是 App 进程；WebView renderer 是独立进程。',
    '        // 明确保持 renderer 为 IMPORTANT 且后台不可降级，避免切屏后 SSE 所在 renderer 被冻结。',
    '        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O',
    '            && bridge != null',
    '            && bridge.getWebView() != null) {',
    '            bridge.getWebView().setRendererPriorityPolicy(',
    '                android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT,',
    '                false',
    '            );',
    '        }',
  ].join('\n'));
}
await writeFile(mainPath, main);

let manifest = await readFile(manifestPath, 'utf8');
for (const permission of [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.WAKE_LOCK',
]) {
  if (!manifest.includes(permission)) {
    manifest = manifest.replace(
      /<manifest\b[^>]*>/,
      tag => `${tag}\n    <uses-permission android:name="${permission}" />`,
    );
  }
}

// 移除旧原生 completion service 的 manifest 残留。
manifest = manifest.replace(
  /\s*<service\s+android:name="\.plugins\.SullyStoryBackgroundService"[\s\S]*?\/>/g,
  '',
);
if (!manifest.includes('SullyStoryKeepAliveService')) {
  manifest = manifest.replace('</application>', [
    '        <service',
    '            android:name=".plugins.SullyStoryKeepAliveService"',
    '            android:exported="false"',
    '            android:foregroundServiceType="dataSync" />',
    '    </application>',
  ].join('\n'));
}
await writeFile(manifestPath, manifest);

// 清掉旧原生 completion 曾注入的 OkHttp / okhttp-sse；保活 Service 不拥有模型网络请求。
let gradle = await readFile(gradlePath, 'utf8');
gradle = gradle.replace(
  /^\s*implementation\s+["']com\.squareup\.okhttp3:okhttp:4\.12\.0["']\s*$/gm,
  '',
);
await writeFile(gradlePath, gradle);

console.log('[SullyStoryBackground] WebView SSE keepalive installed (FGS + WakeLock + renderer priority)');
