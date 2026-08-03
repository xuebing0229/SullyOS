import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import type { ApiCostDailySummary, FullBackupData } from '../types';

const summary: ApiCostDailySummary = {
  dateKey: '2026-07-01',
  totalCostMicros: '123456',
  pricedCallCount: 2,
  freeCallCount: 0,
  unpricedCallCount: 0,
  ignoredCallCount: 0,
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
    expect(await DB.getApiCostDailySummaries()).toEqual([expect.objectContaining({ ...summary, updatedAt: expect.any(Number) })]);
  });

  it('an explicitly empty detail log clears stale entries', async () => {
    await DB.replaceApiCallLog([{ id: 'stale', timestamp: Date.now(), ok: true } as any]);
    await DB.importFullData({ timestamp: Date.now(), version: 3, apiCallLog: [] });
    expect(await DB.getApiCallLog()).toEqual([]);
  });
});

describe.sequential('API unresolved backup restore', () => {
  beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
  });
  afterEach(async () => {
    await DB.deleteDB();
  });
  it('an explicitly empty unresolved list clears stale pending items', async () => {
    await DB.importFullData({
      timestamp: Date.now(), version: 3,
      apiCostDailySummaries: [{ ...summary, unpricedCallCount: 1 }],
      apiCostUnresolvedEntries: [{
        id: 'legacy:2026-07-01', kind: 'legacy_aggregate', timestamp: 1, dateKey: '2026-07-01',
        callCount: 1, presetName: '历史遗留', reason: 'legacy_unknown', createdAt: 1, updatedAt: 1,
      }],
    });
    expect(await DB.getApiCostUnresolvedEntries()).toHaveLength(1);
    await DB.importFullData({ timestamp: Date.now(), version: 3, apiCostUnresolvedEntries: [] });
    expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
  });
  it('creates a resolvable legacy aggregate when restoring an old backup without unresolved data', async () => {
    await DB.importFullData({
      timestamp: Date.now(), version: 3,
      apiCostDailySummaries: [{ ...summary, unpricedCallCount: 3 }],
    });
    expect(await DB.getApiCostUnresolvedEntries()).toEqual([expect.objectContaining({
      id: 'legacy:2026-07-01', kind: 'legacy_aggregate', callCount: 3, reason: 'legacy_unknown',
    })]);
  });
});
