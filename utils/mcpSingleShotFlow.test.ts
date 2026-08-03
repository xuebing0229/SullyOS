import { describe, expect, it, vi } from 'vitest';

import {
    buildMcpSingleShotClosingBody,
    localMcpSingleShotFallbackText,
    resolveMcpSingleShotOutcome,
    runMcpSingleShotClosing,
    sanitizeMcpOutcomeText,
} from './mcpSingleShotFlow';

describe('mcpSingleShotFlow', () => {
    it('构造无 tools、无 tool role、无 tool_calls 的安全收尾请求', () => {
        const body = buildMcpSingleShotClosingBody({
            baseReqBody: {
                model: 'claude-test',
                tools: [{ type: 'function' }],
                tool_choice: 'auto',
            },
            fullMessages: [
                { role: 'system', content: 'system' },
                { role: 'user', content: '画一张图' },
                {
                    role: 'assistant',
                    content: '旧工具消息',
                    tool_calls: [{ id: 'call-1' }],
                },
                {
                    role: 'tool',
                    tool_call_id: 'call-1',
                    content: '工具结果',
                },
            ],
            leadIn: '我来画。',
            outcome: {
                toolName: 'generate_image',
                status: 'queued',
            },
        });

        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(body.messages.some((message: any) => message.role === 'tool')).toBe(false);
        expect(body.messages.some((message: any) => message.tool_calls)).toBe(false);
        expect(body.messages[body.messages.length - 1].content).toContain('禁止再次调用');
        expect(body.messages[body.messages.length - 1].content).toContain('图片现在还没有完成');
    });

    it('生图 single-shot 后不再发第二次聊天模型请求', async () => {
        const execute = vi.fn(async () => {
            throw new Error('should not be called');
        });
        const result = await runMcpSingleShotClosing({
            baseReqBody: { model: 'test', tools: [{}], tool_choice: 'auto' },
            fullMessages: [{ role: 'user', content: '画图' }],
            outcome: { toolName: 'generate_image', status: 'queued' },
            previousResponse: { choices: [] },
            execute,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(result.usedFallback).toBe(true);
        expect(result.response.choices[0].finish_reason).toBe('stop');
        expect(result.response.choices[0].message.content).toBe('');
        expect(result.response.choices[0].message.tool_calls).toBeUndefined();
    });

    it('失败场景也只使用本地确定性文案', async () => {
        const execute = vi.fn(async () => {
            throw new Error('HTTP 500 Bearer very-secret-token');
        });
        const result = await runMcpSingleShotClosing({
            baseReqBody: { model: 'test' },
            fullMessages: [{ role: 'user', content: '画图' }],
            outcome: {
                toolName: 'generate_image',
                status: 'failed',
                detail: 'upstream failed',
            },
            previousResponse: { choices: [] },
            execute,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(result.usedFallback).toBe(true);
        expect(result.response.choices[0].message.content).toBe('[生图失败] upstream failed');
        expect(result.error).toBeUndefined();
    });
    it('区分同步完成、后台排队和无图片失败', () => {
        expect(resolveMcpSingleShotOutcome({
            toolName: 'generate_image',
            result: { success: true, backgroundJob: {
                localJobId: 'local', clientRequestId: 'client', status: 'queued', engineId: 'gpt-image',
            } },
        }).status).toBe('queued');

        expect(resolveMcpSingleShotOutcome({
            toolName: 'generate_image',
            result: { success: true },
            imageMessageCount: 1,
        }).status).toBe('completed');

        expect(resolveMcpSingleShotOutcome({
            toolName: 'generate_image',
            result: { success: true },
            imageMessageCount: 0,
        }).status).toBe('failed');
    });

    it('清洗密钥、Token 和完整 URL', () => {
        const cleaned = sanitizeMcpOutcomeText(
            'Authorization: abc api_key=secret Bearer token123 https://private.example/path?q=1',
        );
        expect(cleaned).not.toContain('secret');
        expect(cleaned).not.toContain('token123');
        expect(cleaned).not.toContain('private.example');
        expect(cleaned).toContain('[REDACTED]');
        expect(cleaned).toContain('[URL]');
        expect(localMcpSingleShotFallbackText({
            toolName: 'generate_image',
            status: 'queued',
        })).toBe('');
        expect(localMcpSingleShotFallbackText({
            toolName: 'generate_image',
            status: 'completed',
        })).toBe('');
    });
});
