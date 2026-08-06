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
});
