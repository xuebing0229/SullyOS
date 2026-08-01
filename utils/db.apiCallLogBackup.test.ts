import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import type { ApiCostDailySummary, FullBackupData } from '../types';

const summary: ApiCostDailySummary = {
  dateKey: '2026-07-01',
  totalCostMicros: '123456',
  pricedCallCount: 2,
  freeCallCount: 0,
  unpricedCallCount: 0,
  byPreset: [],
  byApp: [],
  byPurpose: [],
  updatedAt: 1,
};

describe.sequential('API call log backup restore', () => {
  beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
  });
  afterEach(async () => {
    await DB.deleteDB();
  });

  it('restores recent detail entries and leaves permanent daily summaries intact', async () => {
    const recent = Date.now() - 60_000;
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const data: FullBackupData = {
      timestamp: Date.now(),
      version: 3,
      apiCostDailySummaries: [summary],
      apiCallLog: [
        { id: 'recent', timestamp: recent, ok: true, url: 'https://example.test', appName: 'Chat', purpose: '聊天' } as any,
        { id: 'old', timestamp: old, ok: true, url: 'https://example.test', appName: 'Chat', purpose: '聊天' } as any,
      ],
    };

    await DB.importFullData(data);

    expect((await DB.getApiCallLog()).map(entry => entry.id)).toEqual(['recent']);
    expect(await DB.getApiCostDailySummaries()).toEqual([summary]);
  });

  it('an explicitly empty detail log clears stale entries', async () => {
    await DB.replaceApiCallLog([{ id: 'stale', timestamp: Date.now(), ok: true } as any]);
    await DB.importFullData({ timestamp: Date.now(), version: 3, apiCallLog: [] });
    expect(await DB.getApiCallLog()).toEqual([]);
  });
});
