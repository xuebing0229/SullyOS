import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FullBackupData } from '../types';
import { DB } from './db';
import { GAME_HALL_BACKUP_STORES } from './gameHallBackup';

const makeRows = (): Record<string, any[]> => Object.fromEntries(
  GAME_HALL_BACKUP_STORES.map((descriptor, index) => [
    descriptor.field,
    [{ id: `${descriptor.field}-${index}`, marker: descriptor.label }],
  ]),
);

describe.sequential('Game Hall database backup restore', () => {
  beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
  });

  afterEach(async () => {
    await DB.deleteDB();
  });

  it('restores every persistent Game Hall store from the shared registry', async () => {
    const rows = makeRows();
    const expected = structuredClone(rows);
    await DB.importFullData({
      timestamp: Date.now(),
      version: 3,
      ...rows,
    } as FullBackupData);

    for (const descriptor of GAME_HALL_BACKUP_STORES) {
      expect(await DB.getRawStoreData(descriptor.storeName)).toEqual(expected[descriptor.field]);
    }
  });

  it('an explicitly empty backup clears stale Game Hall rows', async () => {
    const rows = makeRows();
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...rows } as FullBackupData);

    const empty = Object.fromEntries(GAME_HALL_BACKUP_STORES.map(item => [item.field, []]));
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...empty } as FullBackupData);

    for (const descriptor of GAME_HALL_BACKUP_STORES) {
      expect(await DB.getRawStoreData(descriptor.storeName)).toEqual([]);
    }
  });
});
