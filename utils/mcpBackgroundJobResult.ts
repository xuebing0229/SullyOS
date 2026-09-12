import './mcpFireCore';

/**
 * 后台生图会把“已接单、稍后自动回挂”的本地任务句柄附在 MCP 结果上。
 * 运行时字段早已由 backgroundImageJobs 返回；这里补齐共享 McpToolResult 的类型，
 * 避免调用方为了读取 backgroundJob 被迫转 any。
 */
declare module './mcpFireCore' {
    interface McpToolResult {
        backgroundJob?: {
            localJobId: string;
            clientRequestId: string;
            remoteJobId?: string;
            status: 'submitting' | 'queued' | 'running';
            engineId: string;
        };
    }
}

export {};
