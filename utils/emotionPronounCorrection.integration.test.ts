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
});
