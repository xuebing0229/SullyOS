import { describe, expect, it } from 'vitest';
import {
    parseStoryInlineImagePlan,
    storyInlineImageVisibleText,
} from './storyTheaterImage';

describe('story inline image plan protocol', () => {
    it('strips a valid hidden plan and returns executable data', () => {
        const raw = `第一段正文。\n\n第二段正文。\n<story_image_plan>\n{"tool":"image_demo_generate","arguments":{"prompt":"two people in a rainy station","width":1216,"height":832}}\n</story_image_plan>`;
        const parsed = parseStoryInlineImagePlan(raw);

        expect(parsed.content).toBe('第一段正文。\n\n第二段正文。');
        expect(parsed.plan).toEqual({
            tool: 'image_demo_generate',
            arguments: {
                prompt: 'two people in a rainy station',
                width: 1216,
                height: 832,
            },
        });
    });

    it('keeps ordinary story output unchanged when no plan exists', () => {
        expect(parseStoryInlineImagePlan('只有正文。')).toEqual({ content: '只有正文。' });
    });

    it('hides a malformed or interrupted control block from saved story text', () => {
        const raw = '正文已经完整结束。\n<story_image_plan>\n{"tool":"image_demo_generate"';
        expect(parseStoryInlineImagePlan(raw)).toEqual({ content: '正文已经完整结束。' });
    });

    it('does not flash a partial opening marker during streaming', () => {
        expect(storyInlineImageVisibleText('正文。\n<story_')).toBe('正文。');
        expect(storyInlineImageVisibleText('正文。\n<story_image_plan>{"tool":"x"}')).toBe('正文。');
    });
});
