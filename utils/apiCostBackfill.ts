import type { ApiBillingUsage, ApiPreset } from '../types';
import { DB } from './db';
import { calculateApiCallCost, snapshotPricing } from './apiPricing';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export async function backfillUnpricedCallsForPreset(preset: ApiPreset): Promise<number> {
  if (!preset.pricing) return 0;
  const pricingSnapshot = snapshotPricing(preset);
  if (!pricingSnapshot) return 0;
  const entries = await DB.getApiCostUnresolvedEntries();
  let changed = 0;
  for (const entry of entries) {
    if (entry.kind !== 'call') continue;
    const matchesPreset = entry.presetId
      ? entry.presetId === preset.id
      : stripTrailingSlash(entry.baseUrl || '') === stripTrailingSlash(preset.config.baseUrl || '')
        && (entry.model || '') === (preset.config.model || '');
    if (!matchesPreset) continue;
    const usage: ApiBillingUsage = entry.billingUsage ?? {
      inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, usageAvailable: false,
    };
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


/**
 * 修复已经落进“待处理”的新式记录：只认记录当时保存下来的 presetId，
 * 不用名称 / URL 猜，避免同线路多个预设时串账。
 */
export async function backfillUnpricedCallsByPresetIdentity(
  presets: ApiPreset[],
): Promise<number> {
  const pricedById = new Map(
    presets
      .filter(preset => preset.pricing)
      .map(preset => [preset.id, preset] as const),
  );
  if (pricedById.size === 0) return 0;

  const entries = await DB.getApiCostUnresolvedEntries();
  let changed = 0;

  for (const entry of entries) {
    if (entry.kind !== 'call' || !entry.presetId) continue;
    const preset = pricedById.get(entry.presetId);
    if (!preset) continue;
    const pricingSnapshot = snapshotPricing(preset);
    if (!pricingSnapshot) continue;
    const usage: ApiBillingUsage = entry.billingUsage ?? {
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      usageAvailable: false,
    };
    const cost = calculateApiCallCost({
      pricingSnapshot,
      usage,
      ok: true,
      networkRequest: true,
      cacheHit: false,
    });
    if (cost.costStatus !== 'priced' || cost.costMicros == null) continue;
    if (await DB.resolveApiCostUnpriced(entry.id, {
      kind: 'pricing_backfill',
      costMicros: cost.costMicros,
      pricingSnapshot,
    })) changed++;
  }

  if (changed > 0) {
    const { emitApiCostUpdated } = await import('./apiCostEvents');
    emitApiCostUpdated();
  }
  return changed;
}
