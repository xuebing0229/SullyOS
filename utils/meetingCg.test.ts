import { describe, expect, it } from 'vitest';
import { getMeetingCgButtonLabel, makeMeetingCgBackground } from './meetingCg';

describe('meeting CG asset helpers', () => {
    it('uses CG-specific button labels', () => {
        expect(getMeetingCgButtonLabel(false, false)).toBe('生成 CG');
        expect(getMeetingCgButtonLabel(true, false)).toBe('重绘 CG');
        expect(getMeetingCgButtonLabel(true, true)).toBe('生成中…');
    });

    it('creates an independent planner asset without chat-message dependency', () => {
        const asset = makeMeetingCgBackground({
            id: 'cg-1',
            imageUrl: 'blobref:cg-blob',
            galleryImageId: 'gallery-1',
            engine: 'novelai',
            source: 'date-cg-planner',
            promptSummary: '咖啡馆当前场景',
            createdAt: 123,
        });
        expect(asset).toMatchObject({
            id: 'cg-1',
            imageUrl: 'blobref:cg-blob',
            galleryImageId: 'gallery-1',
            engine: 'novelai',
            source: 'date-cg-planner',
            createdAt: 123,
        });
        expect(asset.imageMessageId).toBeUndefined();
    });

    it('keeps old image-message snapshots readable but marks them legacy', () => {
        const legacy = makeMeetingCgBackground({
            imageUrl: 'blobref:old',
            imageMessageId: 7,
            engine: 'gpt',
            createdAt: 456,
        });
        expect(legacy.source).toBe('legacy-meeting-cg');
        expect(legacy.imageMessageId).toBe(7);
    });
});
