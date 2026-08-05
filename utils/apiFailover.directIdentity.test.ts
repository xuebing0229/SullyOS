import { describe, expect, it } from 'vitest';

import type { APIConfig, ApiPreset } from '../types';
import {
    resolveApiExecutionPlanWithData,
} from './apiFailover';

const config = (key: string): APIConfig => ({
    baseUrl: 'https://relay.example/v1',
    apiKey: key,
    model: 'claude-opus-4-6',
    stream: false,
});

describe('direct API route identity', () => {
    it('keeps the exact preset id even when failover is disabled', () => {
        const presets: ApiPreset[] = [
            { id: 'route-a', name: '线路 A', config: config('key-a') },
            { id: 'route-b', name: '线路 B', config: config('key-b') },
        ];

        const plan = resolveApiExecutionPlanWithData(
            'chat',
            config('key-b'),
            [],
            presets,
            true,
        );

        expect(plan.mode).toBe('direct');
        expect(plan.routes[0].presetId).toBe('route-b');
        expect(plan.routes[0].presetName).toBe('线路 B');
        expect(plan.cacheIdentity).toContain('route-b');
        expect(plan.cacheIdentity).not.toContain('key-b');
    });
});
