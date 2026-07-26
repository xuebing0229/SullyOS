import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import { blobRefFromId } from './blobRef';
import { BLOB_GC_PROTECTION_MS, collectBlobRefIdsFromValue, deleteOrphanBlobAssets, IMPORT_IN_PROGRESS_KEY, scanOrphanBlobAssets } from './blobGc';

describe('blob orphan GC', () => {
    beforeEach(async () => { localStorage.clear(); await DB.deleteDB().catch(() => undefined); });
    it('collects nested and embedded blob refs without looping on cycles', () => {
        const value: any = { a: 'url(blobref:one)', b: ['blobref:two'] }; value.self = value;
        expect([...collectBlobRefIdsFromValue(value)].sort()).toEqual(['one', 'two']);
    });
    it('scans all stores and localStorage while protecting recent blobs', async () => {
        const now = Date.now();
        await DB.putBlobAsset('used_message', new Blob(['a']), now - BLOB_GC_PROTECTION_MS - 1);
        await DB.putBlobAsset('used_local', new Blob(['bb']), now - BLOB_GC_PROTECTION_MS - 1);
        await DB.putBlobAsset('orphan_old', new Blob(['ccc']), now - BLOB_GC_PROTECTION_MS - 1);
        await DB.putBlobAsset('orphan_new', new Blob(['dddd']), now);
        await DB.saveMessage({ charId: 'c', role: 'assistant', type: 'image', content: blobRefFromId('used_message') } as any);
        localStorage.setItem('theme-test', JSON.stringify({ image: blobRefFromId('used_local') }));
        const result = await scanOrphanBlobAssets(now);
        expect(result.candidates.map(x => x.id)).toEqual(['orphan_old']);
        expect(result.protectedBlobCount).toBe(1);
        expect(result.reclaimableBytes).toBe(3);
    });
    it('rechecks references inside the delete transaction', async () => {
        const now = Date.now();
        await DB.putBlobAsset('candidate', new Blob(['abc']), now - BLOB_GC_PROTECTION_MS - 1);
        expect((await scanOrphanBlobAssets(now)).candidates.map(x => x.id)).toContain('candidate');
        await DB.saveGalleryImage({ id: 'g', charId: 'c', url: blobRefFromId('candidate'), timestamp: now });
        const result = await deleteOrphanBlobAssets(['candidate'], now);
        expect(result.deletedCount).toBe(0); expect(result.skippedCount).toBe(1);
        expect(await DB.getBlobAsset('candidate')).not.toBeNull();
    });
    it('deletes old unreferenced blobs and blocks while import is active', async () => {
        const now = Date.now();
        await DB.putBlobAsset('orphan', new Blob(['abc']), now - BLOB_GC_PROTECTION_MS - 1);
        const result = await deleteOrphanBlobAssets(['orphan'], now);
        expect(result.deletedCount).toBe(1); expect(await DB.getBlobAsset('orphan')).toBeNull();
        localStorage.setItem(IMPORT_IN_PROGRESS_KEY, JSON.stringify({ phase: 'database' }));
        await expect(scanOrphanBlobAssets(now)).rejects.toThrow(/导入进行中/);
    });
});
