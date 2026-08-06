import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { APIConfig, ApiPreset } from '../types';
import {
  DEFAULT_GAME_HALL_API_SETTINGS,
  loadGameHallApiSettings,
  resolveGameHallApiConfig,
  saveGameHallApiSettings,
} from './gameHallApiPreset';

const main: APIConfig = {
  baseUrl: 'https://main.example/v1',
  apiKey: 'main-key',
  model: 'main-model',
};

const preset: ApiPreset = {
  id: 'p1',
  name: '游戏专用',
  config: {
    baseUrl: 'https://game.example/v1',
    apiKey: 'game-key',
    model: 'game-model',
  },
};

describe('gameHallApiPreset', () => {
  beforeEach(() => localStorage.clear());

  it('follows current chat API by default', () => {
    const result = resolveGameHallApiConfig(
      main,
      [preset],
      DEFAULT_GAME_HALL_API_SETTINGS,
    );
    expect(result.config).toBe(main);
    expect(result.presetId).toBeNull();
  });

  it('uses selected preset without mutating global API', () => {
    const settings = {
      ...DEFAULT_GAME_HALL_API_SETTINGS,
      activePresetId: 'p1',
    };
    const result = resolveGameHallApiConfig(
      main,
      [preset],
      settings,
    );
    expect(result.config.model).toBe('game-model');
    expect(main.model).toBe('main-model');
  });

  it('falls back visibly if preset was deleted', () => {
    const result = resolveGameHallApiConfig(
      main,
      [],
      {
        ...DEFAULT_GAME_HALL_API_SETTINGS,
        activePresetId: 'missing',
      },
    );
    expect(result.config).toBe(main);
    expect(result.fellBackToDefault).toBe(true);
  });

  it('preserves null maxTurns and zero delay', () => {
    saveGameHallApiSettings({
      version: 1,
      activePresetId: null,
      maxTurns: null,
      stepDelayMs: 0,
      autoHandoffOnFinish: true,
    });
    expect(loadGameHallApiSettings()).toMatchObject({
      maxTurns: null,
      stepDelayMs: 0,
    });
  });
});
