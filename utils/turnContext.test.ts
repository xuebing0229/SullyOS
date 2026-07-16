import { describe, expect, it } from 'vitest';
import { appendTurnContext, TURN_CONTEXT_OPEN } from './turnContext';

describe('turn context snapshot', () => {
    it('binds the snapshot to a text user message', () => {
        const result = appendTurnContext('[12:00] [聊天] 你好', '当前时间：12:00');
        expect(result).toContain(TURN_CONTEXT_OPEN);
        expect(result).toContain('当前时间：12:00');
    });

    it('does not append the snapshot twice on retry/page restore', () => {
        const once = appendTurnContext('你好', 'snapshot-a');
        const twice = appendTurnContext(once, 'snapshot-b');
        expect(twice).toBe(once);
        expect(twice.match(/Turn Context Snapshot/g)).toHaveLength(2);
    });

    it('preserves multimodal content and adds the snapshot to its text part', () => {
        const input = [
            { type: 'text', text: '看这张图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
        ];
        const result = appendTurnContext(input, '当前情绪：平静');
        expect(result).not.toBe(input);
        expect(result[0].text).toContain('当前情绪：平静');
        expect(result[1]).toEqual(input[1]);
    });
});
