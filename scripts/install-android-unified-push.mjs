import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = String(config.appId || '').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(appId)) throw new Error(`无效 appId: ${appId}`);

const packageDir = path.join(root, 'android', 'app', 'src', 'main', 'java', ...appId.split('.'));
const pluginDir = path.join(packageDir, 'plugins');
const mainPath = path.join(packageDir, 'MainActivity.java');
const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
await Promise.all([access(mainPath), access(manifestPath), access(gradlePath)]);
await mkdir(pluginDir, { recursive: true });

for (const name of ['AmsgUnifiedPushPlugin.java', 'AmsgUnifiedPushService.java']) {
  const source = await readFile(path.join(root, 'native', 'android', name), 'utf8');
  await writeFile(path.join(pluginDir, name), source.replaceAll('__APP_ID__', appId));
}

let main = await readFile(mainPath, 'utf8');
const importLine = `import ${appId}.plugins.AmsgUnifiedPushPlugin;`;
if (!main.includes(importLine)) main = main.replace(/^package .+;$/m, (line) => `${line}\n\n${importLine}`);
if (!main.includes('registerPlugin(AmsgUnifiedPushPlugin.class);')) {
  main = main.replace('super.onCreate(savedInstanceState);', 'registerPlugin(AmsgUnifiedPushPlugin.class);\n        super.onCreate(savedInstanceState);');
}
await writeFile(mainPath, main);

let manifest = await readFile(manifestPath, 'utf8');
if (!manifest.includes('android.permission.POST_NOTIFICATIONS')) {
  manifest = manifest.replace(/<manifest\b[^>]*>/, (tag) => `${tag}\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`);
}
if (!manifest.includes('AmsgUnifiedPushService')) {
  manifest = manifest.replace('</application>', [
    '        <service',
    '            android:name=".plugins.AmsgUnifiedPushService"',
    '            android:exported="false">',
    '            <intent-filter>',
    '                <action android:name="org.unifiedpush.android.connector.PUSH_EVENT" />',
    '            </intent-filter>',
    '        </service>',
    '    </application>',
  ].join('\n'));
}
await writeFile(manifestPath, manifest);

let gradle = await readFile(gradlePath, 'utf8');
const dependency = "implementation 'org.unifiedpush.android:connector:3.3.5'";
if (!gradle.includes(dependency)) {
  gradle = gradle.replace(/dependencies\s*\{/, (line) => `${line}\n    ${dependency}`);
}
await writeFile(gradlePath, gradle);

console.log('[AmsgUnifiedPush] Native connector installed');
