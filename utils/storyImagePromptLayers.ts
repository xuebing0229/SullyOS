export interface StoryImagePromptLayers {
    character?: string;
    user?: string;
    style?: string;
    negative?: string;
}

export type StoryImageEngineId = 'gpt-image' | 'novelai';

const POSITIVE_PROMPT_KEYS = ['prompt', 'positive_prompt', 'positivePrompt'] as const;
const NEGATIVE_PROMPT_KEYS = [
    'negative_prompt',
    'negativePrompt',
    'uc',
    'undesired_content',
    'undesiredContent',
    'negative',
] as const;

const compact = (value: unknown): string =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const clone = <T>(value: T): T => {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
};

const joinPromptFragments = (...values: unknown[]): string => {
    const seen = new Set<string>();
    const fragments: string[] = [];
    for (const value of values) {
        const fragment = compact(value);
        if (!fragment || seen.has(fragment)) continue;
        seen.add(fragment);
        fragments.push(fragment);
    }
    return fragments.join(', ');
};

const resolveFieldKey = (
    parameters: Record<string, any> | undefined,
    args: Record<string, any>,
    candidates: readonly string[],
): string | undefined => {
    const properties = parameters?.properties;
    if (properties && typeof properties === 'object') {
        const schemaHit = candidates.find(key => Object.prototype.hasOwnProperty.call(properties, key));
        if (schemaHit) return schemaHit;
    }
    return candidates.find(key => Object.prototype.hasOwnProperty.call(args, key));
};

export const augmentStoryImagePlanningParameters = (
    parameters: Record<string, any> | undefined,
): Record<string, any> => {
    const output = clone(parameters || { type: 'object', properties: {} });
    if (!output.properties || typeof output.properties !== 'object') output.properties = {};

    output.properties.story_include_character = {
        type: 'boolean',
        description: '剧情剧场客户端专用，不会发给生图服务。本轮最终画面里主角色本人是否真实入镜。只根据选中的具体画面判断；不入镜必须填 false。',
    };
    output.properties.story_include_user = {
        type: 'boolean',
        description: '剧情剧场客户端专用，不会发给生图服务。本轮最终画面里用户本人是否真实入镜。只根据选中的具体画面判断；不入镜必须填 false。',
    };
    output.properties.story_character_dynamic_prompt = {
        type: 'string',
        description: '剧情剧场客户端专用，不会直接发给生图服务。仅当主角色入镜时填写本轮变化内容：动作、表情、姿势、画面位置、临时服装/状态；不要重复固定外貌提示词、画风或负面词。不入镜时填空字符串。',
    };
    output.properties.story_user_dynamic_prompt = {
        type: 'string',
        description: '剧情剧场客户端专用，不会直接发给生图服务。仅当用户入镜时填写本轮变化内容：动作、表情、姿势、画面位置、临时服装/状态；不要重复固定外貌提示词、画风或负面词。不入镜时填空字符串。',
    };

    const required = Array.isArray(output.required) ? [...output.required] : [];
    for (const key of [
        'story_include_character',
        'story_include_user',
        'story_character_dynamic_prompt',
        'story_user_dynamic_prompt',
    ]) {
        if (!required.includes(key)) required.push(key);
    }
    output.required = required;

    const promptKey = resolveFieldKey(output, {}, POSITIVE_PROMPT_KEYS);
    const prompt = promptKey ? output.properties[promptKey] : undefined;
    if (prompt && typeof prompt === 'object' && !Array.isArray(prompt)) {
        const original = compact(prompt.description);
        prompt.description = [
            original,
            '【剧情剧场特殊协议，优先于通用多人物提示词说明】这里只写本轮可变的基础画面：场景、镜头、构图、光线、整体互动与环境。不要在这里复述角色固定外貌、用户固定外貌、固定画风或固定负面词；客户端会在执行前按实际入镜者确定性合并这些固定层。',
        ].filter(Boolean).join(' ');
    }

    const negativeKey = resolveFieldKey(output, {}, NEGATIVE_PROMPT_KEYS);
    const negative = negativeKey ? output.properties[negativeKey] : undefined;
    if (negative && typeof negative === 'object' && !Array.isArray(negative)) {
        const original = compact(negative.description);
        negative.description = [
            original,
            '这里只补充本轮临时需要规避的内容，不要复述文游设置里的固定负面词；客户端会自动合并固定负面词。',
        ].filter(Boolean).join(' ');
    }

    return output;
};

export const composeStoryImagePromptArguments = (input: {
    args: Record<string, any>;
    parameters?: Record<string, any>;
    layers?: StoryImagePromptLayers;
    engineId: StoryImageEngineId;
    toolName: string;
}): {
    arguments: Record<string, any>;
    presence?: { character: boolean; user: boolean };
} => {
    const source = { ...(input.args || {}) };
    const hasPresenceSelectors =
        typeof source.story_include_character === 'boolean'
        || typeof source.story_include_user === 'boolean';

    // 已经在队列里的旧剧情任务没有这两个字段，继续按旧参数原样执行，
    // 避免升级后篡改尚未提交的历史 inline plan。
    if (!hasPresenceSelectors) {
        return { arguments: source };
    }

    const includeCharacter = source.story_include_character === true;
    const includeUser = source.story_include_user === true;
    const characterDynamic = compact(source.story_character_dynamic_prompt);
    const userDynamic = compact(source.story_user_dynamic_prompt);

    delete source.story_include_character;
    delete source.story_include_user;
    delete source.story_character_dynamic_prompt;
    delete source.story_user_dynamic_prompt;

    const layers = input.layers || {};
    const fixedCharacter = compact(layers.character);
    const fixedUser = compact(layers.user);
    const fixedStyle = compact(layers.style);
    const fixedNegative = compact(layers.negative);

    const promptKey =
        resolveFieldKey(input.parameters, source, POSITIVE_PROMPT_KEYS)
        || 'prompt';
    const scenePrompt = compact(source[promptKey]);
    if (!scenePrompt) {
        throw new Error('剧情配图规划器没有返回场景/动作 prompt；已阻止只靠固定人物提示词盲生成');
    }
    const characterPrompt = joinPromptFragments(fixedCharacter, characterDynamic);
    const userPrompt = joinPromptFragments(fixedUser, userDynamic);

    if (input.engineId === 'novelai' && includeCharacter && includeUser) {
        // NovelAI V4+ has a real multi-character channel. Do not emulate it with
        // pipe-separated text inside base_caption: that can be interpreted as a
        // repeated/mirrored composition instead of two isolated identities.
        source[promptKey] = joinPromptFragments(
            scenePrompt,
            fixedStyle,
            'exactly two people, two distinct people, single scene, asymmetric composition',
        );
        source.character_prompts = [
            characterPrompt || 'person',
            userPrompt || 'person',
        ];
    } else if (input.engineId === 'gpt-image' && includeCharacter && includeUser) {
        source[promptKey] = joinPromptFragments(
            scenePrompt,
            fixedStyle,
            characterPrompt ? `character: ${characterPrompt}` : '',
            userPrompt ? `user: ${userPrompt}` : '',
        );
    } else {
        source[promptKey] = joinPromptFragments(
            scenePrompt,
            includeCharacter ? characterPrompt : '',
            includeUser ? userPrompt : '',
            fixedStyle,
        );
    }

    const negativeKey = resolveFieldKey(input.parameters, source, NEGATIVE_PROMPT_KEYS);
    const novelAiTwoPersonNegative = input.engineId === 'novelai' && includeCharacter && includeUser
        ? 'duplicate characters, cloned characters, mirrored duplicate, multiple views'
        : '';
    const mergedNegative = joinPromptFragments(fixedNegative, novelAiTwoPersonNegative);
    if (mergedNegative) {
        if (negativeKey) {
            source[negativeKey] = joinPromptFragments(source[negativeKey], mergedNegative);
        } else {
            // 部分引擎没有独立负面字段；仍保留固定层，但以明确 avoid 约束并入正向提示。
            source[promptKey] = joinPromptFragments(source[promptKey], `avoid: ${mergedNegative}`);
        }
    }

    if (input.toolName === 'novelai_generate_image') {
        // 没入镜的人绝不能偷偷通过 Precise Reference 污染画面。
        if (!includeCharacter) source.use_character_reference = false;
        if (!includeUser) source.use_user_reference = false;
    }

    return {
        arguments: source,
        presence: { character: includeCharacter, user: includeUser },
    };
};
