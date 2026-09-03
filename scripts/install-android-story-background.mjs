import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  'SullyStoryBackgroundService.java',
  'SullyStoryKeepAliveService.java',
]) {
  const source = await readFile(path.join(root, 'native', 'android', name), 'utf8');
  await writeFile(path.join(pluginDir, name), source.replaceAll('__APP_ID__', appId));
}

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
  'android.permission.WAKE_LOCK',
]) {
  if (!manifest.includes(permission)) {
    manifest = manifest.replace(
      /<manifest\b[^>]*>/,
      tag => `${tag}\n    <uses-permission android:name="${permission}" />`,
    );
  }
}
if (!manifest.includes('SullyStoryBackgroundService')) {
  manifest = manifest.replace('</application>', [
    '        <service',
    '            android:name=".plugins.SullyStoryBackgroundService"',
    '            android:exported="false"',
    '            android:foregroundServiceType="dataSync" />',
    '    </application>',
  ].join('\n'));
}
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

// 采用成熟项目通用的官方 okhttp-sse EventSource，SSE framing 不再手搓。
let gradle = await readFile(gradlePath, 'utf8');
gradle = gradle.replace(
  /^\s*implementation\s+["']com\.squareup\.okhttp3:okhttp(?::[^"']+)?["']\s*$/gm,
  '',
);
const sseDependency = 'implementation "com.squareup.okhttp3:okhttp-sse:4.12.0"';
if (!gradle.includes('com.squareup.okhttp3:okhttp-sse')) {
  if (!/dependencies\s*\{/.test(gradle)) throw new Error('无法定位 android/app/build.gradle dependencies');
  gradle = gradle.replace(/dependencies\s*\{/, match => `${match}\n    ${sseDependency}`);
}
await writeFile(gradlePath, gradle);

console.log('[SullyStoryBackground] Native ForegroundService + okhttp-sse EventSource installed');
