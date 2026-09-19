export type AfterGenerateAction = 'none' | 'inspect';

export interface ParsedImageToolClientOptions {
    afterGenerateAction: AfterGenerateAction;
    cleanedArgs: Record<string, any>;
}

export const parseImageToolClientOptions = (
    args: Record<string, any>,
): ParsedImageToolClientOptions => {
    const raw = String(
        args?.after_generate_action
        ?? args?.afterGenerateAction
        ?? 'none',
    ).trim().toLowerCase();
    const cleanedArgs = { ...(args || {}) };
    delete cleanedArgs.after_generate_action;
    delete cleanedArgs.afterGenerateAction;
    return {
        afterGenerateAction: raw === 'inspect' ? 'inspect' : 'none',
        cleanedArgs,
    };
};

const cloneSchema = (schema: any): any => {
    try {
        return structuredClone(schema);
    } catch {
        return JSON.parse(JSON.stringify(schema));
    }
};

const NOVEL_AI_MULTI_CHARACTER_PROMPT_GUIDANCE =
    'NovelAI V4+ 多人物画面应使用原生 character_prompts（如果当前工具 schema 提供该字段）隔离人物特征：prompt/base 只写人数、场景、构图、画风和共享互动；character_prompts 按画面从上到下、从左到右分别写每个人自己的外观、服装、动作与位置。不要用“基础场景 | 角色1 | 角色2”这种竖线文本模拟多角色提示词，它仍会落进 base prompt，可能诱发重复/镜像人物。严禁把一个角色的眼睛、头发等身份特征复制到另一个角色 prompt。单人画面保持普通 prompt。';

export const augmentImageToolSchema = (
    schema: any,
    toolName?: string,
    options: { allowCharacterReference?: boolean } = {},
): any => {
    const output = schema && typeof schema === 'object'
        ? cloneSchema(schema)
        : { type: 'object', properties: {} };
    if (!output.properties || typeof output.properties !== 'object') {
        output.properties = {};
    }
    output.properties.after_generate_action = {
        type: 'string',
        enum: ['none', 'inspect'],
        default: 'none',
        description: '客户端专用可选字段。none：最终图片生成后直接结束；inspect：最终图片生成后，客户端会再把真实图片交给你看，让你用角色语气自然回应一句。普通生图应优先选择 none。',
    };
    if (toolName === 'novelai_generate_image') {
        const prompt = output.properties.prompt;
        if (prompt && typeof prompt === 'object' && !Array.isArray(prompt)) {
            const original = typeof prompt.description === 'string'
                ? prompt.description.trim()
                : '';
            prompt.description = [original, NOVEL_AI_MULTI_CHARACTER_PROMPT_GUIDANCE]
                .filter(Boolean)
                .join(' ');
        }
    }
    if (toolName === 'novelai_generate_image' && options.allowCharacterReference !== false) {
        // “角色参考”预设开关控制的是整类 NovelAI Precise Reference 能力：
        // 当前角色参考图和用户参考图只是两个来源，必须一起显示/一起禁用。
        output.properties.use_character_reference = {
            type: 'boolean',
            default: true,
            description: '本次是否使用当前角色已开启的精密参考图。单人画面可按需使用；多人画面使用原生 character_prompts 时应设为 false，避免 Precise Reference 把身份特征扩散到其他人物。',
        };
        output.properties.use_user_reference = {
            type: 'boolean',
            default: true,
            description: '本次是否使用用户已开启的精密参考图。单人画面可按需使用；多人画面使用原生 character_prompts 时应设为 false，避免 Precise Reference 把身份特征扩散到其他人物。',
        };
    }
    return output;
};
