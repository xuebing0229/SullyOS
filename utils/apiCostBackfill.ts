import type { ApiBillingUsage, ApiPreset } from '../types';
import { DB } from './db';
import { calculateApiCallCost, snapshotPricing } from './apiPricing';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export async function backfillUnpricedCallsForPreset(preset: ApiPreset): Promise<number> {
  if (!preset.pricing) return 0;
  const entries = await DB.getApiCostUnresolvedEntries();
  let changed = 0;
  for (const entry of entries) {
    if (entry.kind !== 'call') continue;
    if (stripTrailingSlash(entry.baseUrl || '') !== stripTrailingSlash(preset.config.baseUrl || '')
      || (entry.model || '') !== (preset.config.model || '')) continue;
    const usage: ApiBillingUsage = entry.billingUsage ?? {
      inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, usageAvailable: false,
    };
    const pricingSnapshot = snapshotPricing(preset);
    const cost = calculateApiCallCost({
      pricingSnapshot, usage, ok: true, networkRequest: true, cacheHit: false,
    });
    if (cost.costStatus !== 'priced' || cost.costMicros == null) continue;
    if (await DB.resolveApiCostUnpriced(entry.id, {
      kind: 'pricing_backfill', costMicros: cost.costMicros, pricingSnapshot,
    })) changed++;
  }
  if (changed > 0) {
    const { emitApiCostUpdated } = await import('./apiCostEvents');
    emitApiCostUpdated();
  }
  return changed;
}
