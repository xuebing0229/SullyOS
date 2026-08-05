import { describe, expect, it } from 'vitest';

import type { APIConfig, ApiPreset } from '../types';
import {
    extractBearerCredential,
    findApiPresetForConfig,
    matchApiPresetRoute,
} from './apiPresetRouteIdentity';

const api = (
    apiKey: string,
    baseUrl = 'https://same.example/v1',
    model = 'claude-opus-4-6',
): APIConfig => ({
    baseUrl,
    apiKey,
    model,
});

const presets: ApiPreset[] = [
    { id: 'line-a', name: '线路 A', config: api('key-a') },
    { id: 'line-b', name: '线路 B', config: api('key-b') },
];

describe('API preset route identity', () => {
    it('uses the real request credential to distinguish identical base/model routes', () => {
        const result = matchApiPresetRoute(presets, {
            baseUrl: 'https://same.example/v1/',
            model: 'claude-opus-4-6',
            apiKey: 'key-b',
        });

        expect(result.preset?.id).toBe('line-b');
        expect(result.matchedBy).toBe('credential');
    });

    it('honors an explicit preset id when it matches the real route', () => {
        const result = matchApiPresetRoute(presets, {
            baseUrl: 'https://same.example/v1',
            model: 'claude-opus-4-6',
            apiKey: 'key-a',
            preferredPresetId: 'line-a',
        });

        expect(result.preset?.id).toBe('line-a');
        expect(result.matchedBy).toBe('preferred_id');
    });

    it('does not trust a stale explicit id over the actual credential', () => {
        const result = matchApiPresetRoute(presets, {
            baseUrl: 'https://same.example/v1',
            model: 'claude-opus-4-6',
            apiKey: 'key-b',
            preferredPresetId: 'line-a',
        });

        expect(result.preset?.id).toBe('line-b');
    });

    it('keeps truly identical duplicate presets ambiguous', () => {
        const result = matchApiPresetRoute(
            [
                ...presets,
                {
                    id: 'line-b-copy',
                    name: '线路 B 副本',
                    config: api('key-b'),
                },
            ],
            {
                baseUrl: 'https://same.example/v1',
                model: 'claude-opus-4-6',
                apiKey: 'key-b',
            },
        );

        expect(result.preset).toBeUndefined();
        expect(result.reason).toBe('preset_ambiguous');
        expect(result.candidatePresetIds).toEqual([
            'line-b',
            'line-b-copy',
        ]);
    });

    it('extracts Bearer credentials', () => {
        expect(extractBearerCredential({
            Authorization: 'Bearer key-b',
        })).toBe('key-b');

        expect(extractBearerCredential([
            ['authorization', 'Bearer key-a'],
        ])).toBe('key-a');
    });

    it('resolves a direct API config to its exact saved preset', () => {
        expect(
            findApiPresetForConfig(presets, api('key-b'))?.id,
        ).toBe('line-b');
    });
});
