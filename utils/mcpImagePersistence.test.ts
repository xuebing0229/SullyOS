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

    it('stores a meeting CG as blob plus gallery without creating a chat message', async () => {
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
        const result = await persistMcpGeneratedImages({
            result: { success: true, images: [{ data: png, mimeType: 'image/png' }], data: {} },
            char: { id: 'char-1', name: '角色' } as any,
            server: { id: 'srv', name: 'GPT 生图' },
            toolName: 'generate_image',
            toolArgs: { prompt: '线下剧情 CG' },
            recentMessages: [
                { id: 1, charId: 'char-1', role: 'user', type: 'text', content: '线下当前对话', timestamp: 1 },
            ] as any,
            ownerType: 'meeting-cg',
            allowTemporaryUrlFallback: false,
            extraGallerySourceMeta: { meetingCgGenerated: true },
        });

        expect(result.persisted).toBe(1);
        expect(result.assets).toHaveLength(1);
        expect(await DB.getMessagesByCharId('char-1')).toHaveLength(0);
        const gallery = await DB.getGalleryImages('char-1');
        expect(gallery).toHaveLength(1);
        expect(gallery[0].url).toBe(result.assets[0].blobRef);
        expect(gallery[0].chatContext).toEqual(['用户：线下当前对话']);
        expect(gallery[0].sourceMeta).toMatchObject({ meetingCgGenerated: true });
        const blobId = result.assets[0].blobRef.slice('blobref:'.length);
        expect(await DB.getBlobAsset(blobId)).toBeInstanceOf(Blob);
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

    it('commits review replacement and deletion without dropping gallery metadata', async () => {
        const original = {
            id: 'gallery-review-1',
            charId: 'char-1',
            url: 'blobref:shared-review-image',
            timestamp: 100,
            review: '旧点评',
            reviewTimestamp: 200,
            savedDate: '2026-07-27',
            chatContext: ['保留这段聊天'],
            source: 'mcp-generated' as const,
            sourceMeta: {
                serverId: 'srv',
                serverName: 'NovelAI',
                toolName: 'generate_image',
                prompt: '保留提示词',
            },
        };
        await DB.saveGalleryImage(original);

        await DB.updateGalleryImageReview(original.id, '  新点评  ');
        const replaced = (await DB.getGalleryImages('char-1'))[0];
        expect(replaced.review).toBe('新点评');
        expect(replaced.reviewTimestamp).toBeTypeOf('number');
        expect(replaced.chatContext).toEqual(original.chatContext);
        expect(replaced.savedDate).toBe(original.savedDate);
        expect(replaced.sourceMeta).toEqual(original.sourceMeta);

        await DB.updateGalleryImageReview(original.id, null);
        const deleted = (await DB.getGalleryImages('char-1'))[0];
        expect('review' in deleted).toBe(false);
        expect('reviewTimestamp' in deleted).toBe(false);
        expect(deleted.url).toBe(original.url);
        expect(deleted.chatContext).toEqual(original.chatContext);
        expect(deleted.savedDate).toBe(original.savedDate);
        expect(deleted.sourceMeta).toEqual(original.sourceMeta);
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
