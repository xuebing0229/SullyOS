import { describe, expect, it } from 'vitest';
import { LIVE_BACKUP_FIELD_BY_STORE, LIVE_BACKUP_STORES } from './liveBackup';

describe('live backup registry', () => {
  it('registers all four permanent stores once', () => {
    expect(LIVE_BACKUP_STORES.map(item => item.storeName)).toEqual([
      'live_settings', 'live_rooms', 'live_events', 'live_sessions',
    ]);
    expect(new Set(LIVE_BACKUP_STORES.map(item => item.field)).size).toBe(4);
    expect(LIVE_BACKUP_FIELD_BY_STORE.live_events).toBe('liveEvents');
  });
});
