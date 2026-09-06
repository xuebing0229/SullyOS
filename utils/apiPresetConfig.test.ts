import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIConfig } from '../types';
import { applyApiPresetConfig, buildApiPresetConfig, mergeApiPresetPatch } from './apiPresetConfig';

const API_FAILOVER_STORAGE_KEY = 'os_api_failover_groups_v1';

const stubLocalStorage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  });
  return store;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API preset chat-only config', () => {
  it('trims and stores exactly the five editable chat fields', () => {
    expect(buildApiPresetConfig({
      baseUrl: ' https://api.example/v1/ ',
      apiKey: ' sk-test ',
      model: ' model-a ',
      stream: true,
      temperature: 0.7,
    })).toEqual({
      baseUrl: 'https://api.example/v1/',
      apiKey: 'sk-test',
      model: 'model-a',
      stream: true,
      temperature: 0.7,
    });
  });

  it('falls back from an invalid temperature', () => {
    expect(buildApiPresetConfig({
      baseUrl: 'u', apiKey: 'k', model: 'm', stream: false, temperature: Number.NaN,
    }).temperature).toBe(0.85);
  });

  it('applies a preset while preserving unrelated global APIs', () => {
    const current: APIConfig = {
      baseUrl: 'old', apiKey: 'old-key', model: 'old-model', stream: false, temperature: 0.2,
      minimaxApiKey: 'minimax', minimaxGroupId: 'group', minimaxRegion: 'overseas',
      ttsProvider: 'fishaudio', fishAudioApiKey: 'fish', fishAudioModel: 's2-pro',
      aceStepApiKey: 'replicate', voicePrompts: { fishaudio: 'guide' },
    };
    expect(applyApiPresetConfig(current, {
      baseUrl: 'new', apiKey: 'new-key', model: 'new-model', stream: true, temperature: 1.1,
    })).toEqual({
      ...current,
      baseUrl: 'new', apiKey: 'new-key', model: 'new-model', stream: true, temperature: 1.1,
    });
  });

  it('preserves pricing when editing a preset connection and name', () => {
    const previous = {
      id: 'preset-1',
      name: 'Old',
      config: { baseUrl: 'old', apiKey: 'old-key', model: 'old-model' },
      pricing: { mode: 'per_request' as const, pricePerRequestYuan: '0.02' },
    };
    const config = { baseUrl: 'new', apiKey: 'new-key', model: 'new-model', stream: true, temperature: 0.9 };
    expect(mergeApiPresetPatch(previous, { name: 'New', config })).toEqual({
      ...previous,
      name: 'New',
      config,
    });
  });

  it('releases failover rows that were only pinned to the preset old default model', () => {
    stubLocalStorage();
    localStorage.setItem(API_FAILOVER_STORAGE_KEY, JSON.stringify([
      {
        id: 'failover_story',
        scope: 'story',
        updatedAt: 1,
        members: [
          { presetId: 'preset-1', model: 'old-model', enabled: true },
          { presetId: 'preset-1', model: 'alternate-model', enabled: true },
          { presetId: 'preset-2', model: 'old-model', enabled: true },
        ],
      },
    ]));

    const previous = {
      id: 'preset-1',
      name: 'Story API',
      config: { baseUrl: 'https://api.example/v1', apiKey: 'key', model: 'old-model' },
    };
    const config = {
      ...previous.config,
      model: 'new-model',
    };

    mergeApiPresetPatch(previous, { config });

    const stored = JSON.parse(localStorage.getItem(API_FAILOVER_STORAGE_KEY) || '[]');
    expect(stored[0].members).toEqual([
      { presetId: 'preset-1', enabled: true },
      { presetId: 'preset-1', model: 'alternate-model', enabled: true },
      { presetId: 'preset-2', model: 'old-model', enabled: true },
    ]);
    expect(stored[0].updatedAt).toBeGreaterThan(1);
  });

  it('does not rewrite routed model overrides when the preset default model did not change', () => {
    stubLocalStorage();
    const groups = [{
      id: 'failover_story',
      scope: 'story',
      updatedAt: 1,
      members: [{ presetId: 'preset-1', model: 'same-model', enabled: true }],
    }];
    localStorage.setItem(API_FAILOVER_STORAGE_KEY, JSON.stringify(groups));

    const previous = {
      id: 'preset-1',
      name: 'Story API',
      config: { baseUrl: 'old', apiKey: 'old-key', model: 'same-model' },
    };
    mergeApiPresetPatch(previous, {
      config: { baseUrl: 'new', apiKey: 'new-key', model: 'same-model' },
    });

    expect(JSON.parse(localStorage.getItem(API_FAILOVER_STORAGE_KEY) || '[]')).toEqual(groups);
  });
});
