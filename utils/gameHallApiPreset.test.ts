import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  DEFAULT_GAME_HALL_API_SETTINGS,
  loadGameHallApiSettings,
  saveGameHallApiSettings,
} from './gameHallApiPreset';

describe('gameHallApiPreset autoplay settings', () => {
  beforeEach(() => localStorage.clear());

  it('uses unlimited turns, a 1200ms delay, and automatic handoff by default', () => {
    expect(loadGameHallApiSettings()).toEqual(
      DEFAULT_GAME_HALL_API_SETTINGS,
    );
  });

  it('saves and restores autonomous run settings while preserving zero delay', () => {
    saveGameHallApiSettings({
      version: 1,
      maxTurns: 12,
      stepDelayMs: 0,
      autoHandoffOnFinish: false,
    });

    expect(loadGameHallApiSettings()).toEqual({
      version: 1,
      maxTurns: 12,
      stepDelayMs: 0,
      autoHandoffOnFinish: false,
    });
  });

  it('normalizes invalid values without reviving the legacy API preset field', () => {
    localStorage.setItem(
      'sullyos_game_hall_api_settings_v1',
      JSON.stringify({
        version: 1,
        activePresetId: 'legacy-game-preset',
        maxTurns: -3,
        stepDelayMs: -1,
        autoHandoffOnFinish: true,
      }),
    );

    expect(loadGameHallApiSettings()).toEqual({
      version: 1,
      maxTurns: null,
      stepDelayMs: 1200,
      autoHandoffOnFinish: true,
    });
    expect(loadGameHallApiSettings()).not.toHaveProperty('activePresetId');
  });

  it('floors positive turn limits and falls back safely for malformed storage', () => {
    localStorage.setItem(
      'sullyos_game_hall_api_settings_v1',
      JSON.stringify({
        maxTurns: 4.9,
        stepDelayMs: '250',
        autoHandoffOnFinish: undefined,
      }),
    );
    expect(loadGameHallApiSettings()).toMatchObject({
      maxTurns: 4,
      stepDelayMs: 250,
      autoHandoffOnFinish: true,
    });

    localStorage.setItem('sullyos_game_hall_api_settings_v1', '{bad json');
    expect(loadGameHallApiSettings()).toEqual(
      DEFAULT_GAME_HALL_API_SETTINGS,
    );
  });
});
