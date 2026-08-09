import { beforeEach, describe, expect, it, vi } from 'vitest';

const { httpGet } = vi.hoisted(() => ({ httpGet: vi.fn() }));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
    },
    CapacitorHttp: { get: httpGet },
    registerPlugin: () => ({}),
}));

vi.mock('./buildInfo', () => ({ APP_RELEASE_VERSION: '2.3.0' }));

import { checkForAppUpdate, compareVersions, normalizeReleaseManifest } from './appUpdate';

const manifest = {
    schemaVersion: 1,
    version: '2.3.4',
    tag: 'v2.3.4',
    name: 'SullyOS v2.3.4',
    notes: '更新检查修复',
    apkUrl: 'https://github.com/xuebing0229/SullyOS/releases/download/v2.3.4/SullyOS-v2.3.4.apk',
    apkName: 'SullyOS-v2.3.4.apk',
    apkSize: 1024,
    publishedAt: '2026-08-09T00:00:00Z',
    pageUrl: 'https://github.com/xuebing0229/SullyOS/releases/tag/v2.3.4',
};

beforeEach(() => httpGet.mockReset());

describe('compareVersions', () => {
    it('compares normal semantic versions', () => {
        expect(compareVersions('2.3.0', '2.2.9')).toBe(1);
        expect(compareVersions('2.3.0', '2.3.1')).toBe(-1);
        expect(compareVersions('v2.3.0', '2.3.0')).toBe(0);
    });

    it('normalizes missing version segments', () => {
        expect(compareVersions('2.3', '2.3.0')).toBe(0);
        expect(compareVersions('2.3.1', '2.3')).toBe(1);
    });

    it('does not treat malformed labels as newer', () => {
        expect(compareVersions('latest', '2.3.0')).toBe(0);
    });
});

describe('release manifest', () => {
    it('accepts the signed release manifest and rejects foreign APK URLs', () => {
        expect(normalizeReleaseManifest(manifest)?.version).toBe('2.3.4');
        expect(normalizeReleaseManifest({ ...manifest, apkUrl: 'https://example.com/app.apk' })).toBeNull();
        expect(normalizeReleaseManifest({ ...manifest, tag: 'v9.9.9' })).toBeNull();
    });

    it('uses the static manifest without calling the rate-limited API', async () => {
        httpGet.mockResolvedValueOnce({ status: 200, data: manifest });

        await expect(checkForAppUpdate({ force: true })).resolves.toMatchObject({ version: '2.3.4' });
        expect(httpGet).toHaveBeenCalledTimes(1);
        expect(httpGet.mock.calls[0][0]).toMatchObject({
            headers: expect.objectContaining({ 'User-Agent': 'SullyOS-Android/2.3.0' }),
        });
    });

    it('falls back to the GitHub API when the manifest is unavailable', async () => {
        httpGet
            .mockResolvedValueOnce({ status: 404, data: null })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    tag_name: 'v2.3.4',
                    name: 'SullyOS v2.3.4',
                    body: 'fallback',
                    assets: [{
                        name: 'SullyOS-v2.3.4.apk',
                        size: 1024,
                        browser_download_url: manifest.apkUrl,
                    }],
                    html_url: manifest.pageUrl,
                    published_at: manifest.publishedAt,
                },
            });

        await expect(checkForAppUpdate({ force: true })).resolves.toMatchObject({ version: '2.3.4' });
        expect(httpGet).toHaveBeenCalledTimes(2);
    });
});
