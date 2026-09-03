import { describe, expect, it } from 'vitest';
import type { ApiPreset } from '../types';
import {
  apiPresetHasModel,
  getApiPresetModelEntries,
  getApiPresetPricing,
  removeApiPresetModel,
  setApiPresetDefaultModel,
  setApiPresetModelPricing,
} from './apiPresetModels';

const legacy = (): ApiPreset => ({
  id: 'p1',
  name: '站子',
  config: {
    baseUrl: 'https://example.com/v1',
    apiKey: 'key',
    model: 'model-a',
  },
  pricing: {
    mode: 'per_request',
    pricePerRequestYuan: '0.1',
  },
});

describe('API preset multi-model helpers', () => {
  it('reads an old one-model preset as one model with its old price', () => {
    expect(getApiPresetModelEntries(legacy())).toEqual([
      {
        model: 'model-a',
        pricing: {
          mode: 'per_request',
          pricePerRequestYuan: '0.1',
        },
      },
    ]);
  });

  it('keeps prices isolated per model', () => {
    let preset = setApiPresetModelPricing(
      legacy(),
      'model-b',
      { mode: 'per_request', pricePerRequestYuan: '0.2' },
    );
    preset = setApiPresetDefaultModel(preset, 'model-b');

    expect(apiPresetHasModel(preset, 'model-a')).toBe(true);
    expect(apiPresetHasModel(preset, 'model-b')).toBe(true);
    expect(getApiPresetPricing(preset, 'model-a')).toMatchObject({
      pricePerRequestYuan: '0.1',
    });
    expect(getApiPresetPricing(preset, 'model-b')).toMatchObject({
      pricePerRequestYuan: '0.2',
    });
  });

  it('removes a non-default model without changing the default', () => {
    const preset = {
      ...legacy(),
      models: [
        { model: 'model-a' },
        { model: 'model-b' },
      ],
    };
    const removed = removeApiPresetModel(preset, 'model-b');
    expect(getApiPresetModelEntries(removed).map(item => item.model)).toEqual(['model-a']);
    expect(removed.config.model).toBe('model-a');
  });

  it('moves the default to the first remaining model when deleting the old default', () => {
    const preset = {
      ...legacy(),
      models: [
        { model: 'model-a' },
        { model: 'model-b' },
      ],
    };
    const removed = removeApiPresetModel(preset, 'model-a');
    expect(getApiPresetModelEntries(removed).map(item => item.model)).toEqual(['model-b']);
    expect(removed.config.model).toBe('model-b');
  });

  it('refuses to remove the last model from a preset', () => {
    const removed = removeApiPresetModel(legacy(), 'model-a');
    expect(getApiPresetModelEntries(removed).map(item => item.model)).toEqual(['model-a']);
    expect(removed.config.model).toBe('model-a');
  });

  it('does not borrow another model price when an exact multi-model price is absent', () => {
    const preset = {
      ...legacy(),
      models: [
        { model: 'model-a', pricing: { mode: 'per_request' as const, pricePerRequestYuan: '0.1' } },
        { model: 'model-b' },
      ],
    };
    expect(getApiPresetPricing(preset, 'model-b')).toBeUndefined();
  });
});
