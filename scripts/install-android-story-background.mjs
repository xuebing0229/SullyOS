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

for (const name of [
  'SullyStoryBackgroundPlugin.java',
  'SullyStoryGenerationManager.java',
  'SullyStoryKeepAliveService.java',
]) {
  const source = await readFile(path.join(root, 'native', 'android', name), 'utf8');
  await writeFile(path.join(pluginDir, name), source.replaceAll('__APP_ID__', appId));
}
// 9/3 早期试验版把 HTTP 直接塞进 Service；新架构明确删除该类。
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
await writeFile(mainPath, main);

let manifest = await readFile(manifestPath, 'utf8');
for (const permission of [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
]) {
  if (!manifest.includes(permission)) {
    manifest = manifest.replace(
      /<manifest\b[^>]*>/,
      tag => `${tag}\n    <uses-permission android:name="${permission}" />`,
    );
  }
}
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

// RikkaHub 的 OpenAI streaming provider 使用 OkHttp + okhttp-sse EventSource。
// 这里只引入同一官方 SSE 依赖，不再维护手写 SSE framing。
let gradle = await readFile(gradlePath, 'utf8');
gradle = gradle.replace(
  /^\s*implementation\s+["']com\.squareup\.okhttp3:(?:okhttp|okhttp-jvm|okhttp-sse)(?::[^"']+)?["']\s*$/gm,
  '',
);
const okHttpDependencies = [
  'implementation "com.squareup.okhttp3:okhttp-jvm:5.5.0"',
  'implementation "com.squareup.okhttp3:okhttp-sse:5.5.0"',
];
if (!/dependencies\s*\{/.test(gradle)) throw new Error('无法定位 android/app/build.gradle dependencies');
for (const dependency of okHttpDependencies.slice().reverse()) {
  gradle = gradle.replace(/dependencies\s*\{/, match => `${match}\n    ${dependency}`);
}
await writeFile(gradlePath, gradle);

console.log('[SullyStoryBackground] RikkaHub-style generation manager + foreground keepalive installed');
