import { describe, expect, it } from 'vitest';
import type { CharacterProfile, GalleryImage, UserProfile } from '../types';
import {
    buildGalleryRecallHint,
    buildGallerySnapshotBlock,
} from './galleryReviewRequest';

const char = {
    id: 'c1',
    name: '阿云',
} as CharacterProfile;

const userProfile = {
    name: '小竹',
} as UserProfile;

const makeImage = (overrides: Partial<GalleryImage> = {}) => ({
    id: 'g1',
    charId: 'c1',
    url: 'blobref:x',
    timestamp: new Date('2026-07-25T12:00:00Z').getTime(),
    savedDate: '2026-07-25',
    ...overrides,
} as GalleryImage);

describe('gallery review historical snapshot', () => {
    it('marks the snapshot as historical and resolves legacy speaker names', () => {
        const block = buildGallerySnapshotBlock(
            makeImage({
                chatContext: [
                    '用户：你看这个',
                    '角色：我看到了',
                ],
            }),
            char,
            userProfile,
        );

        expect(block).toContain('过去的历史材料');
        expect(block).toContain('不是当前正在发生的对话');
        expect(block).toContain('小竹：你看这个');
        expect(block).toContain('阿云：我看到了');
        expect(block).toContain('2026-07-25');
    });

    it('returns null for old images without a saved chat context', () => {
        expect(buildGallerySnapshotBlock(
            makeImage({ chatContext: undefined }),
            char,
            userProfile,
        )).toBeNull();
    });

    it('keeps only the last twelve snapshot lines', () => {
        const chatContext = Array.from(
            { length: 15 },
            (_, index) => `用户：第${index + 1}行`,
        );
        const block = buildGallerySnapshotBlock(
            makeImage({ chatContext }),
            char,
            userProfile,
        )!;

        expect(block).not.toContain('第1行');
        expect(block).not.toContain('第3行');
        expect(block).toContain('第4行');
        expect(block).toContain('第15行');
    });

    it('clamps oversized lines and total snapshot content', () => {
        const chatContext = Array.from(
            { length: 12 },
            (_, index) => `用户：第${index + 1}行${'很长'.repeat(300)}`,
        );
        const block = buildGallerySnapshotBlock(
            makeImage({ chatContext }),
            char,
            userProfile,
        )!;

        expect(block).toContain('第1行');
        expect(block.length).toBeLessThan(4_700);
    });

    it('adds the historical snapshot to the memory recall hint', () => {
        const image = makeImage({
            chatContext: ['用户：我们刚从摩天轮下来'],
            sourceMeta: {
                promptSummary: '夜晚的游乐园合照',
            },
        } as any);
        const block = buildGallerySnapshotBlock(image, char, userProfile);
        const hint = buildGalleryRecallHint(image, block);

        expect(hint).toContain('相册里重新查看并点评一张旧照片');
        expect(hint).toContain('夜晚的游乐园合照');
        expect(hint).toContain('摩天轮');
        expect(hint).toContain('过去的历史材料');
    });
});