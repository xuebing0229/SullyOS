import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiPreset } from '../types';
import { captureApiBillingContext } from './apiCallLog';

const storage = new Map<string, string>();

beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
            storage.set(key, value);
        },
        removeItem: (key: string) => {
            storage.delete(key);
        },
        clear: () => storage.clear(),
    });
});

describe('API billing capture route identity', () => {
    it('attributes a naked App fetch by its Authorization credential', () => {
        const presets: ApiPreset[] = [
            {
                id: 'ding-a',
                name: '叮咚鸡 A',
                config: {
                    baseUrl: 'https://relay.example/v1',
                    apiKey: 'key-a',
                    model: 'claude-opus-4-6',
                },
                pricing: {
                    mode: 'per_request',
                    pricePerRequestYuan: '0.12',
                },
            },
            {
                id: 'ding-b',
                name: '叮咚鸡 B',
                config: {
                    baseUrl: 'https://relay.example/v1',
                    apiKey: 'key-b',
                    model: 'claude-opus-4-6',
                },
                pricing: {
                    mode: 'per_request',
                    pricePerRequestYuan: '0.20',
                },
            },
        ];
        localStorage.setItem(
            'os_api_presets',
            JSON.stringify(presets),
        );

        const capture = captureApiBillingContext(
            'https://relay.example/v1/chat/completions',
            JSON.stringify({ model: 'claude-opus-4-6' }),
            undefined,
            { Authorization: 'Bearer key-b' },
        );

        expect(capture.presetId).toBe('ding-b');
        expect(capture.presetName).toBe('叮咚鸡 B');
        expect(
            capture.pricingSnapshot?.pricing,
        ).toEqual({
            mode: 'per_request',
            pricePerRequestYuan: '0.20',
        });
        expect(capture.missingPresetReason).toBeUndefined();
    });

    it('uses different prices for different models under one connection preset', () => {
        const presets: ApiPreset[] = [
            {
                id: 'multi',
                name: '同一站子',
                config: {
                    baseUrl: 'https://relay.example/v1',
                    apiKey: 'key-multi',
                    model: 'model-b',
                },
                models: [
                    {
                        model: 'model-a',
                        pricing: { mode: 'per_request', pricePerRequestYuan: '0.10' },
                    },
                    {
                        model: 'model-b',
                        pricing: { mode: 'per_request', pricePerRequestYuan: '0.35' },
                    },
                ],
            },
        ];
        localStorage.setItem('os_api_presets', JSON.stringify(presets));

        const captureA = captureApiBillingContext(
            'https://relay.example/v1/chat/completions',
            JSON.stringify({ model: 'model-a' }),
            undefined,
            { Authorization: 'Bearer key-multi' },
        );
        const captureB = captureApiBillingContext(
            'https://relay.example/v1/chat/completions',
            JSON.stringify({ model: 'model-b' }),
            undefined,
            { Authorization: 'Bearer key-multi' },
        );

        expect(captureA.presetId).toBe('multi');
        expect(captureA.pricingSnapshot?.pricing).toMatchObject({ pricePerRequestYuan: '0.10' });
        expect(captureB.presetId).toBe('multi');
        expect(captureB.pricingSnapshot?.pricing).toMatchObject({ pricePerRequestYuan: '0.35' });
    });

    it('recovers the active preset when the relay rewrites the model alias', () => {
        const presets: ApiPreset[] = [
            {
                id: 'zhuanzhuan',
                name: '转转',
                config: {
                    baseUrl: 'https://relay.example/v1',
                    apiKey: 'key-z',
                    model: 'gemini-3.7-flash',
                },
                pricing: {
                    mode: 'per_request',
                    pricePerRequestYuan: '0.08',
                },
            },
        ];
        localStorage.setItem(
            'os_api_presets',
            JSON.stringify(presets),
        );
        localStorage.setItem(
            'os_active_api_preset_id',
            'zhuanzhuan',
        );

        const capture = captureApiBillingContext(
            'https://relay.example/v1/chat/completions',
            JSON.stringify({ model: 'gemini-3.7-flash-high' }),
            undefined,
            { Authorization: 'Bearer key-z' },
        );

        expect(capture.presetId).toBe('zhuanzhuan');
        expect(capture.presetName).toBe('转转');
        expect(capture.pricingSnapshot?.pricing).toEqual({
            mode: 'per_request',
            pricePerRequestYuan: '0.08',
        });
        expect(capture.missingPresetReason).toBeUndefined();
    });

    it('trusts the explicit routed preset id for billing', () => {
        const presets: ApiPreset[] = [
            {
                id: 'route-a',
                name: '转转',
                config: {
                    baseUrl: 'https://relay.example/v1',
                    apiKey: 'key-a',
                    model: 'gemini-3.7-flash',
                },
                pricing: {
                    mode: 'per_request',
                    pricePerRequestYuan: '0.08',
                },
            },
        ];
        localStorage.setItem(
            'os_api_presets',
            JSON.stringify(presets),
        );

        const capture = captureApiBillingContext(
            'https://relay.example/v1/chat/completions',
            JSON.stringify({ model: 'gemini-3.7-flash-high' }),
            'route-a',
            { Authorization: 'Bearer key-a' },
        );

        expect(capture.presetId).toBe('route-a');
        expect(capture.presetName).toBe('转转');
        expect(capture.pricingSnapshot?.pricing).toEqual({
            mode: 'per_request',
            pricePerRequestYuan: '0.08',
        });
        expect(capture.missingPresetReason).toBeUndefined();
    });
});
