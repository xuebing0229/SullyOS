import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { APIConfig, ApiPreset } from '../types';
import {
  loadGameHallAiSettings,
  resolveGameHallAi,
  saveGameHallAiSettings,
} from './gameHallAiSettings';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
});

const api = (
  key: string,
  model = 'claude-opus-4-6',
): APIConfig => ({
  baseUrl: 'https://relay.example/v1',
  apiKey: key,
  model,
  stream: false,
});

const presets: ApiPreset[] = [
  {
    id: 'a',
    name: '线路 A',
    config: api('key-a'),
  },
  {
    id: 'b',
    name: '线路 B',
    config: api('key-b'),
  },
];

describe('game hall API preset selector', () => {
  it('follows the global API by default', () => {
    const resolved = resolveGameHallAi({
      settings: {
        source: 'global',
        updatedAt: 0,
      },
      apiConfig: api('key-a'),
      apiPresets: presets,
      activeApiPresetId: 'a',
    });

    expect(resolved.apiConfig.apiKey)
      .toBe('key-a');
    expect(resolved.identity.presetId)
      .toBe('a');
  });

  it('uses the currently selected preset without changing global API', () => {
    const global = api('key-a');
    const resolved = resolveGameHallAi({
      settings: {
        source: 'preset',
        selectedPresetId: 'b',
        updatedAt: 0,
      },
      apiConfig: global,
      apiPresets: presets,
      activeApiPresetId: 'a',
    });

    expect(resolved.apiConfig.apiKey)
      .toBe('key-b');
    expect(global.apiKey)
      .toBe('key-a');
    expect(resolved.identity.presetId)
      .toBe('b');
  });

  it('can switch the selected preset at any time', () => {
    const first = resolveGameHallAi({
      settings: {
        source: 'preset',
        selectedPresetId: 'a',
        updatedAt: 1,
      },
      apiConfig: api('key-a'),
      apiPresets: presets,
    });
    const second = resolveGameHallAi({
      settings: {
        source: 'preset',
        selectedPresetId: 'b',
        updatedAt: 2,
      },
      apiConfig: api('key-a'),
      apiPresets: presets,
    });

    expect(first.identity.presetId).toBe('a');
    expect(second.identity.presetId).toBe('b');
  });

  it('keeps a deleted choice visible and falls back with a warning', () => {
    const resolved = resolveGameHallAi({
      settings: {
        source: 'preset',
        selectedPresetId: 'deleted',
        updatedAt: 0,
      },
      apiConfig: api('key-a'),
      apiPresets: presets,
      activeApiPresetId: 'a',
    });

    expect(resolved.fallbackToGlobal).toBe(true);
    expect(resolved.settings.selectedPresetId)
      .toBe('deleted');
    expect(resolved.warning)
      .toContain('已不存在');
    expect(resolved.apiConfig.apiKey)
      .toBe('key-a');
  });

  it('persists a change immediately', () => {
    saveGameHallAiSettings({
      source: 'preset',
      selectedPresetId: 'b',
      updatedAt: 0,
    });

    expect(loadGameHallAiSettings())
      .toMatchObject({
        source: 'preset',
        selectedPresetId: 'b',
      });
  });
});
