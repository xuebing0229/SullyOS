export const CHAT_RESPONSE_CACHE_VERSION =
    'chat-response-cache-v2-no-tool-replay';

export interface ChatResponseCachePolicyOptions {
    knownTextToolNames?: string[];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsKnownTextToolCall(
    content: string,
    toolNames: string[],
): boolean {
    const names = [...new Set(
        toolNames
            .map(name => String(name || '').trim())
            .filter(Boolean),
    )];
    if (!content || names.length === 0) return false;

    const alternation = names
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');

    // 兼容 tool_name({...}) 与 tool_name: ...；只检测当前实际已知工具名。
    const pattern = new RegExp(
        `(?:^|[\\n\\r])\\s*(?:${alternation})\\s*(?:\\(|[:：])`,
        'i',
    );
    return pattern.test(content);
}

export function shouldPersistChatCompletion(
    response: any,
    options: ChatResponseCachePolicyOptions = {},
): boolean {
    const choices = Array.isArray(response?.choices)
        ? response.choices
        : [];
    if (choices.length === 0) return false;

    for (const choice of choices) {
        const message = choice?.message;
        if (!message || typeof message !== 'object') continue;

        if (choice?.finish_reason === 'tool_calls') return false;
        if (
            Array.isArray(message.tool_calls)
            && message.tool_calls.length > 0
        ) return false;
        if (message.function_call) return false;

        const content = typeof message.content === 'string'
            ? message.content
            : '';
        if (containsKnownTextToolCall(
            content,
            options.knownTextToolNames || [],
        )) return false;

        // 至少有一个真正的最终 assistant 消息才缓存。
        if (content.trim()) return true;
    }

    return false;
}
