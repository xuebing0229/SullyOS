export interface StoryImagePlannerJsonSelection {
    tool: string;
    arguments: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseArguments = (value: unknown): Record<string, unknown> | null => {
    if (isRecord(value)) return { ...value };
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? { ...parsed } : null;
    } catch {
        return null;
    }
};

const looksLikeDirectImageArguments = (value: Record<string, unknown>): boolean => {
    const likelyKeys = new Set([
        'prompt',
        'positive_prompt',
        'negative_prompt',
        'width',
        'height',
        'size',
        'model',
        'steps',
        'scale',
        'cfg_scale',
        'sampler',
        'seed',
        'use_character_reference',
        'use_user_reference',
        'use_vibe_reference',
        'story_reference_actor_id',
    ]);
    return Object.keys(value).some(key => likelyKeys.has(key));
};

/**
 * OpenAI-compatible gateways sometimes accept tools/tool_choice yet return the selected
 * call as ordinary JSON in message.content. Explicit known tool names are preferred.
 * When there is exactly one available image tool, also accept arguments-only JSON so
 * Gemini/OpenAI-compatible gateways cannot make regeneration fail merely by omitting the
 * function-call envelope.
 */
export const extractStoryImagePlannerJsonSelection = (
    content: string,
    allowedToolNames: Iterable<string>,
): StoryImagePlannerJsonSelection | null => {
    const allowed = new Set(Array.from(allowedToolNames, name => String(name || '').trim()).filter(Boolean));
    if (!allowed.size) return null;

    const clean = String(content || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    if (!clean) return null;

    const first = clean.indexOf('{');
    const last = clean.lastIndexOf('}');
    if (first < 0 || last <= first) return null;

    let raw: Record<string, unknown>;
    try {
        const parsed = JSON.parse(clean.slice(first, last + 1));
        if (!isRecord(parsed)) return null;
        raw = parsed;
    } catch {
        return null;
    }

    const fn = isRecord(raw.function) ? raw.function : undefined;
    const explicitTool = String(raw.tool || raw.tool_name || raw.name || fn?.name || '').trim();
    if (explicitTool) {
        if (!allowed.has(explicitTool)) return null;
        const args = parseArguments(raw.arguments ?? raw.args ?? raw.input ?? raw.parameters ?? fn?.arguments);
        return args ? { tool: explicitTool, arguments: args } : null;
    }

    if (allowed.size !== 1) return null;
    const soleTool = Array.from(allowed)[0];
    const wrappedArgs = parseArguments(raw.arguments ?? raw.args ?? raw.input ?? raw.parameters ?? fn?.arguments);
    if (wrappedArgs) return { tool: soleTool, arguments: wrappedArgs };
    if (looksLikeDirectImageArguments(raw)) return { tool: soleTool, arguments: { ...raw } };
    return null;
};