import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const configPath = path.join(root, 'capacitor.config.json');
const templatePath = path.join(
    root,
    'native',
    'android',
    'SullyGalleryPlugin.java',
);

const config = JSON.parse(await readFile(configPath, 'utf8'));
const appId = String(config.appId || '').trim();

if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(appId)) {
    throw new Error(`capacitor.config.json appId 无效：${appId || '(empty)'}`);
}

const appJavaRoot = path.join(
    root,
    'android',
    'app',
    'src',
    'main',
    'java',
);
const packageDir = path.join(appJavaRoot, ...appId.split('.'));
const mainActivityPath = path.join(packageDir, 'MainActivity.java');
const pluginPackage = `${appId}.plugins`;
const pluginDir = path.join(packageDir, 'plugins');
const pluginTarget = path.join(pluginDir, 'SullyGalleryPlugin.java');
const manifestPath = path.join(
    root,
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml',
);

await Promise.all([
    access(mainActivityPath),
    access(manifestPath),
    access(templatePath),
]);

await mkdir(pluginDir, { recursive: true });
const template = await readFile(templatePath, 'utf8');
await writeFile(
    pluginTarget,
    template.replaceAll('__APP_ID__', appId),
    'utf8',
);

function addImport(source, importLine) {
    if (source.includes(importLine)) return source;

    const imports = [...source.matchAll(/^import .+;$/gm)];
    if (imports.length > 0) {
        const last = imports[imports.length - 1];
        const end = last.index + last[0].length;
        return `${source.slice(0, end)}\n${importLine}${source.slice(end)}`;
    }

    const packageMatch = source.match(/^package .+;$/m);
    if (!packageMatch) throw new Error('MainActivity.java 缺少 package 声明');
    const end = packageMatch.index + packageMatch[0].length;
    return `${source.slice(0, end)}\n\n${importLine}${source.slice(end)}`;
}

let mainActivity = await readFile(mainActivityPath, 'utf8');
mainActivity = addImport(mainActivity, 'import android.os.Bundle;');
mainActivity = addImport(
    mainActivity,
    `import ${pluginPackage}.SullyGalleryPlugin;`,
);

if (!mainActivity.includes('registerPlugin(SullyGalleryPlugin.class);')) {
    if (/void\s+onCreate\s*\(\s*Bundle\s+savedInstanceState\s*\)/.test(mainActivity)) {
        if (!mainActivity.includes('super.onCreate(savedInstanceState);')) {
            throw new Error('MainActivity 已有 onCreate，但结构无法安全修改');
        }
        mainActivity = mainActivity.replace(
            'super.onCreate(savedInstanceState);',
            [
                'registerPlugin(SullyGalleryPlugin.class);',
                '        super.onCreate(savedInstanceState);',
            ].join('\n        '),
        );
    } else {
        const lastBrace = mainActivity.lastIndexOf('}');
        if (lastBrace < 0) throw new Error('MainActivity.java 结构无效');
        const method = [
            '',
            '    @Override',
            '    public void onCreate(Bundle savedInstanceState) {',
            '        registerPlugin(SullyGalleryPlugin.class);',
            '        super.onCreate(savedInstanceState);',
            '    }',
            '',
        ].join('\n');
        mainActivity =
            mainActivity.slice(0, lastBrace)
            + method
            + mainActivity.slice(lastBrace);
    }
}
await writeFile(mainActivityPath, mainActivity, 'utf8');

let manifest = await readFile(manifestPath, 'utf8');
const permissionName = 'android.permission.WRITE_EXTERNAL_STORAGE';
if (!manifest.includes(permissionName)) {
    const openingManifest = manifest.match(/<manifest\b[^>]*>/);
    if (!openingManifest) throw new Error('AndroidManifest.xml 结构无效');
    const end = openingManifest.index + openingManifest[0].length;
    const permission = [
        '',
        '    <!-- 仅 Android 9 及以下保存图片需要；Android 10+ 使用 MediaStore，无权限弹窗。 -->',
        '    <uses-permission',
        '        android:name="android.permission.WRITE_EXTERNAL_STORAGE"',
        '        android:maxSdkVersion="28" />',
    ].join('\n');
    manifest = manifest.slice(0, end) + permission + manifest.slice(end);
    await writeFile(manifestPath, manifest, 'utf8');
}

console.log('[SullyGallery] Native plugin installed');
console.log(`[SullyGallery] appId: ${appId}`);
console.log(`[SullyGallery] Java: ${path.relative(root, pluginTarget)}`);
console.log(`[SullyGallery] MainActivity: ${path.relative(root, mainActivityPath)}`);
console.log(`[SullyGallery] Manifest: ${path.relative(root, manifestPath)}`);
