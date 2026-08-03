import type { McpToolResult } from './mcpClient';

export type McpSingleShotStatus =
    | 'completed'
    | 'queued'
    | 'failed';

export interface McpSingleShotOutcome {
    toolName: string;
    status: McpSingleShotStatus;
    detail?: string;
}

export interface RunMcpSingleShotClosingInput {
    baseReqBody: Record<string, any>;
    fullMessages: any[];
    leadIn?: string;
    outcome: McpSingleShotOutcome;
    previousResponse: any;
    execute: (body: Record<string, any>) => Promise<any>;
}

export interface RunMcpSingleShotClosingResult {
    response: any;
    usedFallback: boolean;
    error?: string;
}

const MAX_DETAIL_CHARS = 600;
const MAX_LEAD_IN_CHARS = 1200;

const truncate = (value: string, maxChars: number): string =>
    value.length > maxChars
        ? `${value.slice(0, maxChars)}…`
        : value;

/**
 * 工具错误可能夹带 Authorization、API Key、Token 或完整私有地址。
 * 这里只保留对用户有帮助的短错误，不把敏感配置送回模型或写进聊天。
 */
export const sanitizeMcpOutcomeText = (
    value: unknown,
    maxChars = MAX_DETAIL_CHARS,
): string => {
    let text = value instanceof Error
        ? value.message
        : String(value ?? '');

    text = text
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(
            /\b(api[-_ ]?key|authorization|token|secret|password)\b\s*([:=])\s*([^\s,;]+)/gi,
            (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`,
        )
        .replace(/https?:\/\/[^\s<>"')\]]+/gi, '[URL]')
        .replace(/\s+/g, ' ')
        .trim();

    return truncate(text, Math.max(1, maxChars));
};

const stripToolProtocolFields = (message: any): any => {
    const cleaned = { ...message };
    delete cleaned.tool_calls;
    delete cleaned.function_call;
    delete cleaned.tool_call_id;
    return cleaned;
};

export const sanitizeToollessFollowupMessages = (
    messages: any[],
): any[] => (messages || [])
    .filter(message => message?.role !== 'tool')
    .map(stripToolProtocolFields);

export const resolveMcpSingleShotOutcome = (input: {
    toolName: string;
    result: McpToolResult;
    imageMessageCount?: number;
}): McpSingleShotOutcome => {
    const { toolName, result } = input;

    if (!result.success) {
        return {
            toolName,
            status: 'failed',
            detail: sanitizeMcpOutcomeText(
                result.error || '生图工具执行失败',
            ),
        };
    }

    if (result.backgroundJob) {
        return {
            toolName,
            status: 'queued',
            detail: '后台任务已接收，图片完成后会自动出现在聊天和相册中。',
        };
    }

    if ((input.imageMessageCount ?? 0) <= 0) {
        return {
            toolName,
            status: 'failed',
            detail: '工具返回成功，但没有找到可显示或保存的图片结果。',
        };
    }

    return {
        toolName,
        status: 'completed',
        detail: '图片已经生成，并已保存到聊天和角色相册。',
    };
};

const buildOutcomeInstruction = (
    outcome: McpSingleShotOutcome,
): string => {
    const detail = sanitizeMcpOutcomeText(outcome.detail || '');

    if (outcome.status === 'queued') {
        return [
            '状态：后台生成中。',
            detail || '后台任务已接收，图片完成后会自动出现。',
            '图片现在还没有完成；绝对不要声称已经看到图片，也不要编造图片内容或 URL。',
        ].join('\n');
    }

    if (outcome.status === 'completed') {
        return [
            '状态：已完成。',
            detail || '图片已经生成并保存。',
            '不要再次调用工具，也不要重复输出工具名、参数、JSON 或图片 URL。',
        ].join('\n');
    }

    return [
        '状态：失败。',
        detail || '生图工具执行失败。',
        '必须如实告诉用户这次没有生成图片；不要假装成功，也不要再次调用工具。',
    ].join('\n');
};

export const buildMcpSingleShotClosingBody = (
    input: Omit<RunMcpSingleShotClosingInput, 'previousResponse' | 'execute'>,
): Record<string, any> => {
    const messages = sanitizeToollessFollowupMessages(input.fullMessages);
    const leadIn = sanitizeMcpOutcomeText(
        input.leadIn || '',
        MAX_LEAD_IN_CHARS,
    );

    if (leadIn) {
        messages.push({
            role: 'assistant',
            content: leadIn,
        });
    }

    messages.push({
        role: 'user',
        content: [
            '[系统消息：本轮生图工具已经执行一次，禁止再次调用任何生图工具。]',
            `工具：${sanitizeMcpOutcomeText(input.outcome.toolName, 120) || '生图工具'}`,
            buildOutcomeInstruction(input.outcome),
            '请只用当前角色的自然语气收尾一小句。不要提及系统消息、function calling、MCP 或内部处理。',
        ].join('\n'),
    });

    const body: Record<string, any> = {
        ...input.baseReqBody,
        messages,
    };
    delete body.tools;
    delete body.tool_choice;
    return body;
};

export const localMcpSingleShotFallbackText = (
    outcome: McpSingleShotOutcome,
): string => {
    // 排队与成功已有顶部轻提示和最终图片，不再制造一条假装是角色回复的状态气泡。
    // 失败仍保留确定性错误文本，避免真正的问题被静默吞掉。
    if (outcome.status === 'queued' || outcome.status === 'completed') {
        return '';
    }
    const detail = sanitizeMcpOutcomeText(
        outcome.detail || '生图工具执行失败',
    );
    return `[生图失败] ${detail || '生图工具执行失败'}`;
};

export const buildMcpSingleShotFallbackResponse = (
    previousResponse: any,
    outcome: McpSingleShotOutcome,
): any => {
    const choices = Array.isArray(previousResponse?.choices)
        ? previousResponse.choices
        : [];
    const baseChoice = choices[0] || { index: 0 };
    const baseMessage = baseChoice.message || {};
    const message = stripToolProtocolFields({
        ...baseMessage,
        role: 'assistant',
        content: localMcpSingleShotFallbackText(outcome),
    });
    const firstChoice = {
        ...baseChoice,
        index: baseChoice.index ?? 0,
        finish_reason: 'stop',
        message,
    };

    return {
        ...(previousResponse || {}),
        choices: choices.length > 0
            ? choices.map((choice: any, index: number) =>
                index === 0 ? firstChoice : choice)
            : [firstChoice],
    };
};

const normalizeClosingResponse = (
    response: any,
    previousResponse: any,
    outcome: McpSingleShotOutcome,
): { response: any; usedFallback: boolean } => {
    const firstChoice = response?.choices?.[0];
    const message = firstChoice?.message;
    const content = typeof message?.content === 'string'
        ? message.content.trim()
        : '';

    if (!content) {
        return {
            response: buildMcpSingleShotFallbackResponse(
                previousResponse,
                outcome,
            ),
            usedFallback: true,
        };
    }

    const cleanedMessage = stripToolProtocolFields({
        ...message,
        content,
    });
    return {
        response: {
            ...response,
            choices: response.choices.map((choice: any, index: number) =>
                index === 0
                    ? {
                        ...choice,
                        finish_reason: 'stop',
                        message: cleanedMessage,
                    }
                    : choice),
        },
        usedFallback: false,
    };
};

/**
 * single-shot 工具完成后的本地收尾入口。
 * 为保证一次聊天模型 + 一次图片模型，本函数绝不调用 execute。
 */
export const runMcpSingleShotClosing = async (
    input: RunMcpSingleShotClosingInput,
): Promise<RunMcpSingleShotClosingResult> => ({
    response: buildMcpSingleShotFallbackResponse(
        input.previousResponse,
        input.outcome,
    ),
    usedFallback: true,
});
