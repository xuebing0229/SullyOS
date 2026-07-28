import { describe, expect, it } from 'vitest';
import {
    containsKnownTextToolCall,
    shouldPersistChatCompletion,
} from './chatResponseCachePolicy';

describe('chat response cache policy', () => {
    it('caches a normal final text response', () => {
        expect(shouldPersistChatCompletion({
            choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: '好，我知道了。' },
            }],
        })).toBe(true);
    });

    it('does not cache native tool calls', () => {
        expect(shouldPersistChatCompletion({
            choices: [{
                finish_reason: 'tool_calls',
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: '1', function: { name: 'get_weather' } }],
                },
            }],
        })).toBe(false);
    });

    it('does not cache a known text fallback tool call', () => {
        expect(shouldPersistChatCompletion({
            choices: [{
                finish_reason: 'stop',
                message: {
                    role: 'assistant',
                    content: 'generate_image({"prompt":"cat"})',
                },
            }],
        }, { knownTextToolNames: ['generate_image'] })).toBe(false);
    });

    it('does not treat an unknown ordinary function word as a tool call', () => {
        expect(containsKnownTextToolCall(
            '我觉得 calculate(x) 只是一个例子。',
            ['generate_image'],
        )).toBe(false);
    });
});
