import { describe, expect, it } from 'vitest';
import type { GalleryImage } from '../types';
import {
    applyGalleryReview,
    buildRegeneratedReviewInstruction,
} from './galleryReview';

const base: GalleryImage = {
    id: 'img-1',
    charId: 'char-1',
    url: 'blobref:abc' as any,
    timestamp: 100,
    review: '旧点评',
    reviewTimestamp: 200,
    chatContext: ['保留这段聊天'],
};

describe('gallery review state', () => {
    it('writes a normalized review and timestamp', () => {
        const result = applyGalleryReview(base, '  新点评  ', 300);
        expect(result.review).toBe('新点评');
        expect(result.reviewTimestamp).toBe(300);
        expect(result.chatContext).toEqual(['保留这段聊天']);
    });

    it('removes only review fields', () => {
        const result = applyGalleryReview(base, null, 300);
        expect('review' in result).toBe(false);
        expect('reviewTimestamp' in result).toBe(false);
        expect(result.url).toBe(base.url);
        expect(result.chatContext).toEqual(['保留这段聊天']);
    });

    it('treats blank text as deletion', () => {
        const result = applyGalleryReview(base, '   ');
        expect(result.review).toBeUndefined();
        expect(result.reviewTimestamp).toBeUndefined();
    });

    it('asks regeneration to differ from the old comment', () => {
        const instruction = buildRegeneratedReviewInstruction('旧点评');
        expect(instruction).toContain('previous comment');
        expect(instruction).toContain('substantially different');
        expect(instruction).toContain('旧点评');
    });
});
