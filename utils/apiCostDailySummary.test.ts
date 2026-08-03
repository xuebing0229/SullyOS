import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import type { ApiCallLogEntry } from './apiCallLog';

const entry = (id: string, timestamp = Date.now(), costMicros = '1250000'): ApiCallLogEntry => ({
  id, timestamp, presetId: 'preset-1', presetName: '主 API', baseUrl: 'https://api.example/v1', model: 'model-a',
  ok: true, appId: 'chat', appName: '消息', purpose: '聊天回复', networkRequest: true, cacheHit: false,
  billingUsage: { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 200, usageAvailable: true },
  costStatus: 'priced', costMicros,
});

describe('API cost daily summary', () => {
  beforeEach(async () => {
    await DB.clearApiCallLog();
    await DB.clearApiCostHistory();
  });

  it('writes detail and daily total, and stable id is idempotent', async () => {
    await expect(DB.appendApiCallLog(entry('same-id'))).resolves.toBe(true);
    await expect(DB.appendApiCallLog(entry('same-id'))).resolves.toBe(false);
    expect((await DB.getApiCallLog()).filter(x => x.id === 'same-id')).toHaveLength(1);
    const summaries = await DB.getApiCostDailySummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ totalCostMicros: '1250000', pricedCallCount: 1 });
    expect(summaries[0].byPreset[0]).toMatchObject({ key: 'preset-1', costMicros: '1250000', callCount: 1 });
  });

  it('clearing five-day details keeps permanent cost history', async () => {
    await DB.appendApiCallLog(entry('keep-summary'));
    await DB.clearApiCallLog();
    expect(await DB.getApiCallLog()).toHaveLength(0);
    expect((await DB.getApiCostOverview()).totalCostMicros).toBe('1250000');
  });

  it('separates local calendar days', async () => {
    const now = new Date();
    const previous = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime();
    await DB.appendApiCallLog(entry('today', now.getTime(), '100'));
    await DB.appendApiCallLog(entry('previous', previous, '200'));
    const summaries = await DB.getApiCostDailySummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.map(x => x.totalCostMicros).sort()).toEqual(['100', '200']);
  });
});

describe('API unresolved cost persistence', () => {
  beforeEach(async () => {
    await DB.clearApiCallLog();
    await DB.clearApiCostHistory();
  });
  const unpriced = (id: string, timestamp = Date.now()): ApiCallLogEntry => ({
    id, timestamp, presetId: 'preset-1', presetName: '主 API',
    baseUrl: 'https://api.example/v1', model: 'model-a', ok: true,
    appId: 'chat', appName: '消息', purpose: '聊天回复',
    networkRequest: true, cacheHit: false, costStatus: 'unpriced',
    unpricedReason: 'usage_missing',
  });
  it('creates a permanent unresolved entry and stable id does not duplicate it', async () => {
    await DB.appendApiCallLog(unpriced('pending'));
    await DB.appendApiCallLog(unpriced('pending'));
    expect(await DB.getApiCostUnresolvedEntries()).toHaveLength(1);
    expect((await DB.getApiCostDailySummaries())[0].unpricedCallCount).toBe(1);
  });
  it('keeps unresolved after detail cleanup and resolves it as zero', async () => {
    await DB.appendApiCallLog(unpriced('old-pending'));
    await DB.clearApiCallLog();
    expect(await DB.getApiCostUnresolvedEntries()).toHaveLength(1);
    await DB.resolveApiCostUnpriced('call:old-pending', { kind: 'ignore_zero' });
    expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
    expect((await DB.getApiCostDailySummaries())[0]).toMatchObject({ unpricedCallCount: 0, ignoredCallCount: 1 });
  });
  it('batch zero-archive resolves unique ids and updates recent details in one operation', async () => {
    await DB.appendApiCallLog(unpriced('batch-a'));
    await DB.appendApiCallLog(unpriced('batch-b'));
    await expect(DB.resolveApiCostUnpricedBatch(
      ['call:batch-a', 'call:batch-a', 'call:batch-b', 'call:missing'],
      { kind: 'ignore_zero' },
    )).resolves.toBe(2);
    expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
    expect((await DB.getApiCostDailySummaries())[0]).toMatchObject({ unpricedCallCount: 0, ignoredCallCount: 2 });
    expect((await DB.getApiCallLog()).filter(item => item.costStatus === 'ignored_unpriced')).toHaveLength(2);
  });
  it('manual cost updates total and all buckets', async () => {
    await DB.appendApiCallLog(unpriced('manual'));
    await DB.resolveApiCostUnpriced('call:manual', { kind: 'manual_cost', costMicros: '12345' });
    const day = (await DB.getApiCostDailySummaries())[0];
    expect(day).toMatchObject({ totalCostMicros: '12345', unpricedCallCount: 0, pricedCallCount: 1 });
    expect(day.byPreset[0].costMicros).toBe('12345');
    expect(day.byApp[0].costMicros).toBe('12345');
    expect(day.byPurpose[0].costMicros).toBe('12345');
  });
});
