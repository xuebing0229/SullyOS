import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function realInside(root, relative) {
  const target = fs.realpathSync(path.join(root, relative));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`Native icon target is outside the Capacitor wrapper: ${target}`);
  }
  return target;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(target));
    else if (entry.isFile()) out.push(target);
  }
  return out;
}

/**
 * The web/PWA icon lives in SullyOS, while the Android launcher resources live
 * in the separate Capacitor wrapper. Keep them in lockstep at build time so a
 * normal APK rebuild cannot silently retain the old launcher icon.
 */
export function syncNativeAppIcon(wrapperRoot) {
  const root = fs.realpathSync(wrapperRoot);
  const resRoot = realInside(root, 'android/app/src/main/res');

  const regularIcon = path.join(sourceRoot, 'public/icons/jellyfish-512.png');
  const maskableIcon = path.join(sourceRoot, 'public/icons/jellyfish-maskable-512.png');
  for (const source of [regularIcon, maskableIcon]) {
    if (!fs.existsSync(source)) throw new Error(`Missing SullyOS launcher icon source: ${source}`);
  }

  const targets = walk(resRoot).filter(file => /^ic_launcher(?:_round|_foreground)?\.png$/i.test(path.basename(file)));
  if (targets.length === 0) {
    throw new Error('No Android ic_launcher PNG resources were found in the Capacitor wrapper');
  }

  let foregroundCount = 0;
  for (const target of targets) {
    const isForeground = /_foreground\.png$/i.test(target);
    fs.copyFileSync(isForeground ? maskableIcon : regularIcon, target);
    if (isForeground) foregroundCount += 1;
  }

  // Modern Android normally reaches the adaptive icon through *_foreground.
  // Do not silently build an APK that only changed legacy launchers.
  if (foregroundCount === 0) {
    throw new Error('No adaptive Android ic_launcher_foreground PNG resources were found');
  }

  return { updated: targets.length, foreground: foregroundCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass the existing Capacitor wrapper directory');
  const result = syncNativeAppIcon(process.argv[2]);
  console.log(`Synced SullyOS jellyfish icon to ${result.updated} Android launcher resources (${result.foreground} adaptive foregrounds)`);
}
