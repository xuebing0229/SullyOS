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

export const augmentImageToolSchema = (schema: any): any => {
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
    return output;
};
