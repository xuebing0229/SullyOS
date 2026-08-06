import { describe, expect, it } from 'vitest';
import type { APIConfig } from '../types';
import { applyApiPresetConfig, buildApiPresetConfig, mergeApiPresetPatch } from './apiPresetConfig';

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

});
