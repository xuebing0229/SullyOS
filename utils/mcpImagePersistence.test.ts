import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import { blobRefFromId } from './blobRef';
import { persistMcpGeneratedImages } from './mcpImagePersistence';

describe('MCP generated image persistence', () => {
    beforeEach(async () => {
        localStorage.clear();
        await DB.deleteDB().catch(() => undefined);
    });

    it('atomically stores one shared blob, chat message and gallery record', async () => {
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
        const result = await persistMcpGeneratedImages({
            result: { success: true, images: [{ data: png, mimeType: 'image/png' }], data: {} },
            char: { id: 'char-1', name: '角色' } as any,
            server: { id: 'srv', name: 'GPT 生图' },
            toolName: 'generate_image',
            toolArgs: { prompt: '一只猫' },
        });
        expect(result.persisted).toBe(1);
        const messages = await DB.getMessagesByCharId('char-1');
        const gallery = await DB.getGalleryImages('char-1');
        expect(messages).toHaveLength(1);
        expect(gallery).toHaveLength(1);
        expect(messages[0].content).toBe(gallery[0].url);
        expect(messages[0].content).toMatch(/^blobref:/);
        const id = messages[0].content.slice('blobref:'.length);
        expect(await DB.getBlobAsset(id)).toBeInstanceOf(Blob);
    });

    it('deleting gallery record does not break chat blob reference', async () => {
        const id = 'img_shared_gallery';
        const ref = blobRefFromId(id);
        await DB.putBlobAsset(id, new Blob(['abc'], { type: 'image/png' }));
        const messageId = await DB.saveMessage({ charId: 'char-1', role: 'assistant', type: 'image', content: ref } as any);
        await DB.saveGalleryImage({ id: 'gallery-1', charId: 'char-1', url: ref, timestamp: Date.now() });
        await DB.deleteGalleryImage('gallery-1');
        expect((await DB.getMessagesByCharId('char-1')).some(m => m.id === messageId)).toBe(true);
        expect(await DB.getBlobAsset(id)).not.toBeNull();
    });

    it('deleting chat message does not break gallery blob reference', async () => {
        const id = 'img_shared_chat';
        const ref = blobRefFromId(id);
        await DB.putBlobAsset(id, new Blob(['abc'], { type: 'image/png' }));
        const messageId = await DB.saveMessage({ charId: 'char-1', role: 'assistant', type: 'image', content: ref } as any);
        await DB.saveGalleryImage({ id: 'gallery-1', charId: 'char-1', url: ref, timestamp: Date.now() });
        await DB.deleteMessage(messageId);
        expect((await DB.getGalleryImages('char-1'))[0].url).toBe(ref);
        expect(await DB.getBlobAsset(id)).not.toBeNull();
    });
});
