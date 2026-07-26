import { describe, expect, it } from 'vitest';
import {
    MAX_EMOJI_IMPORT_FILES,
    MAX_EMOJI_IMPORT_BATCH_BYTES,
    MAX_EMOJI_IMPORT_GIFS,
    allocateUniqueEmojiName,
    inferEmojiMime,
    limitEmojiImportBatch,
    makePendingEmojiImport,
    normalizeEmojiName,
    suggestEmojiName,
    validateEmojiFile,
} from './emojiImport';

describe('emojiImport helpers', () => {
    it('Android 文件选择器 MIME 为空时按扩展名识别', () => {
        expect(inferEmojiMime({ name: '贴贴.webp', type: '' })).toBe('image/webp');
        expect(inferEmojiMime({ name: '动图.GIF', type: '' })).toBe('image/gif');
    });


    it('Android 泛化 MIME 会按扩展名回退', () => {
        expect(inferEmojiMime({ name: '贴贴.png', type: 'application/octet-stream' })).toBe('image/png');
        expect(inferEmojiMime({ name: '动图.gif', type: 'image/*' })).toBe('image/gif');
    });

    it('批次同时限制总大小和 GIF 数量', () => {
        const gifs = Array.from({ length: MAX_EMOJI_IMPORT_GIFS + 2 }, (_, index) => ({
            name: `${index}.gif`, type: 'image/gif', size: 1024,
        } as File));
        const gifResult = limitEmojiImportBatch(gifs);
        expect(gifResult.accepted).toHaveLength(MAX_EMOJI_IMPORT_GIFS);

        const tooLarge = [{ name: 'large.png', type: 'image/png', size: MAX_EMOJI_IMPORT_BATCH_BYTES + 1 } as File];
        expect(limitEmojiImportBatch(tooLarge).accepted).toHaveLength(0);
    });

    it('从文件名生成默认名称，之后仍可在预览页修改', () => {
        expect(suggestEmojiName('cat_angry-face.png')).toBe('cat angry face');
        const draft = makePendingEmojiImport(
            { suggestedName: 'cat angry face', blob: new Blob(['x'], { type: 'image/png' }), previewUrl: 'blob:test', byteSize: 1, isAnimatedGif: false },
            'cat_angry-face.png',
            'draft-1',
        );
        expect(draft.name).toBe('cat angry face');
        expect(draft.originalFileName).toBe('cat_angry-face.png');
    });

    it('规范化用户当场输入的名称', () => {
        expect(normalizeEmojiName('  偷偷   看你  ')).toBe('偷偷 看你');
    });

    it('同名表情不会覆盖，保存时自动追加序号', () => {
        const occupied = new Set(['摸摸', '摸摸 (2)']);
        expect(allocateUniqueEmojiName('摸摸', occupied)).toBe('摸摸 (3)');
    });

    it('拒绝 SVG 和过大的 GIF', () => {
        expect(() => validateEmojiFile({
            name: 'unsafe.svg',
            type: 'image/svg+xml',
            size: 1024,
        })).toThrow(/不支持 SVG/);

        expect(() => validateEmojiFile({
            name: 'huge.gif',
            type: 'image/gif',
            size: 7 * 1024 * 1024,
        })).toThrow(/GIF 超过 6MB/);
    });

    it('30 张限制是当前待确认批次，不是总库存', () => {
        const files = Array.from(
            { length: 10 },
            (_, index) => ({ name: `${index}.png` } as File),
        );
        const result = limitEmojiImportBatch(files, MAX_EMOJI_IMPORT_FILES - 4);
        expect(result.accepted).toHaveLength(4);
        expect(result.ignoredCount).toBe(6);
    });
});
