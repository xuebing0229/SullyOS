import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';

describe('emoji blob persistence', () => {
    beforeEach(async () => {
        localStorage.clear();
        await DB.deleteDB().catch(() => undefined);
    });

    it('waits for saveEmoji transaction completion', async () => {
        await DB.saveEmoji('链接表情', 'https://example.com/a.png', 'cat-a');
        expect(await DB.getEmojis()).toContainEqual({ name: '链接表情', url: 'https://example.com/a.png', categoryId: 'cat-a' });
    });

    it('stores blob and emoji blobref in one transaction', async () => {
        const blob = new Blob(['gif-data'], { type: 'image/gif' });
        const ref = await DB.saveEmojiBlob('本机动图', 'emoji_test', blob, 'cat-a');
        expect(ref).toBe('blobref:emoji_test');
        expect(await DB.getBlobAsset('emoji_test')).toBeInstanceOf(Blob);
        expect(await DB.getEmojis()).toContainEqual({ name: '本机动图', url: ref, categoryId: 'cat-a' });
    });
});
