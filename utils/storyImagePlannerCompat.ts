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

/**
 * OpenAI-compatible gateways sometimes accept tools/tool_choice yet return the selected
 * call as ordinary JSON in message.content. Only known tool names are accepted.
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
    const tool = String(raw.tool || raw.tool_name || raw.name || fn?.name || '').trim();
    if (!tool || !allowed.has(tool)) return null;

    const args = parseArguments(raw.arguments ?? raw.args ?? fn?.arguments);
    return args ? { tool, arguments: args } : null;
};
