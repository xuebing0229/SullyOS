import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  calculateApiCallCost,
  normalizeApiBillingUsage,
  yuanStringToMicros,
} from './apiPricing';

describe(
  'api pricing',
  () => {
    it(
      'parses yuan without float drift',
      () => {
        expect(
          yuanStringToMicros(
            '0.250001',
          )?.toString(),
        ).toBe('250001');
      },
    );

    it(
      'charges per request',
      () => {
        const result =
          calculateApiCallCost({
            pricingSnapshot: {
              presetId: 'p1',
              presetName: '测试',
              pricing: {
                mode:
                  'per_request',
                pricePerRequestYuan:
                  '0.25',
              },
            },
            usage: {
              inputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
              usageAvailable: false,
            },
            ok: true,
            networkRequest: true,
            cacheHit: false,
          });

        expect(
          result.costMicros,
        ).toBe('250000');
      },
    );

    it(
      'separates input cache write cache read and output',
      () => {
        const result =
          calculateApiCallCost({
            pricingSnapshot: {
              presetId: 'p1',
              presetName: '测试',
              pricing: {
                mode:
                  'per_token',
                inputYuanPerMillion:
                  '10',
                cacheWriteYuanPerMillion:
                  '20',
                cacheReadYuanPerMillion:
                  '2',
                outputYuanPerMillion:
                  '50',
              },
            },
            usage: {
              inputTokens: 100_000,
              cacheWriteTokens: 50_000,
              cacheReadTokens: 200_000,
              outputTokens: 10_000,
              usageAvailable: true,
            },
            ok: true,
            networkRequest: true,
            cacheHit: false,
          });

        // 1 + 1 + 0.4 + 0.5 = 2.9 元
        expect(
          result.costMicros,
        ).toBe('2900000');
      },
    );

    it(
      'normalizes anthropic cache usage',
      () => {
        expect(
          normalizeApiBillingUsage({
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 300,
              output_tokens: 40,
            },
          }),
        ).toEqual({
          inputTokens: 100,
          cacheWriteTokens: 200,
          cacheReadTokens: 300,
          outputTokens: 40,
          usageAvailable: true,
        });
      },
    );

    it(
      'normalizes openai cached tokens without double counting',
      () => {
        expect(
          normalizeApiBillingUsage({
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              prompt_tokens_details: {
                cached_tokens: 600,
              },
            },
          }),
        ).toEqual({
          inputTokens: 400,
          cacheWriteTokens: 0,
          cacheReadTokens: 600,
          outputTokens: 50,
          usageAvailable: true,
        });
      },
    );

    it(
      'normalizes hit and miss cache usage',
      () => {
        expect(
          normalizeApiBillingUsage({
            usage: {
              prompt_tokens: 1000,
              prompt_cache_hit_tokens: 700,
              prompt_cache_miss_tokens: 300,
              completion_tokens: 50,
            },
          }),
        ).toEqual({
          inputTokens: 0,
          cacheWriteTokens: 300,
          cacheReadTokens: 700,
          outputTokens: 50,
          usageAvailable: true,
        });
      },
    );

    it(
      'does not charge local cache',
      () => {
        const result =
          calculateApiCallCost({
            pricingSnapshot: {
              presetId: 'p1',
              presetName: '测试',
              pricing: {
                mode:
                  'per_request',
                pricePerRequestYuan:
                  '9',
              },
            },
            usage: {
              inputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
              usageAvailable: false,
            },
            ok: true,
            networkRequest: false,
            cacheHit: true,
          });

        expect(
          result.costStatus,
        ).toBe(
          'free_local_cache',
        );
      },
    );
  },
);
