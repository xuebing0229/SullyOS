import { beforeEach, describe, expect, it } from 'vitest';
import {
  GAME_HALL_AI_SETTINGS_KEY,
  loadGameHallAiSettings,
  saveGameHallAiSettings,
} from './gameHallAiSettings';
import {
  GAME_HALL_API_SETTINGS_STORAGE_KEY,
  loadGameHallApiSettings,
  saveGameHallApiSettings,
} from './gameHallApiPreset';
import {
  GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY,
  peekGameHallAutoplayCommands,
} from './gameHallAutoplayIntent';
import {
  backupContainsGameHallAutoplayData,
  exportGameHallAutoplayBackup,
  exportLegacySullyEventFlags,
  importGameHallAutoplayBackup,
  prepareGameHallSessionForRestore,
  prepareGameHallSessionsForRestore,
  stripGameHallAutoplayKeysFromLegacyFlags,
} from './gameHallAutoplayBackup';

describe('gameHallAutoplayBackup', () => {
  beforeEach(() => localStorage.clear());

  it('exports API selection and autoplay controls without credentials', () => {
    saveGameHallAiSettings({
      source: 'preset',
      selectedPresetId: 'preset-game',
      updatedAt: 1,
    });
    saveGameHallApiSettings({
      version: 1,
      maxTurns: 12,
      stepDelayMs: 0,
      autoHandoffOnFinish: false,
    });
    const backup = exportGameHallAutoplayBackup();
    expect(backup).toMatchObject({
      version: 1,
      aiSettings: { source: 'preset', selectedPresetId: 'preset-game' },
      autoplaySettings: { maxTurns: 12, stepDelayMs: 0, autoHandoffOnFinish: false },
    });
    expect(JSON.stringify(backup)).not.toContain('apiKey');
  });

  it('excludes all Game Hall runtime keys from legacy flags', () => {
    localStorage.setItem(GAME_HALL_AI_SETTINGS_KEY, '{}');
    localStorage.setItem(GAME_HALL_API_SETTINGS_STORAGE_KEY, '{}');
    localStorage.setItem(GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY, '[{"type":"start"}]');
    localStorage.setItem('sullyos_first_archive_notice_char-1', '1');
    expect(exportLegacySullyEventFlags()).toEqual({
      'sullyos_first_archive_notice_char-1': '1',
    });
  });

  it('restores explicit settings and clears the target command queue', () => {
    localStorage.setItem(GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY, '[{"type":"start"}]');
    const result = importGameHallAutoplayBackup({
      version: 1,
      aiSettings: { source: 'preset', selectedPresetId: 'p2', updatedAt: 3 },
      autoplaySettings: { version: 1, maxTurns: null, stepDelayMs: 250, autoHandoffOnFinish: true },
    });
    expect(result).toEqual({ settingsRestored: true, migratedLegacySettings: false, commandQueueCleared: true });
    expect(loadGameHallAiSettings()).toMatchObject({ source: 'preset', selectedPresetId: 'p2' });
    expect(loadGameHallApiSettings()).toMatchObject({ maxTurns: null, stepDelayMs: 250 });
    expect(peekGameHallAutoplayCommands()).toEqual([]);
  });

  it('migrates the old mixed event flag and drops old commands', () => {
    const legacy = {
      [GAME_HALL_API_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1, activePresetId: 'legacy-preset', maxTurns: 7,
        stepDelayMs: 900, autoHandoffOnFinish: false,
      }),
      [GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY]: '[{"type":"start"}]',
      sullyos_real_event_flag: 'yes',
    };
    const result = importGameHallAutoplayBackup(undefined, legacy);
    expect(result.migratedLegacySettings).toBe(true);
    expect(loadGameHallAiSettings()).toMatchObject({ source: 'preset', selectedPresetId: 'legacy-preset' });
    expect(loadGameHallApiSettings()).toMatchObject({ maxTurns: 7, stepDelayMs: 900, autoHandoffOnFinish: false });
    expect(localStorage.getItem(GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY)).toBeNull();
    expect(stripGameHallAutoplayKeysFromLegacyFlags(legacy)).toEqual({ sullyos_real_event_flag: 'yes' });
  });

  it('does not change local settings for a media-only backup with no relevant fields', () => {
    saveGameHallAiSettings({ source: 'preset', selectedPresetId: 'current', updatedAt: 1 });
    saveGameHallApiSettings({ version: 1, maxTurns: 5, stepDelayMs: 10, autoHandoffOnFinish: true });
    expect(backupContainsGameHallAutoplayData({})).toBe(false);
    expect(loadGameHallAiSettings().selectedPresetId).toBe('current');
    expect(loadGameHallApiSettings().maxTurns).toBe(5);
  });

  it.each(['queued', 'running', 'stopping'] as const)(
    'restores %s as paused without losing progress',
    (status) => {
      const session = {
        id: 's1', charId: 'c1', mode: 'auto-turn', status: 'active', createdAt: 1, updatedAt: 2,
        autoplay: {
          version: 1, runId: 'r1', status, requestedFrom: 'main-chat',
          instruction: '自己玩', returnToMainChat: true, turnCount: 3,
          maxTurns: null, stepDelayMs: 0, createdAt: 1, updatedAt: 2,
          latestState: { gameId: 'g1', raw: { score: 9 } },
        },
      } as any;
      const restored = prepareGameHallSessionForRestore(session, 1000);
      expect(restored.autoplay).toMatchObject({
        runId: 'r1', status: 'paused', stopReason: 'restored-from-backup',
        restoredFromBackupAt: 1000, turnCount: 3, latestState: { gameId: 'g1', raw: { score: 9 } },
      });
    },
  );

  it.each(['paused', 'completed', 'cancelled', 'failed'] as const)(
    'leaves %s unchanged',
    (status) => {
      const session = { id: status, autoplay: { status } } as any;
      expect(prepareGameHallSessionForRestore(session, 1000)).toBe(session);
    },
  );

  it('reports the number of paused restored sessions', () => {
    const make = (id: string, status: string) => ({ id, autoplay: { status } }) as any;
    const result = prepareGameHallSessionsForRestore([
      make('a', 'running'), make('b', 'completed'), make('c', 'queued'),
    ], 1000);
    expect(result.pausedCount).toBe(2);
    expect(result.sessions.map(item => item.autoplay?.status)).toEqual(['paused', 'completed', 'paused']);
  });
});
