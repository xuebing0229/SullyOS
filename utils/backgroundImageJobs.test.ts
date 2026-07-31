import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    callMcpToolWithBackgroundImage,
    clearBackgroundImageJobs,
    getBackgroundImageJobs,
    isBackgroundImageToolCall,
} from './backgroundImageJobs';
import type { McpServerConfig } from './mcpClient';

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

describe('background image jobs', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
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
        clearBackgroundImageJobs();
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
});
