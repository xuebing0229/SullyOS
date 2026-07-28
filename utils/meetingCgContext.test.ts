import { describe, expect, it } from 'vitest';
import { buildMeetingCgRecentContext } from './meetingCgContext';

describe('meeting CG recent context', () => {
    it('keeps only user/assistant safe text', () => {
        const result = buildMeetingCgRecentContext([
            { role: 'system', content: 'hidden system' },
            { role: 'user', content: '今天下雨了' },
            { role: 'assistant', content: '那就靠近一点。' },
        ] as any, {
            userName: '小明',
            characterName: '祁连云',
        });
        expect(result).toEqual([
            '小明: 今天下雨了',
            '祁连云: 那就靠近一点。',
        ]);
    });

    it('replaces image resources and uses voice transcript', () => {
        const result = buildMeetingCgRecentContext([
            { role: 'user', type: 'image', content: 'blobref:abc' },
            {
                role: 'assistant',
                type: 'voice',
                content: 'data:audio/xxx',
                metadata: { transcript: '我听见了。' },
            },
        ] as any, {
            userName: '用户',
            characterName: '角色',
        });
        expect(result).toEqual([
            '用户: [图片]',
            '角色: 我听见了。',
        ]);
    });

    it('limits message and total length', () => {
        const result = buildMeetingCgRecentContext([
            { role: 'user', content: 'a'.repeat(500) },
            { role: 'assistant', content: 'b'.repeat(500) },
            { role: 'user', content: 'c'.repeat(500) },
            { role: 'assistant', content: 'd'.repeat(500) },
        ] as any, {
            userName: 'U',
            characterName: 'C',
            maxMessages: 3,
            maxCharsPerMessage: 300,
            maxTotalChars: 700,
        });
        expect(result).toHaveLength(3);
        expect(result.join('').length).toBeLessThan(730);
    });
});
