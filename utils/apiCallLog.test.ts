import { describe, it, expect } from 'vitest';
import { scanSseForLog, coreModelName, isSameCoreModel, buildPromptBreakdown } from './apiCallLog';

// 锁住 API 调用记录的 SSE 兜底解析：流式响应 JSON.parse 必然失败，
// 后端自报 model（首个非空）与 usage（末个非空）从 data: 行里扫出来。

describe('scanSseForLog', () => {
    it('抠出首个 model 与最后一个 usage', () => {
        const sse = [
            'data: {"id":"x","model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"a"}}]}',
            'data: {"model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"b"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15572,"completion_tokens":725,"total_tokens":16297}}',
            'data: [DONE]',
        ].join('\n');
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('[逆-V]gemini-3.1-pro-preview-c');
        expect((usage as any).prompt_tokens).toBe(15572);
        expect((usage as any).total_tokens).toBe(16297);
    });

    it('坏行/空行/[DONE] 跳过不崩', () => {
        const sse = 'data: 不是json\n\ndata: [DONE]\ndata: {"model":"m1","choices":[]}';
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('m1');
        expect(usage).toBeUndefined();
    });

    it('非 SSE 文本返回空结果', () => {
        expect(scanSseForLog('{"model":"x"}')).toEqual({ model: undefined, usage: undefined });
    });
});

describe('coreModelName 核心名归一化（实际后端琥珀判定用）', () => {
    it('剥方括号/半角圆括号/全角圆括号渠道标签', () => {
        expect(coreModelName('[千岛-自营]gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('（官转）gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    });

    it('渠道标签不同但核心名相同 → 判定一致（不误报琥珀）', () => {
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
        expect(coreModelName('[co假流]Gemini-3.1-Pro-Preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
    });

    it('核心名真的不同（如 -c 后缀）→ 判定不一致（该报琥珀）', () => {
        expect(coreModelName('[逆-V]gemini-3.1-pro-preview-c')).not.toBe(coreModelName('[千岛-自营]gemini-3.1-pro-preview'));
    });
});

describe('isSameCoreModel 方向性同名判定', () => {
    it('裸前缀 / 路径前缀 → 同名（gcli-X↔X、X↔models/X）', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'models/gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('(按次)gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('[千岛-自营]gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
    });

    it('尾部变体 → 不同名（缩水降级信号必须报琥珀）', () => {
        expect(isSameCoreModel('[千岛-自营]gemini-3.1-pro-preview', '[逆-V]gemini-3.1-pro-preview-c')).toBe(false);
        expect(isSameCoreModel('gpt-4o', 'gpt-4o-mini')).toBe(false);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'gemini-3.1-flash-preview')).toBe(false);
    });

    it('短名不做 endsWith 宽容；空值不报警', () => {
        expect(isSameCoreModel('4o', 'gpt-4o')).toBe(false);
        expect(isSameCoreModel('x', '')).toBe(true);
    });
});

describe('coreModelName 家族锚点裸前缀剥离（两头前缀不一样也能对上）', () => {
    it('两头贴不同裸前缀 → 同名', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'vertex-gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', '[逆-V]az-gemini-3.1-pro-preview')).toBe(true);
    });

    it('家族名本身开头的名字不被误剥', () => {
        expect(coreModelName('chatgpt-4o-latest')).toBe('chatgpt-4o-latest');
        expect(coreModelName('deepseek-chat')).toBe('deepseek-chat');
        expect(coreModelName('gpt-4o-mini')).toBe('gpt-4o-mini');
    });

    it('剥前缀后尾部变体仍然抓得住', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'az-gemini-3.1-pro-preview-c')).toBe(false);
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'vertex-gemini-3.1-flash-preview')).toBe(false);
    });
});

// 输入构成统计：回答「prompt_tokens 为什么这么大」——system 按 ###/[System:] 块头
// 切开逐块计数，历史消息按角色聚合。只存统计不存原文。
describe('buildPromptBreakdown', () => {
    it('system 按块头切开，历史按角色聚合', () => {
        const body = JSON.stringify({
            model: 'x',
            messages: [
                { role: 'system', content: '### 你的身份 (Character)\n设定文本\n### 记忆系统 (Memory Bank)\n- 一条记忆\n- 两条记忆' },
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '嗨嗨' },
                { role: 'user', content: '在吗' },
                { role: 'system', content: '[System: 实时状态 (Live Context)]\n现在是晚上' },
            ],
        });
        const blocks = buildPromptBreakdown(body)!;
        const labels = blocks.map(b => b.label);
        expect(labels).toEqual([
            '你的身份 (Character)',
            '记忆系统 (Memory Bank)',
            '[System: 实时状态 (Live Context)]',
            '聊天历史·用户消息 ×2',
            '聊天历史·角色消息 ×1',
        ]);
        // 字数守恒：system 各块之和 = 原文长度 + 每行换行补偿
        const memBlock = blocks.find(b => b.label.startsWith('记忆系统'))!;
        expect(memBlock.chars).toBeGreaterThan(0);
        expect(blocks.find(b => b.label === '聊天历史·用户消息 ×2')!.chars).toBe(4);
    });

    it('无块头的短 system（尾部提醒）用首行当名字', () => {
        const blocks = buildPromptBreakdown({
            messages: [{ role: 'system', content: '[MCP 工具 ON · 永远用角色语气回复别空回]' }],
        })!;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].label.startsWith('[MCP 工具 ON')).toBe(true);
    });

    it('多模态 content 摊平计数，图片按占位符', () => {
        const blocks = buildPromptBreakdown({
            messages: [
                { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
            ],
        })!;
        expect(blocks[0].label).toBe('聊天历史·用户消息 ×1');
        expect(blocks[0].chars).toBe('看图 [图片]'.length);
    });

    it('解析不了 / 没 messages 时返回 undefined', () => {
        expect(buildPromptBreakdown('{broken')).toBeUndefined();
        expect(buildPromptBreakdown({ model: 'x' })).toBeUndefined();
        expect(buildPromptBreakdown(undefined)).toBeUndefined();
    });

    it('病态多块时合并尾巴限容', () => {
        const sys = Array.from({ length: 80 }, (_, i) => `### 块${i}\n内容${i}`).join('\n');
        const blocks = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }] })!;
        expect(blocks.length).toBeLessThanOrEqual(48);
        expect(blocks[blocks.length - 1].label).toContain('其余');
    });
});
