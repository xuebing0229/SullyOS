import { describe, expect, it } from 'vitest';
import { extractStoryImagePlannerJsonSelection } from './storyImagePlannerCompat';

describe('story image planner JSON compatibility', () => {
    const allowed = ['image_novelai', 'image_gpt'];

    it('accepts a plain JSON tool selection', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"tool":"image_novelai","arguments":{"prompt":"rainy platform"}}',
            allowed,
        )).toEqual({ tool: 'image_novelai', arguments: { prompt: 'rainy platform' } });
    });

    it('accepts fenced JSON and stringified function arguments', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '```json\n{"function":{"name":"image_gpt","arguments":"{\\"prompt\\":\\"night street\\"}"}}\n```',
            allowed,
        )).toEqual({ tool: 'image_gpt', arguments: { prompt: 'night street' } });
    });

    it('rejects unknown tools', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"tool":"unknown_tool","arguments":{"prompt":"nope"}}',
            allowed,
        )).toBeNull();
    });
});
