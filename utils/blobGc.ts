import { openDB } from './db';
import { BLOBREF_PREFIX } from './blobRef';

export const IMPORT_IN_PROGRESS_KEY = 'sullyos_import_in_progress_v1';
export const BLOB_GC_PROTECTION_MS = 10 * 60 * 1000;
const BLOB_STORE = 'blob_assets';

export interface BlobGcCandidate { id: string; size: number; createdAt: number; }
export interface BlobGcScanResult {
    candidates: BlobGcCandidate[];
    totalBlobCount: number;
    referencedBlobCount: number;
    protectedBlobCount: number;
    reclaimableBytes: number;
}
export interface BlobGcDeleteResult { deletedCount: number; deletedBytes: number; skippedCount: number; }

export function collectBlobRefIdsFromValue(value: unknown, output = new Set<string>(), seen = new WeakSet<object>()): Set<string> {
    if (typeof value === 'string') {
        let start = 0;
        while ((start = value.indexOf(BLOBREF_PREFIX, start)) >= 0) {
            const tail = value.slice(start + BLOBREF_PREFIX.length);
            const match = tail.match(/^[A-Za-z0-9._:-]+/);
            if (match?.[0]) output.add(match[0]);
            start += BLOBREF_PREFIX.length;
        }
        return output;
    }
    if (!value || typeof value !== 'object' || seen.has(value as object)) return output;
    seen.add(value as object);
    if (Array.isArray(value)) {
        for (const item of value) collectBlobRefIdsFromValue(item, output, seen);
    } else {
        for (const item of Object.values(value as Record<string, unknown>)) collectBlobRefIdsFromValue(item, output, seen);
    }
    return output;
}

export function isBackupImportInProgress(): boolean {
    try {
        const raw = localStorage.getItem(IMPORT_IN_PROGRESS_KEY);
        if (!raw) return false;
        const state = JSON.parse(raw);
        return state?.phase !== 'error';
    } catch {
        return true;
    }
}

const readAll = <T = any>(store: IDBObjectStore): Promise<T[]> => new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
});

const collectLocalStorageRefs = (refs: Set<string>): void => {
    if (typeof localStorage === 'undefined') return;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key === IMPORT_IN_PROGRESS_KEY) continue;
        collectBlobRefIdsFromValue(localStorage.getItem(key), refs);
    }
};

async function scanDatabaseReferences(db: IDBDatabase): Promise<{ refs: Set<string>; blobs: any[] }> {
    const storeNames = Array.from(db.objectStoreNames);
    if (!storeNames.includes(BLOB_STORE)) return { refs: new Set(), blobs: [] };
    const tx = db.transaction(storeNames, 'readonly');
    const refs = new Set<string>();
    const results = await Promise.all(storeNames.map(async name => {
        const rows = await readAll(tx.objectStore(name));
        if (name !== BLOB_STORE) collectBlobRefIdsFromValue(rows, refs);
        return name === BLOB_STORE ? rows : [];
    }));
    collectLocalStorageRefs(refs);
    return { refs, blobs: results.flat() };
}

export async function scanOrphanBlobAssets(now = Date.now()): Promise<BlobGcScanResult> {
    if (isBackupImportInProgress()) throw new Error('备份导入进行中，暂时不能扫描或清理图片');
    const db = await openDB();
    const { refs, blobs } = await scanDatabaseReferences(db);
    const candidates: BlobGcCandidate[] = [];
    let protectedBlobCount = 0;
    for (const row of blobs) {
        const id = String(row?.id || '');
        if (!id || refs.has(id)) continue;
        const createdAt = Number(row?.createdAt || 0);
        if (!createdAt || now - createdAt < BLOB_GC_PROTECTION_MS) { protectedBlobCount++; continue; }
        candidates.push({ id, size: Number(row?.blob?.size || 0), createdAt });
    }
    return {
        candidates,
        totalBlobCount: blobs.length,
        referencedBlobCount: blobs.filter(row => refs.has(String(row?.id || ''))).length,
        protectedBlobCount,
        reclaimableBytes: candidates.reduce((sum, item) => sum + item.size, 0),
    };
}

export async function deleteOrphanBlobAssets(candidateIds: string[], now = Date.now()): Promise<BlobGcDeleteResult> {
    if (isBackupImportInProgress()) throw new Error('备份导入进行中，暂时不能扫描或清理图片');
    const requested = new Set(candidateIds.filter(Boolean));
    if (!requested.size) return { deletedCount: 0, deletedBytes: 0, skippedCount: 0 };
    const db = await openDB();
    const storeNames = Array.from(db.objectStoreNames);
    if (!storeNames.includes(BLOB_STORE)) return { deletedCount: 0, deletedBytes: 0, skippedCount: requested.size };

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, 'readwrite');
        const refs = new Set<string>();
        const blobStore = tx.objectStore(BLOB_STORE);
        let pending = storeNames.length;
        let deletedCount = 0, deletedBytes = 0, skippedCount = 0;
        let failed: unknown = null;
        const finishScan = () => {
            if (--pending !== 0 || failed) return;
            try { collectLocalStorageRefs(refs); } catch (error) { failed = error; try { tx.abort(); } catch {} return; }
            for (const id of requested) {
                const getRequest = blobStore.get(id);
                getRequest.onsuccess = () => {
                    const row = getRequest.result;
                    if (!row || refs.has(id) || !row.createdAt || now - Number(row.createdAt) < BLOB_GC_PROTECTION_MS) { skippedCount++; return; }
                    deletedCount++;
                    deletedBytes += Number(row.blob?.size || 0);
                    blobStore.delete(id);
                };
                getRequest.onerror = () => { failed = getRequest.error; try { tx.abort(); } catch {} };
            }
        };
        for (const name of storeNames) {
            const request = tx.objectStore(name).getAll();
            request.onsuccess = () => { if (name !== BLOB_STORE) collectBlobRefIdsFromValue(request.result || [], refs); finishScan(); };
            request.onerror = () => { failed = request.error; try { tx.abort(); } catch {} };
        }
        tx.oncomplete = () => resolve({ deletedCount, deletedBytes, skippedCount });
        tx.onerror = () => reject(failed || tx.error || new Error('孤儿图片清理事务失败'));
        tx.onabort = () => reject(failed || tx.error || new Error('孤儿图片清理事务已中止'));
    });
}
