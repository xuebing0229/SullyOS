import { describe, expect, it } from 'vitest';
import type { ApiCostDailySummary, ApiCostUnresolvedEntry } from '../types';
import { applyUnpricedResolutionToSummary, normalizeApiCostDailySummary } from './apiCostResolution';
const summary = (): ApiCostDailySummary => ({ dateKey:'2026-08-02', totalCostMicros:'100', pricedCallCount:1, freeCallCount:0, unpricedCallCount:6, ignoredCallCount:0, byPreset:[], byApp:[], byPurpose:[], updatedAt:0 });
const entry = (callCount=1): ApiCostUnresolvedEntry => ({ id:'x', kind:callCount>1?'legacy_aggregate':'call', timestamp:1, dateKey:'2026-08-02', callCount, presetName:'API', appName:'App', purpose:'聊天', reason:'usage_missing', createdAt:1, updatedAt:1 });
describe('api cost resolution',()=>{
 it('ignore_zero updates counts without cost',()=>{const x=applyUnpricedResolutionToSummary(summary(),entry(),{kind:'ignore_zero'});expect(x.unpricedCallCount).toBe(5);expect(x.ignoredCallCount).toBe(1);expect(x.totalCostMicros).toBe('100');});
 it('manual cost updates total and buckets',()=>{const x=applyUnpricedResolutionToSummary(summary(),entry(),{kind:'manual_cost',costMicros:'123'});expect(x.unpricedCallCount).toBe(5);expect(x.pricedCallCount).toBe(2);expect(x.totalCostMicros).toBe('223');expect(x.byPreset[0]).toMatchObject({callCount:1,costMicros:'123'});expect(x.byApp[0].callCount).toBe(1);expect(x.byPurpose[0].callCount).toBe(1);});
 it('legacy aggregate adds amount once and call count six',()=>{const x=applyUnpricedResolutionToSummary(summary(),entry(6),{kind:'manual_cost',costMicros:'500'});expect(x.unpricedCallCount).toBe(0);expect(x.pricedCallCount).toBe(7);expect(x.totalCostMicros).toBe('600');expect(x.byPreset[0].callCount).toBe(6);});
 it('rejects negative cost',()=>expect(()=>applyUnpricedResolutionToSummary(summary(),entry(),{kind:'manual_cost',costMicros:'-1'})).toThrow('手动费用不能为负数'));
 it('normalizes old summary ignored count',()=>expect(normalizeApiCostDailySummary({...summary(),ignoredCallCount:undefined as any}).ignoredCallCount).toBe(0));
});
