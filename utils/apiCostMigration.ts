import type { ApiBillingUsage, ApiPreset } from '../types';
import type { ApiCallLogEntry } from './apiCallLog';
import { DB } from './db';
import { calculateApiCallCost, matchApiPresetForBilling, snapshotPricing } from './apiPricing';

const MIGRATION_KEY = 'sullyos_api_cost_v1_migrated';
const PRESETS_STORAGE_KEY = 'os_api_presets';

function loadPresets(): ApiPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function legacyUsage(entry: ApiCallLogEntry): ApiBillingUsage {
  if (entry.billingUsage) return entry.billingUsage;
  const prompt = Math.max(0, entry.promptTokens ?? 0);
  const cacheRead = Math.max(0, entry.cachedTokens ?? 0);
  const cacheWrite = Math.max(0, entry.cacheMissTokens ?? 0);
  return {
    inputTokens: Math.max(0, prompt - cacheRead - cacheWrite),
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    outputTokens: Math.max(0, entry.completionTokens ?? 0),
    usageAvailable: entry.promptTokens !== undefined || entry.completionTokens !== undefined || entry.totalTokens !== undefined,
  };
}

/** One-time migration of the retained five-day diagnostic log into the permanent daily ledger. */
export async function migrateApiCostV1(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_KEY) === '1') return;
    const existingSummaries = await DB.getApiCostDailySummaries();
    if (existingSummaries.length > 0) {
      localStorage.setItem(MIGRATION_KEY, '1');
      return;
    }
    const presets = loadPresets();
    const entries: ApiCallLogEntry[] = await DB.getApiCallLog();
    const migrated = entries.map(entry => {
      if (entry.costStatus) return entry;
      const matched = matchApiPresetForBilling(presets, { baseUrl: entry.baseUrl, model: entry.model });
      const pricingSnapshot = snapshotPricing(matched.preset, entry.model);
      const usage = legacyUsage(entry);
      const cost = calculateApiCallCost({
        pricingSnapshot,
        usage,
        ok: entry.ok,
        networkRequest: entry.networkRequest ?? true,
        cacheHit: entry.cacheHit ?? false,
        missingPresetReason: matched.reason,
      });
      return {
        ...entry,
        presetId: matched.preset?.id ?? entry.presetId,
        presetName: matched.preset?.name ?? entry.presetName,
        billingUsage: usage,
        pricingSnapshot,
        costStatus: cost.costStatus,
        costMicros: cost.costMicros,
        unpricedReason: cost.unpricedReason,
      };
    });
    await DB.replaceApiCallLogAndRebuildCost(migrated);
    localStorage.setItem(MIGRATION_KEY, '1');
  } catch (error) {
    console.warn('[ApiCost] initial migration failed', error);
  }
}

export function markApiCostMigrationComplete(): void {
  try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* ignore */ }
}
