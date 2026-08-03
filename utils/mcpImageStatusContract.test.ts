import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    new URL('../hooks/useChatAI.ts', import.meta.url),
    'utf8',
);

describe('MCP 生图状态消息契约', () => {
    it('排队或完成时不再把通用状态文案写成角色聊天', () => {
        expect(source).toContain('let suppressMcpImageStatusMessage = false;');
        expect(source).toContain("if (outcome.status !== 'failed')");
        expect(source).toContain(
            "const rawAiContent = suppressMcpImageStatusMessage",
        );
        expect(source).toContain(
            'if (!suppressMcpImageStatusMessage) await applyAssistantPostProcessing',
        );
    });

    it('聊天打开时清理旧版遗留占位消息', () => {
        expect(source).toContain('cleanupLegacyMcpImageStatusMessages');
        expect(source).toContain(
            'removed <= 0',
        );
    });
});
