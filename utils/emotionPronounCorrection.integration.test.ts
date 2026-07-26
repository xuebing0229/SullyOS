import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';

const saveCharacter = vi.fn(async (_char: CharacterProfile) => {});

vi.mock('./db', () => ({
    DB: {
        saveCharacter: (char: CharacterProfile) => saveCharacter(char),
    },
}));

import { applyEmotionEvalRaw, parseEmotionEvalOutput } from './emotionApply';
import { buildEmotionUserReferenceSection } from './emotionUserReference';

const existingBuff = {
    id: 'buff_waiting',
    name: 'waiting_anxiety',
    label: '等待中的焦虑',
    intensity: 2 as const,
    emoji: '⏳',
    color: '#f59e0b',
    description: '已经等了两小时，担心她是不是遇到了麻烦。',
};

const char = {
    id: 'char-pronoun-integration',
    name: '测试角色',
    activeBuffs: [existingBuff],
    buffInjection: '### [当前情绪底色]\n已经等了两小时，情绪维持在中等焦虑。她一直没有回复。',
} as CharacterProfile;

const maleProfile = {
    name: '测试用户',
    avatar: '',
    bio: '性别：男性\n第三人称请使用「他」。',
} as UserProfile;

beforeEach(() => {
    saveCharacter.mockClear();
});

describe('情绪称谓纠错集成链路', () => {
    it('档案改为男性后要求 changed=true，并在落库时只纠正称谓、保留原情绪和时间线', async () => {
        const promptSection = buildEmotionUserReferenceSection(maleProfile, char);

        expect(promptSection).toContain('性别：男性');
        expect(promptSection).toContain('她一直没有回复');
        expect(promptSection).toContain('本轮也必须返回 "changed": true');
        expect(promptSection).toContain('不要无故改变情绪种类、强度、时间线或事实');

        // 模拟情绪副 API 遵循上述提示：情绪没有变化，只把历史女性称谓纠正为男性称谓。
        const evalRaw = JSON.stringify({
            changed: true,
            buffs: [{
                ...existingBuff,
                description: '已经等了两小时，担心他是不是遇到了麻烦。',
            }],
            injection: '### [当前情绪底色]\n已经等了两小时，情绪维持在中等焦虑。他一直没有回复。',
            innerState: '情绪还是原来的程度，只是该按他的当前档案来称呼。',
        });

        expect(parseEmotionEvalOutput(evalRaw)?.changed).toBe(true);

        const innerState = await applyEmotionEvalRaw(evalRaw, char);

        expect(innerState).toContain('他的当前档案');
        expect(saveCharacter).toHaveBeenCalledTimes(1);

        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs).toHaveLength(1);
        expect(saved.activeBuffs?.[0]).toMatchObject({
            id: existingBuff.id,
            name: existingBuff.name,
            label: existingBuff.label,
            intensity: existingBuff.intensity,
            emoji: existingBuff.emoji,
            color: existingBuff.color,
            description: '已经等了两小时，担心他是不是遇到了麻烦。',
        });
        expect(saved.buffInjection).toContain('已经等了两小时');
        expect(saved.buffInjection).toContain('中等焦虑');
        expect(saved.buffInjection).toContain('他一直没有回复');
        expect(saved.buffInjection).not.toContain('她一直没有回复');
    });

    it('落库前将叙事中的内部“用户”标签替换为当前用户名', async () => {
        const evalRaw = JSON.stringify({
            changed: true,
            buffs: [{
                id: 'buff_internal_label',
                name: 'noticed',
                label: '被夸奖后的触动',
                intensity: 2,
                description: '用户说她很漂亮，User 似乎很认真。',
            }],
            injection: 'the user 的夸奖让她有些动摇，用户还在等回应。',
            innerState: '用户说她很漂亮，我该怎么回答 the user？',
        });

        const innerState = await applyEmotionEvalRaw(evalRaw, char, maleProfile.name);
        const saved = saveCharacter.mock.calls[0][0];

        expect(saved.activeBuffs?.[0].description).toBe('测试用户说她很漂亮，测试用户似乎很认真。');
        expect(saved.buffInjection).toBe('测试用户的夸奖让她有些动摇，测试用户还在等回应。');
        expect(innerState).toBe('测试用户说她很漂亮，我该怎么回答 测试用户？');
    });

    it('姓名为空时回退“对方”，自然称呼与普通产品词组保持不变', async () => {
        const evalRaw = JSON.stringify({
            changed: true,
            buffs: [{
                id: 'buff_natural_reference',
                name: 'steady',
                label: '平稳',
                intensity: 1,
                description: 'ta没有离开，对方也没有生气；用户体验和用户设置保持原样。',
            }],
            injection: '已经叫了名字，ta和对方都不需要修改。',
            innerState: '用户说会留下。',
        });

        const innerState = await applyEmotionEvalRaw(evalRaw, char, '   ');
        const saved = saveCharacter.mock.calls[0][0];

        expect(saved.activeBuffs?.[0].description).toBe('ta没有离开，对方也没有生气；用户体验和用户设置保持原样。');
        expect(saved.buffInjection).toBe('已经叫了名字，ta和对方都不需要修改。');
        expect(innerState).toBe('对方说会留下。');
    });

});
