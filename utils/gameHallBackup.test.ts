import { describe, expect, it } from 'vitest';
import {
  GAME_HALL_BACKUP_FIELD_BY_STORE,
  GAME_HALL_BACKUP_STORES,
  GAME_HALL_PROTOCOL_CACHE_STORE,
} from './gameHallBackup';

describe('gameHallBackup registry', () => {
  it('registers every persistent Game Hall store exactly once', () => {
    expect(GAME_HALL_BACKUP_STORES.map(item => item.storeName)).toEqual([
      'gameHallSessions',
      'gameHallMessages',
      'gameHallPendingActions',
      'gameHallBridgeSnapshots',
      'gameHallEvents',
      'gameHallMemoryCandidates',
      'gameHallPreferenceEvidence',
    ]);
    expect(new Set(GAME_HALL_BACKUP_STORES.map(item => item.field)).size).toBe(7);
    expect(GAME_HALL_BACKUP_FIELD_BY_STORE.gameHallSessions).toBe('gameHallSessions');
  });

  it('keeps the regenerable protocol cache outside permanent backup', () => {
    expect(GAME_HALL_PROTOCOL_CACHE_STORE).toBe('gameHallProtocolCache');
    expect(GAME_HALL_BACKUP_STORES.some(item => item.storeName === GAME_HALL_PROTOCOL_CACHE_STORE)).toBe(false);
  });
});
