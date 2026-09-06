import { describe, expect, it } from 'vitest';

import type { APIConfig, ApiPreset } from '../types';
import {
    createDefaultApiFailoverGroup,
    resolveApiExecutionPlanWithData,
} from './apiFailover';

const api = (baseUrl: string, model: string): APIConfig => ({
    baseUrl,
    apiKey: `key-${baseUrl}`,
    model,
    stream: true,
});

const presetA: ApiPreset = {
    id: 'preset-a',
    name: 'Old A',
    config: api('https://a.example/v1', 'old-model'),
};

const presetB: ApiPreset = {
    id: 'preset-b',
    name: 'Selected B',
    config: api('https://b.example/v1', 'new-model'),
};

const storyGroup = (
    members: Array<{ presetId: string; model?: string; enabled: boolean }>,
    enabled = false,
) => ({
    ...createDefaultApiFailoverGroup('story'),
    enabled,
    members,
    updatedAt: 123,
});

describe('story primary preset selection', () => {
    it('uses preset B instead of the current/global preset A', () => {
        const plan = resolveApiExecutionPlanWithData(
            'story',
            presetA.config,
            [storyGroup([
                { presetId: 'preset-b', model: 'new-model', enabled: true },
                { presetId: 'preset-a', model: 'old-model', enabled: true },
            ])],
            [presetA, presetB],
            true,
        );

        expect(plan.mode).toBe('direct');
        expect(plan.routes[0]).toMatchObject({
            presetId: 'preset-b',
            api: {
                baseUrl: 'https://b.example/v1',
                model: 'new-model',
            },
        });
    });

    it('does not skip a disabled selected B and silently run backup A', () => {
        expect(() => resolveApiExecutionPlanWithData(
            'story',
            presetA.config,
            [storyGroup([
                { presetId: 'preset-b', model: 'new-model', enabled: false },
                { presetId: 'preset-a', model: 'old-model', enabled: true },
            ])],
            [presetA, presetB],
            true,
        )).toThrow(/presetId=preset-b.*issue=disabled/);
    });

    it('does not skip a missing selected B and silently run backup A', () => {
        expect(() => resolveApiExecutionPlanWithData(
            'story',
            presetA.config,
            [storyGroup([
                { presetId: 'preset-b', model: 'new-model', enabled: true },
                { presetId: 'preset-a', model: 'old-model', enabled: true },
            ])],
            [presetA],
            true,
        )).toThrow(/presetId=preset-b.*issue=missing_preset/);
    });

    it('uses the current/global API only when no story primary is configured', () => {
        const plan = resolveApiExecutionPlanWithData(
            'story',
            presetA.config,
            [storyGroup([])],
            [presetA, presetB],
            true,
        );

        expect(plan.routes[0]).toMatchObject({
            presetId: 'preset-a',
            api: {
                baseUrl: 'https://a.example/v1',
                model: 'old-model',
            },
        });
    });

    it('never falls back to global A when an enabled story group has no usable routes', () => {
        expect(() => resolveApiExecutionPlanWithData(
            'story',
            presetA.config,
            [storyGroup([
                { presetId: 'preset-b', model: 'new-model', enabled: true },
            ], true)],
            [presetA],
            true,
        )).toThrow(/剧情 API 线路不可用.*presetId=preset-b/);
    });
});
