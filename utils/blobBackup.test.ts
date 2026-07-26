import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import { blobRefFromId } from './blobRef';
import { externalizeBlobRefsInPlace, restorePortableBlobRefsInPlace } from './blobBackup';

describe('portable blob backup', () => {
    beforeEach(async () => {
        localStorage.clear();
        await DB.deleteDB().catch(() => undefined);
    });

    it('writes one file for a shared chat/gallery ref', async () => {
        const id = 'img_shared_test';
        await DB.putBlobAsset(id, new Blob(['image'], { type: 'image/png' }), Date.now() - 1000);
        const root = {
            messages: [{ content: blobRefFromId(id) }],
            gallery: [{ url: blobRefFromId(id) }],
        };
        const files = new Map<string, Uint8Array>();
        const stats = await externalizeBlobRefsInPlace(root, {
            hasPath: path => files.has(path),
            writeBytes: (path, bytes) => files.set(path, bytes),
        }, new Map());
        expect(stats.referenced).toBe(2);
        expect(stats.written).toBe(1);
        expect(files.size).toBe(1);
        expect(root.messages[0].content).toBe(root.gallery[0].url);
        expect(root.messages[0].content).toMatch(/^assets\/blobrefs\//);
    });

    it('restores a shared path to one shared blobref', async () => {
        const path = 'assets/blobrefs/img_1.png';
        const root = { messages: [{ content: path }], gallery: [{ url: path }] };
        const result = await restorePortableBlobRefsInPlace(root, {
            readBytes: async value => value === path ? new Uint8Array([1, 2, 3]) : null,
        }, new Map());
        expect(result.restored).toBe(2);
        expect(root.messages[0].content).toMatch(/^blobref:/);
        expect(root.messages[0].content).toBe(root.gallery[0].url);
        const blobId = root.messages[0].content.slice('blobref:'.length);
        expect(await DB.getBlobAsset(blobId)).toBeInstanceOf(Blob);
    });

    it('clears missing references instead of exporting a dead local id', async () => {
        const root = { content: blobRefFromId('missing') };
        const stats = await externalizeBlobRefsInPlace(root, { hasPath: () => false, writeBytes: () => undefined }, new Map());
        expect(stats.missing).toBe(1);
        expect(root.content).toBe('');
    });
});