const STORY_SYSTEM_COMPAT_ANCHOR =
    'The final user message contains a <SULLY_SYSTEM_INSTRUCTIONS> block with the full system instructions for this request. Treat that block as the system instructions and follow it throughout the conversation.';

/**
 * 文游专用的 system 兼容转换。完整规则一字不删，只把大段 system 从兼容站容易出错的
 * system_instruction 通道挪到最后一个 user 消息中的明确规则块，并保留一个短 system 锚点。
 * 主聊天不会调用这个 helper。
 */
export const applyStorySystemCompatibilityToBody = <T extends Record<string, any>>(
    body: T,
    enabled: boolean,
): T => {
    if (!enabled || !Array.isArray(body.messages)) return body;

    const systemTextParts: string[] = [];
    const nonSystemMessages: Array<Record<string, any>> = [];
    let finalUserIndex = -1;

    for (const rawMessage of body.messages) {
        if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return body;
        const message = rawMessage as Record<string, any>;
        if (message.role === 'system') {
            // 复合 system 内容宁可不转换，也不能静默丢图/工具块。
            if (typeof message.content !== 'string') return body;
            systemTextParts.push(message.content);
            continue;
        }

        const cloned = { ...message };
        nonSystemMessages.push(cloned);
        if (cloned.role === 'user' && typeof cloned.content === 'string') {
            finalUserIndex = nonSystemMessages.length - 1;
        }
    }

    if (systemTextParts.length === 0 || finalUserIndex < 0) return body;

    const finalUser = nonSystemMessages[finalUserIndex];
    const originalUserContent = String(finalUser.content || '');
    finalUser.content = [
        '<SULLY_SYSTEM_INSTRUCTIONS>',
        systemTextParts.join('\n\n'),
        '</SULLY_SYSTEM_INSTRUCTIONS>',
        '',
        '<SULLY_CURRENT_USER_TURN>',
        originalUserContent,
        '</SULLY_CURRENT_USER_TURN>',
    ].join('\n');

    return {
        ...body,
        messages: [
            { role: 'system', content: STORY_SYSTEM_COMPAT_ANCHOR },
            ...nonSystemMessages,
        ],
    };
};
