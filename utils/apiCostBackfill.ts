import type { ApiBillingUsage, ApiPreset } from '../types';
import { DB } from './db';
import { calculateApiCallCost, snapshotPricing } from './apiPricing';
import { getApiPresetModelEntries } from './apiPresetModels';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const hasAnyPricing = (preset: ApiPreset): boolean =>
  getApiPresetModelEntries(preset).some(item => item.pricing);

const canSafelyFallbackToOnlyPricedModel = (preset: ApiPreset): boolean =>
  getApiPresetModelEntries(preset).filter(item => item.pricing).length === 1;

export async function backfillUnpricedCallsForPreset(preset: ApiPreset): Promise<number> {
  if (!hasAnyPricing(preset)) return 0;
  const entries = await DB.getApiCostUnresolvedEntries();
  let changed = 0;
  for (const entry of entries) {
    if (entry.kind !== 'call') continue;
    const matchesPreset = entry.presetId
      ? entry.presetId === preset.id
      : stripTrailingSlash(entry.baseUrl || '') === stripTrailingSlash(preset.config.baseUrl || '')
        && getApiPresetModelEntries(preset).some(item => item.model === (entry.model || ''));
    if (!matchesPreset) continue;

    const exactSnapshot = snapshotPricing(preset, entry.model);
    const pricingSnapshot = exactSnapshot
      ?? (entry.presetId && canSafelyFallbackToOnlyPricedModel(preset)
        ? snapshotPricing(preset, preset.config.model, true)
        : undefined);
    if (!pricingSnapshot) continue;

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
 * 修复已经落进“待处理”的新式记录：优先认记录当时保存下来的 presetId。
 * 老记录没有 id 时，只在“端点唯一 + 模型价格能唯一确定”时补算，绝不跨模型猜价格。
 */
export async function backfillUnpricedCallsByPresetIdentity(
  presets: ApiPreset[],
): Promise<number> {
  const pricedPresets = presets.filter(hasAnyPricing);
  const pricedById = new Map(
    pricedPresets.map(preset => [preset.id, preset] as const),
  );
  if (pricedById.size === 0) return 0;

  const entries = await DB.getApiCostUnresolvedEntries();
  let changed = 0;

  for (const entry of entries) {
    if (entry.kind !== 'call') continue;
    let preset = entry.presetId
      ? pricedById.get(entry.presetId)
      : undefined;

    let pricingSnapshot = preset
      ? snapshotPricing(preset, entry.model)
      : undefined;

    if (
      preset
      && !pricingSnapshot
      && canSafelyFallbackToOnlyPricedModel(preset)
    ) {
      pricingSnapshot = snapshotPricing(preset, preset.config.model, true);
    }

    if (!preset && !entry.presetId) {
      const normBase = stripTrailingSlash(entry.baseUrl || '');
      const endpointCandidates = pricedPresets.filter(candidate => {
        if (stripTrailingSlash(candidate.config.baseUrl || '') !== normBase) return false;
        return Boolean(snapshotPricing(candidate, entry.model))
          || canSafelyFallbackToOnlyPricedModel(candidate);
      });
      if (endpointCandidates.length === 1) {
        preset = endpointCandidates[0];
        pricingSnapshot = snapshotPricing(preset, entry.model)
          ?? snapshotPricing(preset, preset.config.model, true);
      }
    }

    if (!preset || !pricingSnapshot) continue;
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
