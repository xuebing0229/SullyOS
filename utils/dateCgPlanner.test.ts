import { describe, expect, it } from 'vitest';
import {
    buildMeetingCgPromptLayers,
    buildMeetingSceneSummary,
    composeMeetingCgImageArguments,
    preferMeetingCgPortraitAspect,
    sanitizeMeetingMessageForCg,
} from './dateCgPlanner';
import { augmentStoryImagePlanningParameters } from './storyImagePromptLayers';

describe('date CG planner scene context', () => {
    it('prioritizes current meeting observation and keeps regenerate in the same scene', () => {
        const summary = buildMeetingSceneSummary({
            observation: {
                place: '咖啡馆靠窗座位',
                time: '傍晚',
                state: '亲近、放松',
                detail: '角色微微前倾，正看向用户',
            } as any,
            peekStatus: '不应覆盖观测',
            currentText: '不应覆盖观测',
            regenerate: true,
        });

        expect(summary).toContain('咖啡馆靠窗座位');
        expect(summary).toContain('角色微微前倾');
        expect(summary).toContain('保持同一场景');
        expect(summary).not.toContain('不应覆盖观测');
    });

    it('falls back to current meeting dialogue instead of unrelated chat history', () => {
        const summary = buildMeetingSceneSummary({
            currentText: '她把热饮推到用户面前',
            regenerate: false,
        });
        expect(summary).toContain('她把热饮推到用户面前');
    });

    it('strips meeting-only speaker, voice and sprite metadata before image planning', () => {
        const message = sanitizeMeetingMessageForCg({
            id: 7,
            charId: 'c1',
            role: 'assistant',
            type: 'text',
            content: '[shy] "[softly] 别躲。" [speaker:char] [v:happy]\n[normal] 他伸手替对方理好衣领。',
            timestamp: 123,
        } as any);

        expect(message.content).toContain('[softly] 别躲。');
        expect(message.content).toContain('他伸手替对方理好衣领');
        expect(message.content).not.toContain('[speaker:char]');
        expect(message.content).not.toContain('[v:happy]');
        expect(message.content).not.toContain('[shy]');
        expect(message.content).not.toContain('[normal]');
    });

    it('targets 9:20 vertical CG without injecting unrecognized size fields', () => {
        const args = { prompt: 'dramatic reunion' };
        expect(preferMeetingCgPortraitAspect(args)).toEqual({
            prompt: expect.stringContaining('9:20 width-to-height'),
        });
        const schema = {
            type: 'object',
            properties: { prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['1:1', '9:16', '9:20'] } },
        };
        const composed = preferMeetingCgPortraitAspect(args, schema);
        expect(composed.aspect_ratio).toBe('9:20');
        expect(composed.prompt).toContain('Portrait mobile CG');
        expect(args).toEqual({ prompt: 'dramatic reunion' });

        const fallback = preferMeetingCgPortraitAspect({ positive_prompt: 'one character' }, {
            properties: { positive_prompt: { type: 'string' }, size: { type: 'string', enum: ['1024x1024'] } },
        });
        expect(fallback.positive_prompt).toContain('9:20');
        expect(fallback).not.toHaveProperty('aspect_ratio');
        expect(fallback).not.toHaveProperty('prompt');
        expect(fallback).not.toHaveProperty('size');
    });

    it('reads the same fixed prompt layers as Story Theater and only applies the in-frame identity', () => {
        const char = {
            id: 'c1',
            name: '温鸣竹',
            avatar: '',
            dateCgImagePrompt: {
                stylePrompt: 'cinematic anime, soft rim light',
                negativePrompt: 'text, watermark',
                userAnchor: 'silver hair, blue eyes',
                characterAnchors: { c1: 'black hair, green eyes' },
            },
        } as any;

        expect(buildMeetingCgPromptLayers(char)).toEqual({
            character: 'black hair, green eyes',
            user: 'silver hair, blue eyes',
            style: 'cinematic anime, soft rim light',
            negative: 'text, watermark',
        });

        const parameters = augmentStoryImagePlanningParameters({
            type: 'object',
            properties: {
                prompt: { type: 'string' },
                negative_prompt: { type: 'string' },
                use_character_reference: { type: 'boolean' },
                use_user_reference: { type: 'boolean' },
            },
            required: ['prompt'],
        });

        const composed = composeMeetingCgImageArguments({
            char,
            toolName: 'novelai_generate_image',
            parameters,
            args: {
                prompt: 'close-up by the window',
                story_include_character: true,
                story_include_user: false,
                story_character_dynamic_prompt: 'looking over shoulder',
                story_user_dynamic_prompt: '',
                use_character_reference: true,
                use_user_reference: true,
            },
        });

        expect(composed.arguments.prompt).toContain('black hair, green eyes');
        expect(composed.arguments.prompt).toContain('cinematic anime, soft rim light');
        expect(composed.arguments.prompt).not.toContain('silver hair, blue eyes');
        expect(composed.arguments.negative_prompt).toContain('text, watermark');
        expect(composed.arguments.use_character_reference).toBe(true);
        expect(composed.arguments.use_user_reference).toBe(false);
        expect(composed.presence).toEqual({ character: true, user: false });
    });
});
