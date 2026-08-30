import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    new URL('../hooks/useChatAI.ts', import.meta.url),
    'utf8',
);

describe('useChatAI main-chat failover wiring', () => {
    it('首轮聊天真正通过 apiPlan 故障转移入口发送', () => {
        expect(source).toContain("data = await executeChatBody(\n                    attemptedBody,\n                    '聊天回复',\n                    streamHooks,\n                    true,");
        expect(source).not.toContain("data = await safeFetchJson(\`\${baseUrl}/chat/completions\`, {\n                    method: 'POST', headers,\n                    body: JSON.stringify({ ...baseReqBody, messages: withAmsg2TaskContext(baseReqBody.messages) })");
    });

    it('首轮成功切线后，后处理使用真实成功线路而不是初始第一线路', () => {
        expect(source).toContain("baseUrl: activeApiForTurn.baseUrl.trim().replace(/\\/+$/, '')");
        expect(source).toContain("Authorization: \`Bearer \${activeApiForTurn.apiKey || 'sk-none'}\`");
        expect(source).toContain('effectiveApi: activeApiForTurn');
    });

    it('兼容重试也锁在当前成功/当前线路，不绕回旧 baseUrl', () => {
        expect(source).toContain("'Claude 中转兼容重试',\n                            streamHooks,\n                            false,");
        expect(source).toContain("'MCP tools 兼容重试',\n                    undefined,\n                    false,");
    });
});
