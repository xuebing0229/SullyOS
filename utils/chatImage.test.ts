import { describe, expect, it } from 'vitest';
import {
    CHAT_IMAGE_MAX_EDGE,
    fitChatImageSize,
    isGifFile,
} from './chatImage';

describe('chatImage helpers', () => {
    it('通过 MIME 识别 GIF', () => {
        expect(isGifFile({ name: 'anything.bin', type: 'image/gif' } as File)).toBe(true);
    });

    it('Android MIME 为空时通过扩展名识别 GIF', () => {
        expect(isGifFile({ name: 'reaction.GIF', type: '' } as File)).toBe(true);
        expect(isGifFile({ name: 'photo.png', type: '' } as File)).toBe(false);
    });

    it('横图按最长边 600 等比缩放', () => {
        expect(fitChatImageSize(1200, 600)).toEqual({ width: 600, height: 300 });
    });

    it('竖图按最长边 600 等比缩放', () => {
        expect(fitChatImageSize(500, 1000)).toEqual({ width: 300, height: 600 });
    });

    it('小图不放大', () => {
        expect(fitChatImageSize(320, 240, CHAT_IMAGE_MAX_EDGE)).toEqual({ width: 320, height: 240 });
    });

    it('拒绝无效尺寸', () => {
        expect(() => fitChatImageSize(0, 100)).toThrow(/尺寸无效/);
    });
});
