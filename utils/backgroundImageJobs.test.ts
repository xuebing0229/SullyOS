import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mcpClient', async () => {
    const actual = await vi.importActual<typeof import('./mcpClient')>('./mcpClient');
    return {
        ...actual,
        callMcpTool: vi.fn(),
    };
});

import { DB } from './db';
import {
    callMcpToolWithBackgroundImage,
    clearBackgroundImageJobs,
    dismissBackgroundImageJobs,
    getBackgroundImageJobs,
    isBackgroundImageToolCall,
    persistBackgroundImageFailureMessage,
    type LocalBackgroundImageJob,
} from './backgroundImageJobs';
import {
    callMcpTool,
    type McpServerConfig,
} from './mcpClient';

const server: McpServerConfig = {
    id: 'builtin_image_gpt-image',
    name: 'GPT 生图',
    url: 'https://example.test/gpt-image/mcp',
    controlBaseUrl: 'https://example.test/gpt-image',
    token: 'frozen-token',
    enabled: true,
    builtin: true,
    updatedAt: 1,
};

const makeJob = (
    patch: Partial<LocalBackgroundImageJob> = {},
): LocalBackgroundImageJob => ({
    id: 'local-job-1',
    clientRequestId: 'client-request-1',
    remoteJobId: 'remote-job-1',
    engineId: 'gpt-image',
    serverId: server.id,
    serverName: server.name,
    controlBaseUrl: server.controlBaseUrl!,
    token: 'do-not-persist-this-token',
    charId: 'char-1',
    toolName: 'generate_image',
    toolArgs: { prompt: 'cat' },
    afterGenerateAction: 'none',
    status: 'failed',
    createdAt: 1,
    updatedAt: 2,
    submitAttempts: 1,
    lastError: 'HTTP 500 Bearer secret-token https://private.example/jobs/1',
    ...patch,
});

describe('background image jobs', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
        vi.mocked(callMcpTool).mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('only backgrounds the matching built-in image tool', () => {
        expect(isBackgroundImageToolCall(server, 'generate_image')).toBe(true);
        expect(isBackgroundImageToolCall(server, 'other_tool')).toBe(false);
        expect(isBackgroundImageToolCall({ ...server, builtin: false }, 'generate_image')).toBe(false);
    });

    it('freezes endpoint, token and arguments while returning a queued result', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            created: true,
            job: {
                id: 'remote-job-1',
                clientRequestId: 'client_request_1234',
                toolName: 'generate_image',
                status: 'queued',
                createdAt: 1,
                updatedAt: 1,
            },
        }), { status: 202, headers: { 'content-type': 'application/json' } }));

        const result = await callMcpToolWithBackgroundImage(
            server,
            'generate_image',
            { prompt: 'frozen prompt' },
            { charId: 'char-1' },
        );

        expect(result.success).toBe(true);
        expect(result.backgroundJob?.remoteJobId).toBe('remote-job-1');
        const saved = getBackgroundImageJobs();
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({
            controlBaseUrl: 'https://example.test/gpt-image',
            token: 'frozen-token',
            charId: 'char-1',
            toolArgs: { prompt: 'frozen prompt' },
            remoteJobId: 'remote-job-1',
        });
        const [, init] = fetchMock.mock.calls[0];
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer frozen-token');
        expect(JSON.parse(String(init?.body))).toMatchObject({
            toolName: 'generate_image',
            arguments: { prompt: 'frozen prompt' },
        });
    });

    it('strips inspect orchestration fields and records a pending inspect', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            created: true,
            job: {
                id: 'remote-job-inspect',
                clientRequestId: 'client_request_inspect',
                toolName: 'generate_image',
                status: 'queued',
                createdAt: 1,
                updatedAt: 1,
            },
        }), { status: 202, headers: { 'content-type': 'application/json' } }));
        await callMcpToolWithBackgroundImage(
            server,
            'generate_image',
            { prompt: 'inspect me', after_generate_action: 'inspect' },
            { charId: 'char-inspect' },
        );
        expect(getBackgroundImageJobs()[0]).toMatchObject({
            toolArgs: { prompt: 'inspect me' },
            afterGenerateAction: 'inspect',
            inspectStatus: 'pending',
        });
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(String(init?.body)).arguments).toEqual({ prompt: 'inspect me' });
    });

    it.each([404, 405, 501])(
        '/jobs 返回 HTTP %s 时删除伪后台任务并仅回退一次直连 MCP',
        async status => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
                JSON.stringify({ error: 'route_not_found' }),
                { status, headers: { 'content-type': 'application/json' } },
            ));
            vi.mocked(callMcpTool).mockResolvedValue({
                success: true,
                data: { imageUrl: 'https://image.example/result.png' },
            });

            const result = await callMcpToolWithBackgroundImage(
                server,
                'generate_image',
                { prompt: 'fallback prompt', after_generate_action: 'none' },
                { charId: 'char-fallback' },
            );

            expect(result.success).toBe(true);
            expect(callMcpTool).toHaveBeenCalledTimes(1);
            expect(callMcpTool).toHaveBeenCalledWith(
                server,
                'generate_image',
                { prompt: 'fallback prompt' },
            );
            expect(getBackgroundImageJobs()).toHaveLength(0);
        },
    );

    it('5xx 不回退直连，保留相同 clientRequestId 等待恢复查询', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ error: 'temporary_failure' }),
            { status: 503, headers: { 'content-type': 'application/json' } },
        ));

        const result = await callMcpToolWithBackgroundImage(
            server,
            'generate_image',
            { prompt: 'do not duplicate' },
            { charId: 'char-503' },
        );

        expect(result.success).toBe(true);
        expect(result.backgroundJob?.clientRequestId).toBeTruthy();
        expect(callMcpTool).not.toHaveBeenCalled();
        expect(getBackgroundImageJobs()).toHaveLength(1);
    });

    it('网络响应丢失不回退直连，保留后台任务等待幂等恢复', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network lost'));

        const result = await callMcpToolWithBackgroundImage(
            server,
            'generate_image',
            { prompt: 'do not duplicate on timeout' },
            { charId: 'char-network' },
        );

        expect(result.success).toBe(true);
        expect(result.backgroundJob?.status).toBe('submitting');
        expect(callMcpTool).not.toHaveBeenCalled();
        expect(getBackgroundImageJobs()).toHaveLength(1);
    });

    it('后台最终失败只落一条已脱敏的可见系统消息', async () => {
        const messages: any[] = [];
        vi.spyOn(DB, 'getRecentMessagesByCharId').mockImplementation(async () => messages as any);
        const save = vi.spyOn(DB, 'saveMessage').mockImplementation(async message => {
            messages.push({ ...message, id: messages.length + 1 });
            return undefined as any;
        });

        const job = makeJob();
        expect(await persistBackgroundImageFailureMessage(job)).toBe(true);
        expect(await persistBackgroundImageFailureMessage(job)).toBe(false);
        expect(save).toHaveBeenCalledTimes(1);

        const saved = save.mock.calls[0][0] as any;
        expect(saved.content).toContain('[生图失败]');
        expect(saved.content).not.toContain('secret-token');
        expect(saved.content).not.toContain('private.example');
        expect(saved.metadata).toMatchObject({
            backgroundImageJobFailure: true,
            backgroundImageLocalJobId: job.id,
            backgroundImageJobId: job.remoteJobId,
            backgroundImageClientRequestId: job.clientRequestId,
        });
    });

    it('dismisses failed/cancelled jobs, deletes only linked failure messages, and emits refresh events', async () => {
        const failed = makeJob({ id: 'failed-job', status: 'failed' });
        const cancelled = makeJob({
            id: 'cancelled-job', clientRequestId: 'cancelled-client',
            remoteJobId: 'cancelled-remote', status: 'cancelled',
        });
        const running = makeJob({
            id: 'running-job', clientRequestId: 'running-client',
            remoteJobId: 'running-remote', status: 'running',
        });
        localStorage.setItem('aetheros.imageGeneration.backgroundJobs.v1', JSON.stringify({
            version: 1, jobs: [failed, cancelled, running],
        }));

        vi.spyOn(DB, 'getMessagesByCharId').mockResolvedValue([
            {
                id: 11, charId: 'char-1', role: 'system', type: 'text', content: '[生图失败] failed',
                metadata: { backgroundImageJobFailure: true, backgroundImageLocalJobId: failed.id },
            },
            {
                id: 12, charId: 'char-1', role: 'system', type: 'text', content: '[生图失败] cancelled',
                metadata: { backgroundImageJobFailure: true, backgroundImageClientRequestId: cancelled.clientRequestId },
            },
            {
                id: 13, charId: 'char-1', role: 'assistant', type: 'image', content: 'data:image/png;base64,ok',
                metadata: { backgroundImageJobId: failed.remoteJobId, backgroundGenerated: true },
            },
            {
                id: 14, charId: 'char-1', role: 'system', type: 'text', content: 'unrelated',
                metadata: { backgroundImageJobFailure: true, backgroundImageLocalJobId: 'other-job' },
            },
        ] as any);
        const deleteMessages = vi.spyOn(DB, 'deleteMessages').mockResolvedValue(undefined);

        const events: any[] = [];
        const eventTarget = new EventTarget();
        eventTarget.addEventListener('sullyos:background-image-job-event', event => events.push(event));
        vi.stubGlobal('window', eventTarget);
        if (typeof CustomEvent === 'undefined') {
            class TestCustomEvent<T = unknown> extends Event {
                detail: T;
                constructor(type: string, init?: CustomEventInit<T>) {
                    super(type);
                    this.detail = init?.detail as T;
                }
            }
            vi.stubGlobal('CustomEvent', TestCustomEvent);
        }

        expect(await dismissBackgroundImageJobs([failed.id, cancelled.id])).toBe(2);
        expect(deleteMessages).toHaveBeenCalledWith([11, 12]);
        expect(getBackgroundImageJobs().map(job => job.id)).toEqual(['running-job']);
        expect(events).toHaveLength(2);
        expect(events.map(event => event.detail.type)).toEqual(['dismissed', 'dismissed']);
    });

    it('does not dismiss queued/running/succeeded jobs or touch messages', async () => {
        const jobs = [
            makeJob({ id: 'queued-job', status: 'queued' }),
            makeJob({ id: 'running-job', status: 'running' }),
            makeJob({ id: 'succeeded-job', status: 'succeeded' }),
        ];
        localStorage.setItem('aetheros.imageGeneration.backgroundJobs.v1', JSON.stringify({ version: 1, jobs }));
        const getMessages = vi.spyOn(DB, 'getMessagesByCharId');
        const deleteMessages = vi.spyOn(DB, 'deleteMessages');

        expect(await dismissBackgroundImageJobs(jobs.map(job => job.id))).toBe(0);
        expect(getMessages).not.toHaveBeenCalled();
        expect(deleteMessages).not.toHaveBeenCalled();
        expect(getBackgroundImageJobs().map(job => job.id)).toEqual(jobs.map(job => job.id));
    });


    it('restores the task card when linked failure-message cleanup fails', async () => {
        const failed = makeJob({ id: 'rollback-job', status: 'failed' });
        localStorage.setItem('aetheros.imageGeneration.backgroundJobs.v1', JSON.stringify({
            version: 1, jobs: [failed],
        }));
        vi.spyOn(DB, 'getMessagesByCharId').mockResolvedValue([{
            id: 21, charId: 'char-1', role: 'system', type: 'text', content: '[生图失败] failed',
            metadata: { backgroundImageJobFailure: true, backgroundImageLocalJobId: failed.id },
        }] as any);
        vi.spyOn(DB, 'deleteMessages').mockRejectedValue(new Error('delete failed'));

        await expect(dismissBackgroundImageJobs([failed.id])).rejects.toThrow('delete failed');
        expect(getBackgroundImageJobs().map(job => job.id)).toEqual([failed.id]);
    });

});
