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
  const pricedPresets = presets.filter(preset => preset.pricing);
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

    // 第一版只能修“已经保存 presetId”的新记录；旧记录正因为匹配失败所以根本没有 id。
    // 对这类历史项只做一个保守兜底：若这个 Base URL 在当前所有“已配置价格”的预设里
    // 只有唯一归属，就可以确定应套哪个价格；同线路存在多个预设时绝不猜，继续留待处理。
    if (!preset && !entry.presetId) {
      const normBase = stripTrailingSlash(entry.baseUrl || '');
      const endpointCandidates = pricedPresets.filter(
        candidate =>
          stripTrailingSlash(candidate.config.baseUrl || '') === normBase,
      );
      if (endpointCandidates.length === 1) {
        preset = endpointCandidates[0];
      }
    }

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
