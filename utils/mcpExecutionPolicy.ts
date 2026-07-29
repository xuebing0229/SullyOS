import type {
    McpServerConfig,
    McpToolDef,
} from './mcpClient';

export type McpExecutionPolicy =
    | 'repeatable'
    | 'single-shot';

export interface McpTurnExecutionState {
    /** 当前这一轮聊天已经真实执行过的 MCP 调用。native 与正文兼容调用共享。 */
    executedSignatures: Set<string>;

    /** 当前轮是否已经尝试过一次 single-shot 工具（失败也算尝试）。 */
    singleShotAttempted: boolean;
}

export type McpExecutionBlockReason =
    | 'duplicate-call'
    | 'single-shot-limit';

export interface McpExecutionClaim {
    allowed: boolean;
    signature: string;
    reason?: McpExecutionBlockReason;
}

const SINGLE_SHOT_IMAGE_TOOL_NAMES = new Set<string>([
    'generate_image',
    'novelai_generate_image',
]);

const canonicalize = (
    value: unknown,
    seen: WeakSet<object>,
): unknown => {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'number' && !Number.isFinite(value)) {
            return String(value);
        }
        return value;
    }

    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
        const output = value.map(item => canonicalize(item, seen));
        seen.delete(value);
        return output;
    }

    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
        const child = record[key];
        if (child === undefined) continue;
        output[key] = canonicalize(child, seen);
    }

    seen.delete(value as object);
    return output;
};

export const stableMcpArgsString = (
    args: Record<string, any>,
): string => {
    try {
        return JSON.stringify(canonicalize(args || {}, new WeakSet<object>()));
    } catch {
        try {
            return JSON.stringify(args || {});
        } catch {
            return String(args);
        }
    }
};

export const makeMcpExecutionSignature = (
    serverId: string,
    toolName: string,
    args: Record<string, any>,
): string => [
    String(serverId || ''),
    String(toolName || ''),
    stableMcpArgsString(args || {}),
].join('\u0000');

/** 内置生图服务器及标准生图工具名均为 single-shot。 */
export const resolveMcpExecutionPolicy = (
    server: Pick<McpServerConfig, 'id' | 'builtin'>,
    tool: Pick<McpToolDef, 'name'>,
): McpExecutionPolicy => {
    const normalizedName = String(tool.name || '').trim().toLowerCase();

    if (
        server.builtin === true
        && String(server.id || '').startsWith('builtin_image_')
    ) {
        return 'single-shot';
    }

    if (SINGLE_SHOT_IMAGE_TOOL_NAMES.has(normalizedName)) {
        return 'single-shot';
    }

    return 'repeatable';
};

export const createMcpTurnExecutionState =
    (): McpTurnExecutionState => ({
        executedSignatures: new Set<string>(),
        singleShotAttempted: false,
    });

/** 真正调用 MCP 前 claim；成功后立即占位，网络失败也不自动重试。 */
export const claimMcpToolExecution = (
    state: McpTurnExecutionState,
    input: {
        serverId: string;
        toolName: string;
        args: Record<string, any>;
        policy: McpExecutionPolicy;
    },
): McpExecutionClaim => {
    const signature = makeMcpExecutionSignature(
        input.serverId,
        input.toolName,
        input.args,
    );

    if (state.executedSignatures.has(signature)) {
        return { allowed: false, signature, reason: 'duplicate-call' };
    }

    if (input.policy === 'single-shot' && state.singleShotAttempted) {
        return { allowed: false, signature, reason: 'single-shot-limit' };
    }

    state.executedSignatures.add(signature);
    if (input.policy === 'single-shot') state.singleShotAttempted = true;

    return { allowed: true, signature };
};

export const formatBlockedMcpExecution = (
    reason: McpExecutionBlockReason,
    exposedName: string,
): string => {
    if (reason === 'single-shot-limit') {
        return (
            `工具 ${exposedName} 本轮未再次执行：`
            + '本轮已经发起过一次生图。'
            + '为避免重复生成和重复计费，'
            + '请直接基于第一次调用结果回复。'
            + '需要重画时，等待用户发送下一条消息。'
        );
    }

    return (
        `工具 ${exposedName} 本轮未再次执行：`
        + '完全相同的工具和参数已经执行过。'
        + '请复用先前结果，不要重复调用。'
    );
};
