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

    it('accepts Gemini-style functionCall args', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"functionCall":{"name":"image_novelai","args":{"prompt":"silver hair, casino"}}}',
            allowed,
        )).toEqual({ tool: 'image_novelai', arguments: { prompt: 'silver hair, casino' } });
    });

    it('accepts nested tool_calls arrays', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"tool_calls":[{"type":"function","function":{"name":"image_gpt","arguments":"{\\"prompt\\":\\"rain\\"}"}}]}',
            allowed,
        )).toEqual({ tool: 'image_gpt', arguments: { prompt: 'rain' } });
    });

    it('accepts tool-name-keyed JSON', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"image_novelai":{"prompt":"green eyes only"}}',
            allowed,
        )).toEqual({ tool: 'image_novelai', arguments: { prompt: 'green eyes only' } });
    });

    it('accepts inline arguments beside an explicit tool name', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"tool":"image_gpt","prompt":"clean portrait","size":"1024x1024"}',
            allowed,
        )).toEqual({ tool: 'image_gpt', arguments: { prompt: 'clean portrait', size: '1024x1024' } });
    });

    it('salvages prose-wrapped arguments only when exactly one real tool is named', () => {
        expect(extractStoryImagePlannerJsonSelection(
            'I will use image_novelai.\n```json\n{"prompt":"warm indoor scene","steps":28}\n```',
            allowed,
        )).toEqual({ tool: 'image_novelai', arguments: { prompt: 'warm indoor scene', steps: 28 } });
    });

    it('accepts arguments-only JSON when only one tool exists', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"prompt":"single route"}',
            ['image_novelai'],
        )).toEqual({ tool: 'image_novelai', arguments: { prompt: 'single route' } });
    });

    it('does not guess a preset from ambiguous arguments-only JSON', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"prompt":"do not silently pick the first preset"}',
            allowed,
        )).toBeNull();
    });

    it('rejects unknown tools', () => {
        expect(extractStoryImagePlannerJsonSelection(
            '{"tool":"unknown_tool","arguments":{"prompt":"nope"}}',
            allowed,
        )).toBeNull();
    });
});
