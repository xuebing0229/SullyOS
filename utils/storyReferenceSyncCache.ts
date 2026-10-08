/** Successful reference presence receipts, scoped to the exact image, endpoint and tenant.
 * A cached receipt skips per-turn local image decoding and HEAD requests.
 * Entries are revalidated after 30 days in case the image server was rebuilt.
 * API tokens are only ever used as SHA-256 input; they are never persisted.
 */
const KEY = 'sully_story_reference_sync_v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 256;

export interface StoryReferenceSyncTarget {
    controlBaseUrl: string;
    token: string;
    slotId: string;
    sha256: string;
}

const read = (): Record<string, number> => {
    try {
        const raw = localStorage.getItem(KEY);
        const data = raw ? JSON.parse(raw) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
        return Object.fromEntries(Object.entries(data).filter(
            ([k, v]) => /^[0-9a-f]{64}$/.test(k) && typeof v === 'number' && Number.isFinite(v),
        )) as Record<string, number>;
    } catch { return {}; }
};

const keyOf = async (target: StoryReferenceSyncTarget): Promise<string | null> => {
    const base = String(target.controlBaseUrl || '').trim().replace(/\/+$/, '');
    const slot = String(target.slotId || '').trim();
    const sha = String(target.sha256 || '').trim().toLowerCase();
    if (!base || !slot || !/^[0-9a-f]{64}$/.test(sha) || !globalThis.crypto?.subtle) return null;
    const encoded = new TextEncoder().encode(JSON.stringify([base, target.token || '', slot, sha]));
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
};

export const isStoryReferenceSynced = async (target: StoryReferenceSyncTarget): Promise<boolean> => {
    const key = await keyOf(target);
    if (!key) return false;
    const verifiedAt = read()[key];
    return typeof verifiedAt === 'number' && verifiedAt <= Date.now()
        && Date.now() - verifiedAt < MAX_AGE_MS;
};

export const rememberStoryReferenceSynced = async (target: StoryReferenceSyncTarget): Promise<void> => {
    const key = await keyOf(target);
    if (!key) return;
    try {
        const now = Date.now();
        const entries = Object.entries({ ...read(), [key]: now })
            .filter(([, at]) => at <= now && now - at < MAX_AGE_MS)
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_ENTRIES);
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* private mode or full storage: fall back to verification next turn */ }
};

export const forgetStoryReferenceSynced = async (target: StoryReferenceSyncTarget): Promise<void> => {
    const key = await keyOf(target);
    if (!key) return;
    try {
        const entries = read();
        if (!(key in entries)) return;
        delete entries[key];
        localStorage.setItem(KEY, JSON.stringify(entries));
    } catch { /* best effort */ }
};
