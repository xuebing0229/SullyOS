import { beforeEach, describe, expect, it } from 'vitest';

import type { APIConfig, ApiPreset } from '../types';
import {
    ApiRouteError,
    classifyApiError,
    createDefaultApiFailoverGroup,
    resetApiFailoverRuntime,
    resolveApiExecutionPlanWithData,
    runApiFailover,
    type ApiExecutionPlan,
} from './apiFailover';

const api = (
    baseUrl: string,
    model = 'gemini-3.1-pro-preview',
): APIConfig => ({
    baseUrl,
    apiKey: `key-${baseUrl}`,
    model,
    stream: false,
    temperature: 0.85,
});

const presets: ApiPreset[] = [
    { id: 'a', name: 'A', config: api('https://a.example/v1') },
    { id: 'b', name: 'B', config: api('https://b.example/v1') },
    { id: 'c', name: 'C', config: api('https://c.example/v1', 'claude-sonnet') },
];

function plan(overrides: Record<string, unknown> = {}): ApiExecutionPlan {
    const group = {
        ...createDefaultApiFailoverGroup('chat'),
        enabled: true,
        members: [
            { presetId: 'a', enabled: true },
            { presetId: 'b', enabled: true },
        ],
        policy: {
            ...createDefaultApiFailoverGroup('chat').policy,
            consecutiveFailureThreshold: 10,
            cooldownMs: 60_000,
            ...overrides,
        },
        updatedAt: 1,
    };
    return resolveApiExecutionPlanWithData(
        'chat',
        api('https://direct.example/v1'),
        [group],
        presets,
        true,
    );
}

beforeEach(() => {
    resetApiFailoverRuntime();
});

describe('error classification', () => {
    it('retries network and 503 errors', () => {
        expect(classifyApiError(
            new TypeError('Failed to fetch'),
        )).toMatchObject({
            kind: 'network',
            retrySameRoute: true,
            failoverEligible: true,
        });

        expect(classifyApiError(
            new Error('API Error 503: unavailable'),
        )).toMatchObject({
            kind: 'server',
            retrySameRoute: true,
            failoverEligible: true,
            status: 503,
        });
    });

    it('fails over 429 without retrying the same route', () => {
        expect(classifyApiError(
            new Error('API Error 429: rate limit'),
        )).toMatchObject({
            kind: 'rate_limit',
            retrySameRoute: false,
            failoverEligible: true,
        });
    });

    it('does not fail over ordinary 400 or safety errors', () => {
        expect(classifyApiError(
            new Error('API Error 400: invalid parameter'),
        )).toMatchObject({
            kind: 'bad_request',
            failoverEligible: false,
        });

        expect(classifyApiError(
            new Error('API Error 403: content policy blocked'),
        )).toMatchObject({
            kind: 'safety',
            failoverEligible: false,
        });
    });

    it('does not fail over after stream output has started', () => {
        expect(classifyApiError(
            new TypeError('Failed to fetch'),
            { streamStarted: true },
        )).toMatchObject({
            kind: 'stream_committed',
            failoverEligible: false,
        });
    });
});

describe('plan resolution', () => {
    it('keeps route order and filters a different model family', () => {
        const group = {
            ...createDefaultApiFailoverGroup('chat'),
            enabled: true,
            members: [
                { presetId: 'a', enabled: true },
                { presetId: 'c', enabled: true },
                { presetId: 'b', enabled: true },
            ],
            updatedAt: 10,
        };

        const resolved = resolveApiExecutionPlanWithData(
            'chat',
            api('https://direct.example/v1'),
            [group],
            presets,
            true,
        );

        expect(resolved.routes.map(route => route.presetId))
            .toEqual(['a', 'b']);
        expect(resolved.cacheIdentity).not.toContain('key-');
    });

    it('changes cache identity when group order changes', () => {
        const first = {
            ...createDefaultApiFailoverGroup('chat'),
            enabled: true,
            members: [
                { presetId: 'a', enabled: true },
                { presetId: 'b', enabled: true },
            ],
            updatedAt: 1,
        };
        const second = {
            ...first,
            members: [...first.members].reverse(),
            updatedAt: 2,
        };

        const one = resolveApiExecutionPlanWithData(
            'chat',
            api('https://direct.example/v1'),
            [first],
            presets,
            true,
        );
        const two = resolveApiExecutionPlanWithData(
            'chat',
            api('https://direct.example/v1'),
            [second],
            presets,
            true,
        );

        expect(one.cacheIdentity).not.toBe(two.cacheIdentity);
    });
});

describe('failover execution', () => {
    it('retries primary twice, then succeeds on secondary', async () => {
        const calls: string[] = [];
        const result = await runApiFailover({
            plan: plan({ routeMaxAttempts: 2 }),
            execute: async route => {
                calls.push(route.presetId);
                if (route.presetId === 'a') {
                    throw new TypeError('Failed to fetch');
                }
                return 'ok';
            },
        });

        expect(calls).toEqual(['a', 'a', 'b']);
        expect(result.value).toBe('ok');
        expect(result.route.presetId).toBe('b');
    });

    it('moves directly to secondary on 429', async () => {
        const calls: string[] = [];
        const result = await runApiFailover({
            plan: plan({ routeMaxAttempts: 3 }),
            execute: async route => {
                calls.push(route.presetId);
                if (route.presetId === 'a') {
                    throw new Error('API Error 429: rate limit');
                }
                return 'ok';
            },
        });

        expect(calls).toEqual(['a', 'b']);
        expect(result.route.presetId).toBe('b');
    });

    it('does not hide an ordinary 400 by trying backup', async () => {
        const calls: string[] = [];
        await expect(runApiFailover({
            plan: plan(),
            execute: async route => {
                calls.push(route.presetId);
                throw new Error('API Error 400: invalid tools');
            },
        })).rejects.toBeInstanceOf(ApiRouteError);

        expect(calls).toEqual(['a']);
    });

    it('does not fail over after stream started', async () => {
        const calls: string[] = [];
        await expect(runApiFailover({
            plan: plan(),
            execute: async (route, context) => {
                calls.push(route.presetId);
                context.markStreamStarted();
                throw new TypeError('Failed to fetch');
            },
        })).rejects.toBeInstanceOf(ApiRouteError);

        expect(calls).toEqual(['a']);
    });

    it('opens the primary circuit and skips it on a later request', async () => {
        const breakerPlan = plan({
            routeMaxAttempts: 1,
            consecutiveFailureThreshold: 2,
            cooldownMs: 60_000,
        });
        const calls: string[] = [];

        const execute = async (route: any) => {
            calls.push(route.presetId);
            if (route.presetId === 'a') {
                throw new TypeError('Failed to fetch');
            }
            return 'backup';
        };

        await runApiFailover({ plan: breakerPlan, execute });
        await runApiFailover({ plan: breakerPlan, execute });
        calls.length = 0;

        const third = await runApiFailover({
            plan: breakerPlan,
            execute,
        });

        expect(calls).toEqual(['b']);
        expect(third.route.presetId).toBe('b');
        expect(third.attempts.some(item =>
            item.presetId === 'a'
            && item.phase === 'skipped'
            && item.classification?.kind === 'circuit_open'
        )).toBe(true);
    });
});
