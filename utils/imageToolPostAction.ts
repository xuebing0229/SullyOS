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
    'NovelAI V4+ 多人物画面需要隔离人物特征：当画面中有两个或以上需要区分外观的人物（包括用户）时，prompt 必须使用多角色提示词语法“基础场景 | 角色1 | 角色2 ...”。基础段只写人数、场景、构图、画风和共享动作，不要放任何角色独占的发色、眼色、异瞳、年龄或服装特征；每个角色段只写该角色自己的外观、服装、动作与位置，并按画面从上到下、从左到右排列。严禁把一个角色的眼睛/头发等身份特征复制到另一个角色段。单人画面不要为了凑格式使用多角色分段。';

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
            description: '本次是否使用当前角色已开启的精密参考图。单人画面可按需使用；多人画面若 prompt 使用“基础场景 | 角色1 | 角色2 ...”多角色分段，必须设为 false，避免 Precise Reference 把身份特征扩散到其他人物。',
        };
        output.properties.use_user_reference = {
            type: 'boolean',
            default: true,
            description: '本次是否使用用户已开启的精密参考图。单人画面可按需使用；多人画面若 prompt 使用“基础场景 | 角色1 | 角色2 ...”多角色分段，必须设为 false，避免 Precise Reference 把身份特征扩散到其他人物。',
        };
    }
    return output;
};
