import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiCostDailySummary, ApiCostUnresolvedEntry, ApiPreset } from '../types';
import { backfillUnpricedCallsByPresetIdentity, backfillUnpricedCallsForPreset } from './apiCostBackfill';
import { DB } from './db';

const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000;
const dateKey = (() => {
  const date = new Date(oldTimestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
})();

const summary = (): ApiCostDailySummary => ({
  dateKey, totalCostMicros: '0', pricedCallCount: 0, freeCallCount: 0,
  unpricedCallCount: 1, ignoredCallCount: 0, byPreset: [], byApp: [], byPurpose: [], updatedAt: 1,
});

const unresolved = (): ApiCostUnresolvedEntry => ({
  id: 'call:expired-detail', kind: 'call', sourceEntryId: 'expired-detail',
  timestamp: oldTimestamp, dateKey, callCount: 1, presetId: 'preset-1', presetName: '主 API',
  baseUrl: 'https://api.example/v1/', model: 'model-a', appId: 'chat', appName: '消息',
  purpose: '聊天回复', reason: 'usage_missing',
  billingUsage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, usageAvailable: false },
  createdAt: oldTimestamp, updatedAt: oldTimestamp,
});

const preset = (pricing: ApiPreset['pricing']): ApiPreset => ({
  id: 'preset-1', name: '主 API',
  config: { baseUrl: 'https://api.example/v1', model: 'model-a' } as ApiPreset['config'],
  pricing,
});

describe.sequential('API unresolved cost pricing backfill', () => {
  beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
  });

  it('backfills a permanent item after its five-day detail has expired for per-request pricing', async () => {
    await DB.importFullData({
      timestamp: Date.now(), version: 3, apiCostDailySummaries: [summary()],
      apiCostUnresolvedEntries: [unresolved()], apiCallLog: [],
    });

    await expect(backfillUnpricedCallsForPreset(preset({
      mode: 'per_request', pricePerRequestYuan: '0.25',
    }))).resolves.toBe(1);

    expect(await DB.getApiCallLog()).toEqual([]);
    expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
    expect((await DB.getApiCostDailySummaries())[0]).toMatchObject({
      totalCostMicros: '250000', pricedCallCount: 1, unpricedCallCount: 0,
    });
  });

  it('uses saved presetId even if the route model has changed', async () => {
    await DB.importFullData({
      timestamp: Date.now(), version: 3, apiCostDailySummaries: [summary()],
      apiCostUnresolvedEntries: [{ ...unresolved(), model: 'model-a-high' }],
    });

    await expect(backfillUnpricedCallsForPreset(preset({
      mode: 'per_request', pricePerRequestYuan: '0.25',
    }))).resolves.toBe(1);

    expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
    expect((await DB.getApiCostDailySummaries())[0]).toMatchObject({
      totalCostMicros: '250000', pricedCallCount: 1, unpricedCallCount: 0,
    });
  });

  it('repairs existing pending items by preset identity only', async () => {
    await DB.importFullData({
      timestamp: Date.now(), version: 3, apiCostDailySummaries: [summary()],
      apiCostUnresolvedEntries: [{ ...unresolved(), model: 'model-a-high' }],
    });

    await expect(backfillUnpricedCallsByPresetIdentity([
      preset({ mode: 'per_request', pricePerRequestYuan: '0.25' }),
    ])).resolves.toBe(1);

    expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
  });

  it('keeps usage-missing per-token items unresolved', async () => {
    await DB.importFullData({
      timestamp: Date.now(), version: 3, apiCostDailySummaries: [summary()],
      apiCostUnresolvedEntries: [unresolved()],
    });

    await expect(backfillUnpricedCallsForPreset(preset({
      mode: 'per_token', inputYuanPerMillion: '1', cacheWriteYuanPerMillion: '1',
      cacheReadYuanPerMillion: '1', outputYuanPerMillion: '1',
    }))).resolves.toBe(0);

    expect((await DB.getApiCostUnresolvedEntries()).map(entry => entry.id)).toEqual(['call:expired-detail']);
    expect((await DB.getApiCostDailySummaries())[0].unpricedCallCount).toBe(1);
  });
});
