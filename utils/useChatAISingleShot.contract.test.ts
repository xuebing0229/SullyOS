import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    new URL('../hooks/useChatAI.ts', import.meta.url),
    'utf8',
);

describe('useChatAI single-shot image contract', () => {
    it('不再用提前终止变量吞掉生图结果和最终后处理', () => {
        expect(source).not.toContain('terminateClaudeAfterImage');
        expect(source).not.toContain('skipFinalAssistantPostProcess');
        expect(source).toContain('runMcpSingleShotClosing');
        expect(source).toContain('resolveMcpSingleShotOutcome');
    });

    it('native 与正文兼容两条路径都走同一个确定性收尾入口', () => {
        const calls = source.match(/await closeMcpSingleShot\(/g) || [];
        expect(calls).toHaveLength(2);
    });
});
