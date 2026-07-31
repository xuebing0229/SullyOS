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
});
