import { describe, expect, it } from 'vitest';

import { extractTextFakedMcpCalls, type ResolvedMcpTool } from './mcpToolBridge';

const imageHit: ResolvedMcpTool = {
    server: {
        id: 'builtin_image_gpt-image',
        name: 'GPT Image',
        builtin: true,
        tools: [{
            name: 'generate_image',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string' },
                },
                required: ['prompt'],
            },
        }],
    } as any,
    toolName: 'generate_image',
    executionPolicy: 'single-shot',
};

describe('mcpToolBridge execution policy propagation', () => {
    it('括号正文调用继承 single-shot 策略', () => {
        const resolve = new Map<string, ResolvedMcpTool>([
            ['generate_image', imageHit],
        ]);
        const calls = extractTextFakedMcpCalls(
            'generate_image({"prompt":"cat"})',
            resolve,
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].executionPolicy).toBe('single-shot');
        expect(calls[0].args).toEqual({ prompt: 'cat' });
    });

    it('冒号正文调用继承 single-shot 策略', () => {
        const resolve = new Map<string, ResolvedMcpTool>([
            ['generate_image', imageHit],
        ]);
        const calls = extractTextFakedMcpCalls(
            'generate_image: a white cat',
            resolve,
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].executionPolicy).toBe('single-shot');
        expect(calls[0].args).toEqual({ prompt: 'a white cat' });
    });

    it('生图工具 schema 注入客户端后动作且不修改原 schema', async () => {
    const { buildMcpOpenAITools } = await import('./mcpToolBridge');
    const { getEnabledMcpServers } = await import('./mcpClient');
    void buildMcpOpenAITools;
    void getEnabledMcpServers;
    const original = imageHit.server.tools![0].inputSchema as any;
    const cloned = JSON.parse(JSON.stringify(original));
    const { augmentImageToolSchema } = await import('./imageToolPostAction');
    const augmented = augmentImageToolSchema(original);
    expect(augmented.properties.after_generate_action.enum).toEqual(['none', 'inspect']);
    expect(original).toEqual(cloned);
});
});
