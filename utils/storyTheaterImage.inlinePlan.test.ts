import { describe, expect, it } from 'vitest';
import {
    parseStoryInlineImagePlan,
    serializeStoryImagePlannerPreset,
    storyInlineImageVisibleText,
} from './storyTheaterImage';

describe('story inline image plan protocol', () => {
    it('passes the complete resolved Story Theater preset document without selectively stripping fields', () => {
        const document = {
            schema: 'sullyos.story-preset' as const,
            version: 1 as const,
            name: '完整正文预设',
            description: 'planner should receive this too',
            generation: {
                temperature: 0.9,
                topP: 0.95,
                frequencyPenalty: 0.1,
                presencePenalty: 0.2,
                maxTokens: 4096,
            },
            prompts: [
                { id: 'enabled', name: '正文规则', enabled: true, role: 'system' as const, content: '完整规则正文' },
                { id: 'disabled', name: '关闭项', enabled: false, role: 'system' as const, content: '关闭项也属于完整预设文档' },
            ],
            assistantPrefill: '<story_text>',
        };

        const serialized = serializeStoryImagePlannerPreset(document);
        expect(JSON.parse(serialized)).toEqual(document);
        expect(serialized).toContain('关闭项也属于完整预设文档');
        expect(serialized).toContain('assistantPrefill');
        expect(serialized).toContain('generation');
    });

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
