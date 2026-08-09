import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { APP_RELEASE_VERSION } from './buildInfo';

const RELEASE_API = 'https://api.github.com/repos/xuebing0229/SullyOS/releases/latest';
const RELEASE_MANIFEST = 'https://github.com/xuebing0229/SullyOS/releases/latest/download/SullyOS-latest.json';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/xuebing0229/SullyOS/releases/download/';
const REQUEST_HEADERS = { 'User-Agent': `SullyOS-Android/${APP_RELEASE_VERSION}` };
const CHECKED_AT_KEY = 'sullyos_app_update_checked_at';
const RELEASE_CACHE_KEY = 'sullyos_app_update_release';
const SNOOZE_KEY = 'sullyos_app_update_snooze';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface AppRelease {
    version: string;
    tag: string;
    name: string;
    notes: string;
    apkUrl: string;
    apkName: string;
    apkSize: number;
    sha256?: string;
    publishedAt: string;
    pageUrl: string;
}

interface NativeUpdaterPlugin {
    downloadAndInstall(options: { url: string; fileName: string }): Promise<{ status: 'downloading' | 'permission_required' }>;
}

const NativeUpdater = registerPlugin<NativeUpdaterPlugin>('SullyAppUpdater');

const numericParts = (value: string): number[] => {
    const clean = value.trim().replace(/^v/i, '').split('-')[0];
    if (!/^\d+(\.\d+){0,3}$/.test(clean)) return [];
    return clean.split('.').map((part) => Number(part));
};

export const compareVersions = (left: string, right: string): number => {
    const a = numericParts(left);
    const b = numericParts(right);
    if (!a.length || !b.length) return 0;
    const count = Math.max(a.length, b.length);
    for (let i = 0; i < count; i += 1) {
        const delta = (a[i] || 0) - (b[i] || 0);
        if (delta !== 0) return delta > 0 ? 1 : -1;
    }
    return 0;
};

export const isAndroidApp = (): boolean => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const isTrustedApkUrl = (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith(RELEASE_DOWNLOAD_PREFIX) && value.toLowerCase().endsWith('.apk');

export const normalizeApiRelease = (raw: any): AppRelease | null => {
    if (!raw || raw.draft || raw.prerelease) return null;
    const assets = Array.isArray(raw.assets) ? raw.assets : [];
    const apk = assets.find((asset: any) => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.apk'));
    if (!isTrustedApkUrl(apk?.browser_download_url)) return null;
    const tag = String(raw.tag_name || '').trim();
    const version = tag.replace(/^v/i, '');
    if (!numericParts(version).length) return null;
    return {
        version,
        tag,
        name: String(raw.name || tag || `SullyOS ${version}`),
        notes: String(raw.body || '').trim(),
        apkUrl: String(apk.browser_download_url),
        apkName: String(apk.name || `SullyOS-v${version}.apk`),
        apkSize: Number(apk.size || 0),
        publishedAt: String(raw.published_at || ''),
        pageUrl: String(raw.html_url || ''),
    };
};

export const normalizeReleaseManifest = (raw: any): AppRelease | null => {
    if (!raw || Number(raw.schemaVersion) !== 1 || !isTrustedApkUrl(raw.apkUrl)) return null;
    const version = String(raw.version || '').trim().replace(/^v/i, '');
    if (!numericParts(version).length) return null;
    const tag = String(raw.tag || `v${version}`).trim();
    if (tag !== `v${version}` || !raw.apkUrl.startsWith(`${RELEASE_DOWNLOAD_PREFIX}${tag}/`)) return null;
    return {
        version,
        tag,
        name: String(raw.name || `SullyOS ${version}`),
        notes: String(raw.notes || '').trim(),
        apkUrl: raw.apkUrl,
        apkName: String(raw.apkName || `SullyOS-v${version}.apk`),
        apkSize: Number(raw.apkSize || 0),
        sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
        publishedAt: String(raw.publishedAt || ''),
        pageUrl: String(raw.pageUrl || `https://github.com/xuebing0229/SullyOS/releases/tag/${tag}`),
    };
};

const fetchManifestRelease = async (): Promise<AppRelease | null> => {
    const response = await CapacitorHttp.get({
        url: RELEASE_MANIFEST,
        responseType: 'json',
        headers: { ...REQUEST_HEADERS, Accept: 'application/json' },
    });
    if (response.status < 200 || response.status >= 300) return null;
    return normalizeReleaseManifest(response.data);
};

const fetchApiRelease = async (): Promise<AppRelease | null> => {
    const response = await CapacitorHttp.get({
        url: RELEASE_API,
        headers: {
            ...REQUEST_HEADERS,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
        const detail = typeof response.data?.message === 'string' ? `：${response.data.message}` : '';
        throw new Error(`GitHub Release 检查失败（HTTP ${response.status}）${detail}`);
    }
    return normalizeApiRelease(response.data);
};

const readCachedRelease = (): AppRelease | null => {
    try {
        const parsed = JSON.parse(localStorage.getItem(RELEASE_CACHE_KEY) || 'null');
        return parsed?.apkUrl ? parsed as AppRelease : null;
    } catch {
        return null;
    }
};

const isSnoozed = (tag: string): boolean => {
    try {
        const value = JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null');
        return value?.tag === tag && Date.now() - Number(value?.at || 0) < SNOOZE_MS;
    } catch {
        return false;
    }
};

export const snoozeAppUpdate = (tag: string): void => {
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ tag, at: Date.now() })); } catch { /* ignore */ }
};

export const checkForAppUpdate = async (options: { force?: boolean; respectSnooze?: boolean } = {}): Promise<AppRelease | null> => {
    if (!isAndroidApp()) return null;

    let release: AppRelease | null = null;
    const force = !!options.force;
    try {
        const checkedAt = Number(localStorage.getItem(CHECKED_AT_KEY) || 0);
        if (!force && Date.now() - checkedAt < CHECK_INTERVAL_MS) release = readCachedRelease();
    } catch { /* ignore */ }

    if (!release) {
        try {
            release = await fetchManifestRelease();
        } catch { /* 静态清单不可达时回退 GitHub API */ }
        if (!release) release = await fetchApiRelease();
        try {
            localStorage.setItem(CHECKED_AT_KEY, String(Date.now()));
            if (release) localStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify(release));
        } catch { /* ignore */ }
    }

    if (!release || compareVersions(release.version, APP_RELEASE_VERSION) <= 0) return null;
    if (options.respectSnooze && isSnoozed(release.tag)) return null;
    return release;
};

export const downloadAndInstallAppUpdate = async (release: AppRelease): Promise<'downloading' | 'permission_required'> => {
    if (!isAndroidApp()) throw new Error('应用内安装仅支持 Android 安装包');
    const result = await NativeUpdater.downloadAndInstall({ url: release.apkUrl, fileName: release.apkName });
    return result.status;
};
