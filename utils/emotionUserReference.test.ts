import { describe, expect, it } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { buildEmotionUserReferenceSection } from './emotionUserReference';

const makeUser = (bio: string, extra: Record<string, unknown> = {}): UserProfile => ({
    name: '测试用户',
    avatar: '',
    bio,
    ...extra,
} as UserProfile);

const makeChar = (buffInjection = ''): Pick<CharacterProfile, 'activeBuffs' | 'buffInjection'> => ({
    activeBuffs: [],
    buffInjection,
});

describe('buildEmotionUserReferenceSection', () => {
    it('读取男性用户档案，但不把所有用户写死成男性', () => {
        const section = buildEmotionUserReferenceSection(
            makeUser('性别：男性\n请使用男性称谓。'),
            makeChar('她刚才沉默了很久，我有点担心。'),
        );

        expect(section).toContain('性别：男性');
        expect(section).toContain('她刚才沉默了很久');
        expect(section).toContain('本轮也必须返回 "changed": true');
        expect(section).toContain('不得擅自选用「他」或「她」');
    });

    it('读取女性或其他用户设定，而不是复用男性结果', () => {
        const section = buildEmotionUserReferenceSection(
            makeUser('我是女性，第三人称使用「她」。'),
            makeChar(),
        );

        expect(section).toContain('我是女性');
        expect(section).toContain('第三人称使用「她」');
        expect(section).not.toContain('固定使用「他」');
    });

    it('优先传递未来可能存在的结构化 pronouns 字段', () => {
        const section = buildEmotionUserReferenceSection(
            makeUser('档案正文没有重复写代词。', {
                preferredPronouns: 'they/them，中文使用ta',
            }),
            makeChar(),
        );

        expect(section).toContain('结构化称谓/代词（preferredPronouns）');
        expect(section).toContain('they/them，中文使用ta');
    });

    it('未填写身份时明确要求使用中性称谓而不是猜测', () => {
        const section = buildEmotionUserReferenceSection(
            makeUser(''),
            makeChar(),
        );

        expect(section).toContain('用户未填写档案正文');
        expect(section).toContain('使用「ta」「对方」或用户姓名');
        expect(section).toContain('不得根据姓名、头像、说话方式');
    });

    it('明确禁止把内部身份标签写入最终叙事字段', () => {
        const section = buildEmotionUserReferenceSection(
            makeUser('请自然称呼我。'),
            makeChar(),
        );

        expect(section).toContain('绝对禁止使用「用户」「User」「the user」称呼本人');
        expect(section).toContain('优先使用当前用户姓名「测试用户」');
        expect(section).toContain('不得把系统内部身份标签「用户 / User / the user」原样写入');
    });

    it('限制档案和旧 injection 长度，避免情绪请求意外膨胀', () => {
        const section = buildEmotionUserReferenceSection(
            makeUser('甲'.repeat(6000)),
            makeChar('乙'.repeat(7000)),
        );

        expect(section.length).toBeLessThan(11000);
        expect(section).toContain('甲'.repeat(100));
        expect(section).toContain('乙'.repeat(100));
    });
});
