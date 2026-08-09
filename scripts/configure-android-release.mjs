import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const version = String(process.env.ANDROID_VERSION_NAME || '').replace(/^v/i, '');
const versionCode = Number(process.env.ANDROID_VERSION_CODE || 0);
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`ANDROID_VERSION_NAME 必须是 x.y.z：${version || '(empty)'}`);
if (!Number.isInteger(versionCode) || versionCode < 1) throw new Error('ANDROID_VERSION_CODE 必须是正整数');
for (const name of ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
    if (!process.env[name]) throw new Error(`缺少 ${name}`);
}

const gradlePath = path.join(process.cwd(), 'android', 'app', 'build.gradle');
let gradle = await readFile(gradlePath, 'utf8');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+["'][^"']+["']/, `versionName "${version}"`);

if (!gradle.includes('signingConfigs {')) {
    const signing = [
        '    signingConfigs {',
        '        release {',
        '            storeFile file(System.getenv("ANDROID_KEYSTORE_FILE"))',
        '            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")',
        '            keyAlias System.getenv("ANDROID_KEY_ALIAS")',
        '            keyPassword System.getenv("ANDROID_KEY_PASSWORD")',
        '        }',
        '    }',
        '',
    ].join('\n');
    gradle = gradle.replace(/\n\s*buildTypes\s*\{/, `\n${signing}    buildTypes {`);
}
// `release {}` 同时会出现在 signingConfigs 与 buildTypes 中，必须从 buildTypes
// 锚点之后定位，否则会把 signingConfig 递归写进签名配置自身。
gradle = gradle.replace(/^\s*signingConfig signingConfigs\.release\s*$/gm, '');
const buildTypesStart = gradle.indexOf('buildTypes {');
const releaseStart = buildTypesStart < 0 ? -1 : gradle.indexOf('release {', buildTypesStart);
if (releaseStart < 0) throw new Error('无法定位 buildTypes.release');
const releaseBraceEnd = releaseStart + 'release {'.length;
gradle = `${gradle.slice(0, releaseBraceEnd)}\n            signingConfig signingConfigs.release${gradle.slice(releaseBraceEnd)}`;
if (!gradle.includes(`versionCode ${versionCode}`) || !gradle.includes(`versionName "${version}"`) || !gradle.includes('signingConfig signingConfigs.release')) {
    throw new Error('无法安全修改 android/app/build.gradle');
}
await writeFile(gradlePath, gradle);
console.log(`[Android release] versionName=${version}, versionCode=${versionCode}`);
