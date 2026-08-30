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

export const augmentImageToolSchema = (schema: any, toolName?: string): any => {
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
        output.properties.use_character_reference = {
            type: 'boolean',
            default: true,
            description: '本次是否使用当前角色已开启的精密参考图。角色不在画面、只画用户或参考图会妨碍当前构图时设为 false。',
        };
        output.properties.use_user_reference = {
            type: 'boolean',
            default: true,
            description: '本次是否使用用户已开启的精密参考图。用户不在画面、只画角色或参考图会妨碍当前构图时设为 false。',
        };
    }
    return output;
};
