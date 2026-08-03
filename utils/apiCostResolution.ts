import type {
  ApiCostBucket,
  ApiCostDailySummary,
  ApiCostResolution,
  ApiCostUnresolvedEntry,
} from '../types';
import type { ApiCallLogEntry } from './apiCallLog';

const safeBigInt = (value: unknown): bigint => {
  try { return BigInt(String(value ?? '0')); } catch { return 0n; }
};

export function normalizeApiCostDailySummary(
  summary: ApiCostDailySummary,
): ApiCostDailySummary {
  return {
    ...summary,
    totalCostMicros: String(summary.totalCostMicros ?? '0'),
    pricedCallCount: Math.max(0, summary.pricedCallCount ?? 0),
    freeCallCount: Math.max(0, summary.freeCallCount ?? 0),
    unpricedCallCount: Math.max(0, summary.unpricedCallCount ?? 0),
    ignoredCallCount: Math.max(0, summary.ignoredCallCount ?? 0),
    byPreset: Array.isArray(summary.byPreset) ? summary.byPreset : [],
    byApp: Array.isArray(summary.byApp) ? summary.byApp : [],
    byPurpose: Array.isArray(summary.byPurpose) ? summary.byPurpose : [],
    updatedAt: Date.now(),
  };
}
function addBucketDelta(
  items: ApiCostBucket[],
  input: { key: string; label: string; costMicros: string; callCount: number },
): ApiCostBucket[] {
  const next = [...items];
  const index = next.findIndex(item => item.key === input.key);
  if (index < 0) { next.push({ ...input }); return next; }
  const current = next[index];
  next[index] = {
    ...current,
    label: input.label || current.label,
    costMicros: (safeBigInt(current.costMicros) + safeBigInt(input.costMicros)).toString(),
    callCount: current.callCount + input.callCount,
  };
  return next.filter(item => item.callCount > 0 || safeBigInt(item.costMicros) !== 0n);
}
export function applyUnpricedResolutionToSummary(
  original: ApiCostDailySummary,
  entry: ApiCostUnresolvedEntry,
  resolution: ApiCostResolution,
): ApiCostDailySummary {
  const summary = normalizeApiCostDailySummary(original);
  const callCount = Math.max(1, Math.floor(entry.callCount || 1));
  summary.unpricedCallCount = Math.max(0, summary.unpricedCallCount - callCount);
  if (resolution.kind === 'ignore_zero') {
    summary.ignoredCallCount += callCount;
    summary.updatedAt = Date.now();
    return summary;
  }
  const costMicros = String(resolution.costMicros || '0');
  if (safeBigInt(costMicros) < 0n) throw new Error('手动费用不能为负数');
  summary.totalCostMicros = (safeBigInt(summary.totalCostMicros) + safeBigInt(costMicros)).toString();
  summary.pricedCallCount += callCount;
  const presetKey = entry.presetId ?? `name:${entry.presetName || '未识别 API'}`;
  const appKey = entry.appId ?? `name:${entry.appName || '其他 App'}`;
  const purposeKey = entry.purpose || '未标注用途';
  summary.byPreset = addBucketDelta(summary.byPreset, { key: presetKey, label: entry.presetName || '未识别 API', costMicros, callCount });
  summary.byApp = addBucketDelta(summary.byApp, { key: appKey, label: entry.appName || '其他 App', costMicros, callCount });
  summary.byPurpose = addBucketDelta(summary.byPurpose, { key: purposeKey, label: purposeKey, costMicros, callCount });
  summary.updatedAt = Date.now();
  return summary;
}
export function toApiCostUnresolvedEntry(entry: ApiCallLogEntry): ApiCostUnresolvedEntry | null {
  if (!entry.ok || entry.costStatus !== 'unpriced') return null;
  const date = new Date(entry.timestamp);
  const pad = (v: number) => String(v).padStart(2, '0');
  const now = Date.now();
  return {
    id: `call:${entry.id}`, kind: 'call', sourceEntryId: entry.id, timestamp: entry.timestamp,
    dateKey: [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-'),
    callCount: 1, presetId: entry.presetId, presetName: entry.presetName || '未识别 API',
    baseUrl: entry.baseUrl, model: entry.model, appId: entry.appId, appName: entry.appName,
    purpose: entry.purpose, charId: entry.charId, charName: entry.charName,
    reason: entry.unpricedReason ?? 'pricing_not_configured', billingUsage: entry.billingUsage,
    pricingSnapshot: entry.pricingSnapshot, createdAt: now, updatedAt: now,
  };
}
