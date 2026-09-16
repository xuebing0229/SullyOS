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
        'positivePrompt',
        'negative_prompt',
        'negativePrompt',
        'width',
        'height',
        'size',
        'model',
        'steps',
        'scale',
        'cfg_scale',
        'guidance',
        'guidance_scale',
        'sampler',
        'seed',
        'use_character_reference',
        'use_user_reference',
        'use_vibe_reference',
        'story_reference_actor_id',
    ]);
    return Object.keys(value).some(key => likelyKeys.has(key));
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findUniqueToolMention = (content: string, allowed: Set<string>): string | null => {
    const hits = Array.from(allowed).filter(name => {
        const escaped = escapeRegExp(name);
        return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(content);
    });
    return hits.length === 1 ? hits[0] : null;
};

const extractJsonCandidates = (content: string): unknown[] => {
    const out: unknown[] = [];
    const source = String(content || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    if (!source) return out;

    try {
        out.push(JSON.parse(source));
        return out;
    } catch {
        // Continue with balanced-object extraction for prose + JSON responses.
    }

    let start = -1;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const ch = source[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '{' || ch === '[') {
            if (depth === 0) start = index;
            depth += 1;
            continue;
        }
        if (ch !== '}' && ch !== ']') continue;
        if (depth <= 0) continue;
        depth -= 1;
        if (depth !== 0 || start < 0) continue;
        const candidate = source.slice(start, index + 1);
        start = -1;
        try { out.push(JSON.parse(candidate)); } catch { /* keep scanning */ }
    }
    return out;
};

const INLINE_TOOL_KEYS = new Set([
    'tool',
    'tool_name',
    'toolName',
    'name',
    'function_name',
    'functionName',
    'selected_tool',
    'selectedTool',
]);

const stripSelectionMetadata = (value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (INLINE_TOOL_KEYS.has(key)) continue;
        if (['type', 'id', 'call_id', 'callId'].includes(key)) continue;
        out[key] = child;
    }
    return out;
};

const directSelectionFromRecord = (
    raw: Record<string, unknown>,
    allowed: Set<string>,
): StoryImagePlannerJsonSelection | null => {
    const explicitTool = String(
        raw.tool
        || raw.tool_name
        || raw.toolName
        || raw.name
        || raw.function_name
        || raw.functionName
        || raw.selected_tool
        || raw.selectedTool
        || '',
    ).trim();
    if (!explicitTool || !allowed.has(explicitTool)) return null;

    const args = parseArguments(
        raw.arguments
        ?? raw.args
        ?? raw.input
        ?? raw.parameters
        ?? raw.params,
    );
    if (args) return { tool: explicitTool, arguments: args };

    const inlineArgs = stripSelectionMetadata(raw);
    return looksLikeDirectImageArguments(inlineArgs)
        ? { tool: explicitTool, arguments: inlineArgs }
        : null;
};

const selectionFromJsonValue = (
    value: unknown,
    allowed: Set<string>,
): StoryImagePlannerJsonSelection | null => {
    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = selectionFromJsonValue(item, allowed);
            if (hit) return hit;
        }
        return null;
    }
    if (!isRecord(value)) return null;

    const direct = directSelectionFromRecord(value, allowed);
    if (direct) return direct;

    // Common OpenAI/Gemini-compatible wrappers.
    for (const key of ['function', 'function_call', 'functionCall', 'tool_call', 'toolCall', 'call']) {
        const child = value[key];
        if (!isRecord(child)) continue;
        const hit = directSelectionFromRecord(child, allowed);
        if (hit) return hit;
    }
    for (const key of ['tool_calls', 'toolCalls', 'function_calls', 'functionCalls', 'calls']) {
        const child = value[key];
        if (!Array.isArray(child)) continue;
        const hit = selectionFromJsonValue(child, allowed);
        if (hit) return hit;
    }

    // Some gateways serialize a tool call as {"real_tool_name": {...args}}.
    const keyed = Object.entries(value)
        .filter(([name, args]) => allowed.has(name) && (isRecord(args) || typeof args === 'string'))
        .map(([name, args]) => ({ name, args: parseArguments(args) }))
        .filter((item): item is { name: string; args: Record<string, unknown> } => Boolean(item.args));
    if (keyed.length === 1) return { tool: keyed[0].name, arguments: keyed[0].args };

    return null;
};

/**
 * OpenAI-compatible gateways sometimes accept tools/tool_choice yet return the selected
 * call as ordinary JSON in message.content. Accept the common OpenAI/Gemini wrappers,
 * tool-name-keyed JSON, and prose-wrapped JSON. Explicit known tool names always win.
 *
 * Arguments-only JSON is safe when there is exactly one available image tool. With
 * multiple image presets we only accept it when the surrounding text names exactly one
 * real exposed tool; otherwise we deliberately reject it rather than silently routing a
 * NovelAI request to the wrong preset.
 */
export const extractStoryImagePlannerJsonSelection = (
    content: string,
    allowedToolNames: Iterable<string>,
): StoryImagePlannerJsonSelection | null => {
    const allowed = new Set(Array.from(allowedToolNames, name => String(name || '').trim()).filter(Boolean));
    if (!allowed.size) return null;

    const candidates = extractJsonCandidates(content);
    for (const candidate of candidates) {
        const explicit = selectionFromJsonValue(candidate, allowed);
        if (explicit) return explicit;
    }

    const fallbackTool = allowed.size === 1
        ? Array.from(allowed)[0]
        : findUniqueToolMention(content, allowed);
    if (!fallbackTool) return null;

    for (const candidate of candidates) {
        if (!isRecord(candidate)) continue;
        const wrappedArgs = parseArguments(
            candidate.arguments
            ?? candidate.args
            ?? candidate.input
            ?? candidate.parameters
            ?? candidate.params,
        );
        if (wrappedArgs) return { tool: fallbackTool, arguments: wrappedArgs };
        if (looksLikeDirectImageArguments(candidate)) {
            return { tool: fallbackTool, arguments: { ...candidate } };
        }
    }
    return null;
};
