import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FullBackupData } from '../types';
import { DB } from './db';
import { LIVE_BACKUP_STORES } from './liveBackup';

const rows = () => ({
  liveSettings: [{ id: 'main', duration: 90 }],
  liveRooms: [{ id: 'room-1', kind: 'mine', status: 'live' }],
  liveEvents: [{ id: 'event-1', roomId: 'room-1', time: 1 }],
  liveSessions: [{ id: 'session-1', roomId: 'room-1', status: 'active' }],
});

describe.sequential('live database backup restore', () => {
  beforeEach(async () => { await DB.deleteDB(); localStorage.clear(); });
  afterEach(async () => { await DB.deleteDB(); });

  it('restores every registered live store and pauses running rooms', async () => {
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...rows() } as FullBackupData);
    expect(await DB.getRawStoreData('live_settings')).toMatchObject([{ id: 'main', duration: 90 }]);
    expect(await DB.getRawStoreData('live_rooms')).toMatchObject([{ id: 'room-1', status: 'paused' }]);
    expect(await DB.getRawStoreData('live_events')).toMatchObject([{ id: 'event-1', roomId: 'room-1' }]);
    expect(await DB.getRawStoreData('live_sessions')).toMatchObject([{ id: 'session-1', status: 'paused' }]);
  });

  it('clears stale rows when an explicit empty live backup is imported', async () => {
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...rows() } as FullBackupData);
    const empty = Object.fromEntries(LIVE_BACKUP_STORES.map(item => [item.field, []]));
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...empty } as FullBackupData);
    for (const descriptor of LIVE_BACKUP_STORES) {
      expect(await DB.getRawStoreData(descriptor.storeName)).toEqual([]);
    }
  });
});
