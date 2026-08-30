import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = String(config.appId || '').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(appId)) throw new Error(`无效 appId: ${appId}`);

const packageDir = path.join(root, 'android', 'app', 'src', 'main', 'java', ...appId.split('.'));
const mainPath = path.join(packageDir, 'MainActivity.java');
const sourcePath = path.join(root, 'native', 'android', 'SullyLive2DDirectoryPlugin.java');
const pluginDir = path.join(packageDir, 'plugins');
await Promise.all([access(mainPath), access(sourcePath)]);
await mkdir(pluginDir, { recursive: true });
await writeFile(
  path.join(pluginDir, 'SullyLive2DDirectoryPlugin.java'),
  (await readFile(sourcePath, 'utf8')).replaceAll('__APP_ID__', appId),
);

let main = await readFile(mainPath, 'utf8');
const importLine = `import ${appId}.plugins.SullyLive2DDirectoryPlugin;`;
if (!main.includes(importLine)) {
  const imports = [...main.matchAll(/^import .+;$/gm)];
  const anchor = imports.at(-1);
  if (anchor) {
    const end = anchor.index + anchor[0].length;
    main = `${main.slice(0, end)}\n${importLine}${main.slice(end)}`;
  } else {
    main = main.replace(/^package .+;$/m, match => `${match}\n\n${importLine}`);
  }
}
if (!main.includes('registerPlugin(SullyLive2DDirectoryPlugin.class);')) {
  if (main.includes('super.onCreate(savedInstanceState);')) {
    main = main.replace(
      'super.onCreate(savedInstanceState);',
      'registerPlugin(SullyLive2DDirectoryPlugin.class);\n        super.onCreate(savedInstanceState);',
    );
  } else {
    throw new Error('无法安全注册 SullyLive2DDirectoryPlugin');
  }
}
await writeFile(mainPath, main);
console.log('[SullyLive2DDirectory] Native plugin installed');
