import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = String(config.appId || '').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(appId)) throw new Error(`无效 appId: ${appId}`);

const packageDir = path.join(root, 'android', 'app', 'src', 'main', 'java', ...appId.split('.'));
const mainPath = path.join(packageDir, 'MainActivity.java');
const sourcePath = path.join(root, 'native', 'android', 'SullyAppUpdaterPlugin.java');
const pluginDir = path.join(packageDir, 'plugins');
const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const xmlDir = path.join(root, 'android', 'app', 'src', 'main', 'res', 'xml');
await Promise.all([access(mainPath), access(sourcePath), access(manifestPath)]);

await mkdir(pluginDir, { recursive: true });
await writeFile(path.join(pluginDir, 'SullyAppUpdaterPlugin.java'), (await readFile(sourcePath, 'utf8')).replaceAll('__APP_ID__', appId));

let main = await readFile(mainPath, 'utf8');
const importLine = `import ${appId}.plugins.SullyAppUpdaterPlugin;`;
if (!main.includes(importLine)) {
    const imports = [...main.matchAll(/^import .+;$/gm)];
    const anchor = imports.at(-1);
    if (anchor) {
        const end = anchor.index + anchor[0].length;
        main = `${main.slice(0, end)}\n${importLine}${main.slice(end)}`;
    } else {
        main = main.replace(/^package .+;$/m, (match) => `${match}\n\n${importLine}`);
    }
}
if (!main.includes('registerPlugin(SullyAppUpdaterPlugin.class);')) {
    const anchor = 'registerPlugin(GameHallWebViewPlugin.class);';
    if (main.includes(anchor)) main = main.replace(anchor, `${anchor}\n        registerPlugin(SullyAppUpdaterPlugin.class);`);
    else if (main.includes('super.onCreate(savedInstanceState);')) main = main.replace('super.onCreate(savedInstanceState);', 'registerPlugin(SullyAppUpdaterPlugin.class);\n        super.onCreate(savedInstanceState);');
    else throw new Error('无法安全注册 SullyAppUpdaterPlugin');
}
await writeFile(mainPath, main);

let manifest = await readFile(manifestPath, 'utf8');
if (!manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
    manifest = manifest.replace(/<manifest\b[^>]*>/, (match) => `${match}\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`);
}
if (!manifest.includes('${applicationId}.sullyos.updates')) {
    const provider = [
        '        <provider',
        '            android:name="androidx.core.content.FileProvider"',
        '            android:authorities="${applicationId}.sullyos.updates"',
        '            android:exported="false"',
        '            android:grantUriPermissions="true">',
        '            <meta-data',
        '                android:name="android.support.FILE_PROVIDER_PATHS"',
        '                android:resource="@xml/sully_update_paths" />',
        '        </provider>',
    ].join('\n');
    manifest = manifest.replace('</application>', `${provider}\n    </application>`);
}
await writeFile(manifestPath, manifest);

await mkdir(xmlDir, { recursive: true });
await writeFile(path.join(xmlDir, 'sully_update_paths.xml'), [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<paths xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <external-files-path name="updates" path="Download/updates/" />',
    '</paths>',
    '',
].join('\n'));

console.log('[SullyAppUpdater] Native plugin installed');
