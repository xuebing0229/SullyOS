import {
    describe,
    expect,
    it,
} from 'vitest';

import {
    claimMcpToolExecution,
    createMcpTurnExecutionState,
    makeMcpExecutionSignature,
    resolveMcpExecutionPolicy,
} from './mcpExecutionPolicy';

describe('mcpExecutionPolicy', () => {
    it('参数键顺序不同仍视为同一次调用', () => {
        const a = makeMcpExecutionSignature('server-1', 'search', {
            query: 'abc',
            page: 1,
        });
        const b = makeMcpExecutionSignature('server-1', 'search', {
            page: 1,
            query: 'abc',
        });
        expect(a).toBe(b);
    });

    it('完全相同的调用本轮只允许一次', () => {
        const state = createMcpTurnExecutionState();
        const input = {
            serverId: 'server-1',
            toolName: 'search',
            args: { query: 'abc' },
            policy: 'repeatable' as const,
        };

        expect(claimMcpToolExecution(state, input).allowed).toBe(true);
        const second = claimMcpToolExecution(state, input);
        expect(second.allowed).toBe(false);
        expect(second.reason).toBe('duplicate-call');
    });

    it('single-shot 即使参数不同也只能执行一次', () => {
        const state = createMcpTurnExecutionState();
        expect(claimMcpToolExecution(state, {
            serverId: 'image',
            toolName: 'generate_image',
            args: { prompt: 'cat' },
            policy: 'single-shot',
        }).allowed).toBe(true);

        const second = claimMcpToolExecution(state, {
            serverId: 'image',
            toolName: 'generate_image',
            args: { prompt: 'dog' },
            policy: 'single-shot',
        });
        expect(second.allowed).toBe(false);
        expect(second.reason).toBe('single-shot-limit');
    });

    it('内置生图服务器被识别为 single-shot', () => {
        expect(resolveMcpExecutionPolicy({
            id: 'builtin_image_gpt-image',
            builtin: true,
        }, {
            name: 'generate_image',
        })).toBe('single-shot');
    });

    it('普通工具仍为 repeatable', () => {
        expect(resolveMcpExecutionPolicy({
            id: 'normal-server',
            builtin: false,
        }, {
            name: 'search_web',
        })).toBe('repeatable');
    });
});