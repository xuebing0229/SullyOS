import { describe, expect, it } from 'vitest';
import { augmentImageToolSchema, parseImageToolClientOptions } from './imageToolPostAction';

describe('imageToolPostAction', () => {
    it('defaults to none and strips client fields', () => {
        expect(parseImageToolClientOptions({ prompt: 'x' })).toEqual({
            afterGenerateAction: 'none', cleanedArgs: { prompt: 'x' },
        });
    });
    it('recognizes inspect and strips snake case', () => {
        expect(parseImageToolClientOptions({ prompt: 'x', after_generate_action: 'inspect' })).toEqual({
            afterGenerateAction: 'inspect', cleanedArgs: { prompt: 'x' },
        });
    });
    it('falls back for invalid values and strips camel case', () => {
        expect(parseImageToolClientOptions({ afterGenerateAction: 'later' })).toEqual({
            afterGenerateAction: 'none', cleanedArgs: {},
        });
    });
    it('augments a clone without mutating the source', () => {
        const source = { type: 'object', properties: { prompt: { type: 'string' } } };
        const result = augmentImageToolSchema(source);
        expect(result).not.toBe(source);
        expect(result.properties.after_generate_action.enum).toEqual(['none', 'inspect']);
        expect(source.properties).not.toHaveProperty('after_generate_action');
    });
    it('adds per-call reference choices only to the NovelAI tool', () => {
        const source = { type: 'object', properties: { prompt: { type: 'string' } } };
        const novel = augmentImageToolSchema(source, 'novelai_generate_image');
        const gpt = augmentImageToolSchema(source, 'generate_image');
        expect(novel.properties.use_character_reference).toMatchObject({ type: 'boolean', default: true });
        expect(novel.properties.use_user_reference).toMatchObject({ type: 'boolean', default: true });
        expect(gpt.properties).not.toHaveProperty('use_character_reference');
        expect(gpt.properties).not.toHaveProperty('use_user_reference');
    });
    it('teaches NovelAI planners to isolate multi-character traits in pipe-separated prompts', () => {
        const source = {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: '最终提示词。' },
            },
        };
        const novel = augmentImageToolSchema(source, 'novelai_generate_image');
        const description = String(novel.properties.prompt.description || '');
        expect(description).toContain('最终提示词。');
        expect(description).toContain('基础场景 | 角色1 | 角色2');
        expect(description).toContain('严禁把一个角色的眼睛/头发等身份特征复制到另一个角色段');
        expect(String(novel.properties.use_character_reference.description)).toContain('多人画面');
        expect(String(novel.properties.use_user_reference.description)).toContain('多人画面');
    });
    it('omits both Precise Reference choices when the active preset disallows character reference', () => {
        const novel = augmentImageToolSchema(
            { type: 'object', properties: { prompt: { type: 'string' } } },
            'novelai_generate_image',
            { allowCharacterReference: false },
        );
        expect(novel.properties).not.toHaveProperty('use_character_reference');
        expect(novel.properties).not.toHaveProperty('use_user_reference');
        expect(String(novel.properties.prompt.description)).toContain('基础场景 | 角色1 | 角色2');
    });
});
