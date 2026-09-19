import { describe, expect, it } from 'vitest';
import {
    augmentStoryImagePlanningParameters,
    composeStoryImagePromptArguments,
} from './storyImagePromptLayers';

const params = augmentStoryImagePlanningParameters({
    type: 'object',
    properties: {
        prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
    },
    required: ['prompt'],
});

describe('story image prompt layers', () => {
    it('requires explicit character/user presence and dynamic fields in the planning schema', () => {
        expect(params.required).toEqual(expect.arrayContaining([
            'prompt',
            'story_include_character',
            'story_include_user',
            'story_character_dynamic_prompt',
            'story_user_dynamic_prompt',
        ]));
        expect(params.properties.prompt.description).toContain('客户端会在执行前');
        expect(params.properties).not.toHaveProperty('character_prompts');
    });

    it('role-only image includes role fixed prompt but excludes user fixed prompt', () => {
        const result = composeStoryImagePromptArguments({
            engineId: 'novelai',
            toolName: 'novelai_generate_image',
            parameters: params,
            layers: {
                character: 'black hair, green eyes only',
                user: 'silver hair, heterochromia',
                style: 'cinematic anime',
                negative: 'bad anatomy',
            },
            args: {
                prompt: 'prison corridor, medium shot',
                negative_prompt: 'text',
                story_include_character: true,
                story_include_user: false,
                story_character_dynamic_prompt: 'looking back, tense',
                story_user_dynamic_prompt: '',
            },
        });

        expect(result.arguments.prompt).toContain('black hair, green eyes only');
        expect(result.arguments.prompt).toContain('looking back, tense');
        expect(result.arguments.prompt).not.toContain('silver hair, heterochromia');
        expect(result.arguments.prompt).toContain('cinematic anime');
        expect(result.arguments.negative_prompt).toBe('text, bad anatomy');
        expect(result.arguments.use_user_reference).toBe(false);
        expect(result.arguments).not.toHaveProperty('story_include_character');
    });

    it('user-only image includes user fixed prompt but excludes role fixed prompt', () => {
        const result = composeStoryImagePromptArguments({
            engineId: 'novelai',
            toolName: 'novelai_generate_image',
            parameters: params,
            layers: {
                character: 'black hair, green eyes only',
                user: 'silver hair, heterochromia',
                style: 'cinematic anime',
            },
            args: {
                prompt: 'dim room, waist-up',
                story_include_character: false,
                story_include_user: true,
                story_character_dynamic_prompt: '',
                story_user_dynamic_prompt: 'sitting by the window',
            },
        });

        expect(result.arguments.prompt).toContain('silver hair, heterochromia');
        expect(result.arguments.prompt).not.toContain('black hair, green eyes only');
        expect(result.arguments.use_character_reference).toBe(false);
    });

    it('NovelAI two-person image uses native character prompts instead of pipe-separated base text', () => {
        const result = composeStoryImagePromptArguments({
            engineId: 'novelai',
            toolName: 'novelai_generate_image',
            parameters: params,
            layers: {
                character: 'black hair, green eyes only',
                user: 'silver hair, heterochromia',
                style: 'cinematic anime',
            },
            args: {
                prompt: 'narrow cell, medium shot, two people facing each other',
                story_include_character: true,
                story_include_user: true,
                story_character_dynamic_prompt: 'left side, gripping the door',
                story_user_dynamic_prompt: 'right side, leaning closer',
                character_prompts: ['planner must not own this'],
            },
        });

        expect(result.arguments.prompt).toBe(
            'narrow cell, medium shot, two people facing each other, cinematic anime, '
            + 'exactly two people, two distinct people, single scene',
        );
        expect(result.arguments.character_prompts).toEqual([
            'black hair, green eyes only, left side, gripping the door',
            'silver hair, heterochromia, right side, leaning closer',
        ]);
        expect(result.arguments.prompt).not.toContain(' | ');
        expect(result.arguments.negative_prompt).toContain('duplicate characters');
        expect(result.arguments.negative_prompt).toContain('mirrored duplicate');
    });

    it('pure scene keeps style and excludes both identity prompts', () => {
        const result = composeStoryImagePromptArguments({
            engineId: 'novelai',
            toolName: 'novelai_generate_image',
            parameters: params,
            layers: {
                character: 'black hair',
                user: 'silver hair',
                style: 'dramatic lighting',
            },
            args: {
                prompt: 'empty interrogation room',
                story_include_character: false,
                story_include_user: false,
                story_character_dynamic_prompt: '',
                story_user_dynamic_prompt: '',
            },
        });

        expect(result.arguments.prompt).toBe('empty interrogation room, dramatic lighting');
        expect(result.arguments.prompt).not.toContain('black hair');
        expect(result.arguments.prompt).not.toContain('silver hair');
    });

    it('refuses a new-format plan that lost its scene prompt', () => {
        expect(() => composeStoryImagePromptArguments({
            engineId: 'novelai',
            toolName: 'novelai_generate_image',
            parameters: params,
            layers: {
                character: 'black hair, green eyes only',
                user: 'silver hair, heterochromia',
                style: 'cinematic anime',
            },
            args: {
                prompt: '',
                story_include_character: true,
                story_include_user: false,
                story_character_dynamic_prompt: 'looking back',
                story_user_dynamic_prompt: '',
            },
        })).toThrow('没有返回场景/动作 prompt');
    });

    it('keeps legacy queued plans untouched when presence selectors are absent', () => {
        const args = { prompt: 'legacy final prompt', negative_prompt: 'legacy negative' };
        const result = composeStoryImagePromptArguments({
            engineId: 'novelai',
            toolName: 'novelai_generate_image',
            parameters: params,
            layers: {
                character: 'new fixed role',
                user: 'new fixed user',
                style: 'new style',
                negative: 'new negative',
            },
            args,
        });
        expect(result.arguments).toEqual(args);
    });
});
