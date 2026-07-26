import type { CharacterProfile, UserProfile } from '../types';

const PROFILE_TEXT_LIMIT = 4000;
const PREVIOUS_INJECTION_LIMIT = 5000;
const STRUCTURED_VALUE_LIMIT = 300;

type ExtendedUserProfile = UserProfile & Record<string, unknown>;

const STRUCTURED_IDENTITY_FIELDS = [
    { label: '结构化性别', keys: ['gender', 'sex', 'selfGender'] },
    {
        label: '结构化称谓/代词',
        keys: [
            'pronoun',
            'pronouns',
            'preferredPronoun',
            'preferredPronouns',
            'preferredAddress',
        ],
    },
] as const;

function normalizeText(value: unknown, maxLength: number): string {
    if (typeof value === 'string') {
        return value.replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
    }

    if (Array.isArray(value)) {
        return value
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
            .join(' / ')
            .slice(0, maxLength);
    }

    return '';
}

function collectStructuredIdentityHints(userProfile: UserProfile): string[] {
    const profile = userProfile as ExtendedUserProfile;
    const hints: string[] = [];

    for (const field of STRUCTURED_IDENTITY_FIELDS) {
        for (const key of field.keys) {
            const value = normalizeText(profile[key], STRUCTURED_VALUE_LIMIT);
            if (!value) continue;

            hints.push(`${field.label}（${key}）：${value}`);
            break;
        }
    }

    return hints;
}

/**
 * 为情绪副 API 构建用户身份与称谓上下文。
 *
 * 这里不在代码里把用户固定成“他”或“她”，也不靠姓名/头像猜性别。
 * 模型每轮都读取当前 UserProfile.bio；如果未来某个分支给 UserProfile
 * 增加 gender / pronouns 等结构化字段，本函数也会自动把它们一并送入提示词。
 *
 * char.buffInjection 会作为“旧状态待校验文本”提供给模型。它只能用于延续情绪，
 * 不能反过来作为用户身份依据；因此旧版本留下的错误称谓可以在下一次评估中
 * 被非破坏性地重写，而不需要清空全部 Buff。
 */
export function buildEmotionUserReferenceSection(
    userProfile: UserProfile,
    char: Pick<CharacterProfile, 'activeBuffs' | 'buffInjection'>,
): string {
    const userName = normalizeText(userProfile.name, 200) || '未命名用户';
    const userBio = normalizeText(userProfile.bio, PROFILE_TEXT_LIMIT);
    const structuredHints = collectStructuredIdentityHints(userProfile);
    const previousInjection = normalizeText(
        char.buffInjection,
        PREVIOUS_INJECTION_LIMIT,
    );

    const structuredSection = structuredHints.length > 0
        ? structuredHints.join('\n')
        : '当前没有独立的结构化性别/代词字段；请读取用户档案原文与当前对话中的明确自我说明。';

    return `## 当前用户身份与称谓依据（最高优先级）
用户姓名：${userName}
${structuredSection}

--- 用户档案原文开始 ---
${userBio || '（用户未填写档案正文）'}
--- 用户档案原文结束 ---

### 称谓规则
1. 只依据上述当前用户档案中的明确自我设定、明确称谓/代词，以及当前对话中用户对自己的明确说明。
2. 档案若给出偏好的称谓或代词，原样遵守；若只给出性别，使用与该设定一致的自然中文第三人称。
3. 不得根据姓名、头像、说话方式、关系类型、角色性别、统计印象或下面的输出示例猜测用户性别。
4. 信息不明确或彼此冲突时，使用「ta」「对方」或用户姓名，不得擅自选用「他」或「她」。
5. 当前Buff、旧injection、旧innerState可能含历史版本留下的错误称谓；它们不是用户身份依据。
6. buffs[].description、injection、innerState 等最终 JSON 叙事字段中，绝对禁止使用「用户」「User」「the user」称呼本人；这些词只允许出现在本提示词的字段说明中。
7. 最终叙事优先使用当前用户姓名「${userName}」；角色已有自然称呼时可沿用该称呼；不适合直呼姓名时使用「ta」或「对方」。

## 上一轮情绪注入（仅用于延续状态与检查称谓）
${previousInjection || '（当前没有旧的情绪注入）'}

### 称谓纠错要求
- 如果旧Buff描述或旧injection中的用户称谓与当前用户档案冲突，即使情绪本身没有变化，本轮也必须返回 "changed": true，并重写称谓正确的 buffs、injection 和 innerState。
- 只修正称谓时，不要无故改变情绪种类、强度、时间线或事实。
- 输出示例里的「ta」只是中性占位符，不代表当前用户的真实称谓。
- 输出前逐项检查 buffs[].description、injection、innerState：不得把系统内部身份标签「用户 / User / the user」原样写入任何叙事文本。`;
}
