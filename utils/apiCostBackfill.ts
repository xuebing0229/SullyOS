import type {
  ApiBillingUsage,
  ApiPreset,
} from '../types';

import type {
  ApiCallLogEntry,
} from './apiCallLog';

import { DB } from './db';

import {
  calculateApiCallCost,
  matchApiPresetForBilling,
  snapshotPricing,
} from './apiPricing';

const stripTrailingSlash = (
  value: string,
): string =>
  value.replace(/\/+$/, '');

function usageFromLegacyEntry(
  entry: ApiCallLogEntry,
): ApiBillingUsage {
  if (entry.billingUsage) {
    return entry.billingUsage;
  }

  const prompt =
    Math.max(
      0,
      entry.promptTokens
      ?? 0,
    );

  const cacheRead =
    Math.max(
      0,
      entry.cachedTokens
      ?? 0,
    );

  const cacheWrite =
    Math.max(
      0,
      entry.cacheMissTokens
      ?? 0,
    );

  const hasCacheWrite =
    entry.cacheMissTokens
    !== undefined;

  const input =
    hasCacheWrite
      ? Math.max(
          0,
          prompt
          - cacheRead
          - cacheWrite,
        )
      : Math.max(
          0,
          prompt
          - cacheRead,
        );

  return {
    inputTokens: input,
    cacheWriteTokens:
      cacheWrite,
    cacheReadTokens:
      cacheRead,
    outputTokens:
      Math.max(
        0,
        entry.completionTokens
        ?? 0,
      ),
    usageAvailable:
      entry.promptTokens
        !== undefined
      || entry.completionTokens
        !== undefined
      || entry.totalTokens
        !== undefined,
  };
}

export async function backfillUnpricedCallsForPreset(
  preset: ApiPreset,
): Promise<number> {
  if (!preset.pricing) {
    return 0;
  }

  const entries =
    await DB.getApiCallLog();

  let changed = 0;

  for (
    const entry
    of entries
  ) {
    if (
      entry.costStatus
      && entry.costStatus
        !== 'unpriced'
    ) {
      continue;
    }

    if (
      stripTrailingSlash(
        entry.baseUrl
        || '',
      )
      !== stripTrailingSlash(
        preset.config.baseUrl
        || '',
      )
      || (
        entry.model
        || ''
      ) !== (
        preset.config.model
        || ''
      )
    ) {
      continue;
    }

    const usage =
      usageFromLegacyEntry(
        entry,
      );

    const pricingSnapshot =
      snapshotPricing(preset);

    const cost =
      calculateApiCallCost({
        pricingSnapshot,
        usage,
        ok: entry.ok,
        networkRequest:
          entry.networkRequest
          ?? true,
        cacheHit:
          entry.cacheHit
          ?? false,
      });

    if (
      cost.costStatus
      === 'unpriced'
    ) {
      continue;
    }

    const didChange =
      await DB
        .applyApiCallCostBackfill(
          entry.id,
          {
            presetId:
              preset.id,
            presetName:
              preset.name,
            billingUsage:
              usage,
            pricingSnapshot,
            costStatus:
              cost.costStatus,
            costMicros:
              cost.costMicros,
            unpricedReason:
              cost.unpricedReason,
          },
        );

    if (didChange) {
      changed++;
    }
  }

  if (changed > 0) {
    const {
      emitApiCostUpdated,
    } = await import(
      './apiCostEvents'
    );

    emitApiCostUpdated();
  }

  return changed;
}
