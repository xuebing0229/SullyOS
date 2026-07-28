import { describe, expect, it } from 'vitest';
import type { APIConfig, ApiPreset } from '../types';
import { createDefaultApiFailoverGroup } from './apiFailover';
import { analyzeApiFailoverGroup } from './apiFailoverGroupAnalysis';

const config = (model: string): APIConfig => ({
    baseUrl: 'https://example.com/v1',
    apiKey: 'secret',
    model,
    stream: true,
});

const presets: ApiPreset[] = [
    { id: 'a', name: 'A', config: config('gemini-3.1-pro-preview') },
    { id: 'b', name: 'B', config: config('(按次)gemini-3.1-pro-preview') },
    { id: 'c', name: 'C', config: config('claude-sonnet') },
];

const group = (ids: string[]) => ({
    ...createDefaultApiFailoverGroup('chat'),
    enabled: true,
    members: ids.map(presetId => ({ presetId, enabled: true })),
});

describe('api failover group analysis', () => {
    it('keeps one API as valid direct route but cannot enable failover', () => {
        const result = analyzeApiFailoverGroup(group(['a']), presets);
        expect(result.routes).toHaveLength(1);
        expect(result.canEnable).toBe(false);
        expect(result.reason).toBe('not_enough_routes');
    });

    it('allows two compatible API presets', () => {
        const result = analyzeApiFailoverGroup(group(['a', 'b']), presets);
        expect(result.routes.map(route => route.presetId)).toEqual(['a', 'b']);
        expect(result.canEnable).toBe(true);
    });

    it('marks incompatible model instead of pretending there are two routes', () => {
        const result = analyzeApiFailoverGroup(group(['a', 'c']), presets);
        expect(result.routes.map(route => route.presetId)).toEqual(['a']);
        expect(result.members[1].issue).toBe('incompatible_model');
        expect(result.canEnable).toBe(false);
    });

    it('marks a deleted preset as missing', () => {
        const result = analyzeApiFailoverGroup(group(['a', 'gone']), presets);
        expect(result.members[1].issue).toBe('missing_preset');
        expect(result.canEnable).toBe(false);
    });
});
