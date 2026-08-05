import type {
  ApiBillingUsage,
  ApiCallCostStatus,
  ApiCallUnpricedReason,
  ApiPricing,
  ApiPricingSnapshot,
  ApiPreset,
} from '../types';
import { matchApiPresetRoute } from './apiPresetRouteIdentity';

const MICROS_PER_YUAN = 1_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;

export interface ApiCostCalculation {
  costStatus: ApiCallCostStatus;
  costMicros?: string;
  unpricedReason?: ApiCallUnpricedReason;
}

const finiteNonNegativeInteger = (
  value: unknown,
): number | undefined => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
  ) {
    return undefined;
  }

  return Math.floor(value);
};

const firstNumber = (
  ...values: unknown[]
): number | undefined => {
  for (const value of values) {
    const parsed =
      finiteNonNegativeInteger(value);

    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
};

export const cloneApiPricing = (
  pricing: ApiPricing,
): ApiPricing =>
  pricing.mode === 'per_request'
    ? {
        mode: 'per_request',
        pricePerRequestYuan:
          pricing.pricePerRequestYuan,
      }
    : {
        mode: 'per_token',
        inputYuanPerMillion:
          pricing.inputYuanPerMillion,
        cacheWriteYuanPerMillion:
          pricing.cacheWriteYuanPerMillion,
        cacheReadYuanPerMillion:
          pricing.cacheReadYuanPerMillion,
        outputYuanPerMillion:
          pricing.outputYuanPerMillion,
      };

/**
 * 最多保留 6 位小数，输出人民币微元。
 * 非法或负数返回 null。
 */
export function yuanStringToMicros(
  raw: string | undefined,
): bigint | null {
  const value = String(raw ?? '').trim();

  if (!/^\d+(?:\.\d{0,6})?$/.test(value)) {
    return null;
  }

  const [
    whole,
    fraction = '',
  ] = value.split('.');

  try {
    return (
      BigInt(whole) * MICROS_PER_YUAN
      + BigInt(
          fraction
            .padEnd(6, '0')
            .slice(0, 6)
          || '0',
        )
    );
  } catch {
    return null;
  }
}

export function microsToYuanString(
  raw: string | bigint | undefined,
  options: {
    minFractionDigits?: number;
    maxFractionDigits?: number;
  } = {},
): string {
  let micros: bigint;

  try {
    micros =
      typeof raw === 'bigint'
        ? raw
        : BigInt(raw || '0');
  } catch {
    micros = 0n;
  }

  const negative = micros < 0n;
  const absolute =
    negative ? -micros : micros;

  const whole =
    absolute / MICROS_PER_YUAN;

  const fractionRaw =
    (absolute % MICROS_PER_YUAN)
      .toString()
      .padStart(6, '0');

  const min =
    Math.max(
      0,
      Math.min(
        6,
        options.minFractionDigits ?? 2,
      ),
    );

  const max =
    Math.max(
      min,
      Math.min(
        6,
        options.maxFractionDigits ?? 6,
      ),
    );

  let fraction =
    fractionRaw.slice(0, max);

  while (
    fraction.length > min
    && fraction.endsWith('0')
  ) {
    fraction =
      fraction.slice(0, -1);
  }

  return (
    `${negative ? '-' : ''}${whole}`
    + (
      fraction
        ? `.${fraction}`
        : ''
    )
  );
}

export function formatYuan(
  costMicros: string | bigint | undefined,
  options: {
    compact?: boolean;
  } = {},
): string {
  const micros =
    (() => {
      try {
        return typeof costMicros === 'bigint'
          ? costMicros
          : BigInt(costMicros || '0');
      } catch {
        return 0n;
      }
    })();

  const yuanNumber =
    Number(micros)
    / Number(MICROS_PER_YUAN);

  if (
    options.compact
    && Number.isFinite(yuanNumber)
    && Math.abs(yuanNumber) >= 10_000
  ) {
    return `¥${new Intl.NumberFormat(
      'zh-CN',
      {
        notation: 'compact',
        maximumFractionDigits: 2,
      },
    ).format(yuanNumber)}`;
  }

  return (
    '¥'
    + microsToYuanString(
        micros,
        {
          minFractionDigits: 2,
          maxFractionDigits: 6,
        },
      )
  );
}

export const addMicros = (
  left: string | undefined,
  right: string | undefined,
): string => {
  try {
    return (
      BigInt(left || '0')
      + BigInt(right || '0')
    ).toString();
  } catch {
    return '0';
  }
};

export const compareMicros = (
  left: string | undefined,
  right: string | undefined,
): number => {
  let a = 0n;
  let b = 0n;

  try {
    a = BigInt(left || '0');
  } catch {}

  try {
    b = BigInt(right || '0');
  } catch {}

  return a < b ? -1 : a > b ? 1 : 0;
};

function tokenCostMicros(
  tokens: number,
  yuanPerMillion: string,
): bigint | null {
  const rateMicros =
    yuanStringToMicros(
      yuanPerMillion,
    );

  if (rateMicros === null) {
    return null;
  }

  return (
    BigInt(
      Math.max(
        0,
        Math.floor(tokens),
      ),
    )
    * rateMicros
    + TOKENS_PER_MILLION / 2n
  ) / TOKENS_PER_MILLION;
}

/**
 * 兼容：
 * - OpenAI compatible usage
 * - Anthropic cache fields
 * - DeepSeek cache hit/miss fields
 * - Gemini usageMetadata
 */
export function normalizeApiBillingUsage(
  response: unknown,
): ApiBillingUsage {
  const root = response as any;

  const usage =
    root?.usage
    ?? root?.usageMetadata
    ?? root?.usage_metadata;

  if (
    !usage
    || typeof usage !== 'object'
  ) {
    return {
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      usageAvailable: false,
    };
  }

  const promptTotal =
    firstNumber(
      usage.prompt_tokens,
      usage.input_tokens,
      usage.promptTokenCount,
      usage.inputTokens,
    ) ?? 0;

  const output =
    firstNumber(
      usage.completion_tokens,
      usage.output_tokens,
      usage.candidatesTokenCount,
      usage.outputTokens,
    ) ?? 0;

  const anthropicWrite =
    firstNumber(
      usage.cache_creation_input_tokens,
      usage.cache_creation_tokens,
      usage.cacheWriteTokens,
    );

  const anthropicRead =
    firstNumber(
      usage.cache_read_input_tokens,
      usage.cache_read_tokens,
      usage.cacheReadTokens,
    );

  const deepSeekHit =
    firstNumber(
      usage.prompt_cache_hit_tokens,
      usage.cache_hit_tokens,
    );

  const deepSeekMiss =
    firstNumber(
      usage.prompt_cache_miss_tokens,
      usage.cache_miss_tokens,
    );

  const openAiCached =
    firstNumber(
      usage.prompt_tokens_details
        ?.cached_tokens,
      usage.input_tokens_details
        ?.cached_tokens,
      usage.cached_tokens,
      usage.cached_content_token_count,
      usage.cachedContentTokenCount,
    );

  let cacheWrite = 0;
  let cacheRead = 0;
  let input = promptTotal;

  const hasAnthropicCache =
    anthropicWrite !== undefined
    || anthropicRead !== undefined;

  const hasHitMissCache =
    deepSeekHit !== undefined
    || deepSeekMiss !== undefined;

  if (hasAnthropicCache) {
    cacheWrite =
      anthropicWrite ?? 0;

    cacheRead =
      anthropicRead ?? 0;

    /*
     * Anthropic 原生 input_tokens 通常就是普通输入，
     * 不从中重复扣 cache write/read。
     */
    input = promptTotal;
  } else if (hasHitMissCache) {
    cacheWrite =
      deepSeekMiss ?? 0;

    cacheRead =
      deepSeekHit ?? 0;

    /*
     * DeepSeek 的 prompt_tokens 通常等于 hit + miss。
     * 若代理额外包含普通输入，只把余数记普通输入。
     */
    input =
      Math.max(
        0,
        promptTotal
        - cacheWrite
        - cacheRead,
      );
  } else {
    cacheRead =
      openAiCached ?? 0;

    /*
     * OpenAI prompt_tokens 包含 cached_tokens。
     */
    input =
      Math.max(
        0,
        promptTotal
        - cacheRead,
      );
  }

  return {
    inputTokens:
      Math.floor(input),
    cacheWriteTokens:
      Math.floor(cacheWrite),
    cacheReadTokens:
      Math.floor(cacheRead),
    outputTokens:
      Math.floor(output),
    usageAvailable: true,
  };
}

export function calculateApiCallCost(
  input: {
    pricingSnapshot?: ApiPricingSnapshot;
    usage: ApiBillingUsage;
    ok: boolean;
    networkRequest: boolean;
    cacheHit: boolean;
    missingPresetReason?:
      | 'preset_not_found'
      | 'preset_ambiguous';
  },
): ApiCostCalculation {
  if (
    input.cacheHit
    || !input.networkRequest
  ) {
    return {
      costStatus:
        'free_local_cache',
      costMicros: '0',
    };
  }

  if (!input.ok) {
    return {
      costStatus: 'free_failed',
      costMicros: '0',
    };
  }

  if (!input.pricingSnapshot) {
    return {
      costStatus: 'unpriced',
      unpricedReason:
        input.missingPresetReason
        ?? 'pricing_not_configured',
    };
  }

  const pricing =
    input.pricingSnapshot.pricing;

  if (
    pricing.mode
    === 'per_request'
  ) {
    const micros =
      yuanStringToMicros(
        pricing.pricePerRequestYuan,
      );

    if (micros === null) {
      return {
        costStatus: 'unpriced',
        unpricedReason:
          'pricing_not_configured',
      };
    }

    return {
      costStatus: 'priced',
      costMicros:
        micros.toString(),
    };
  }

  if (!input.usage.usageAvailable) {
    return {
      costStatus: 'unpriced',
      unpricedReason:
        'usage_missing',
    };
  }

  const pieces = [
    tokenCostMicros(
      input.usage.inputTokens,
      pricing.inputYuanPerMillion,
    ),
    tokenCostMicros(
      input.usage.cacheWriteTokens,
      pricing.cacheWriteYuanPerMillion,
    ),
    tokenCostMicros(
      input.usage.cacheReadTokens,
      pricing.cacheReadYuanPerMillion,
    ),
    tokenCostMicros(
      input.usage.outputTokens,
      pricing.outputYuanPerMillion,
    ),
  ];

  if (
    pieces.some(
      value => value === null,
    )
  ) {
    return {
      costStatus: 'unpriced',
      unpricedReason:
        'pricing_not_configured',
    };
  }

  const total =
    (pieces as bigint[])
      .reduce(
        (sum, value) =>
          sum + value,
        0n,
      );

  return {
    costStatus: 'priced',
    costMicros:
      total.toString(),
  };
}

export function matchApiPresetForBilling(
  presets: ApiPreset[],
  input: {
    baseUrl: string;
    model: string;
    activePresetId?: string | null;
    apiKey?: string;
  },
): {
  preset?: ApiPreset;
  reason?:
    | 'preset_not_found'
    | 'preset_ambiguous';
} {
  const matched = matchApiPresetRoute(
    presets,
    {
      baseUrl: input.baseUrl,
      model: input.model,
      preferredPresetId:
        input.activePresetId,
      apiKey: input.apiKey,
    },
  );

  return matched.preset
    ? { preset: matched.preset }
    : { reason: matched.reason };
}

export function snapshotPricing(
  preset: ApiPreset | undefined,
): ApiPricingSnapshot | undefined {
  if (!preset?.pricing) {
    return undefined;
  }

  return {
    presetId: preset.id,
    presetName: preset.name,
    pricing:
      cloneApiPricing(
        preset.pricing,
      ),
  };
}

export function isApiPricingComplete(
  pricing: ApiPricing | undefined,
): boolean {
  if (!pricing) return false;

  if (
    pricing.mode
    === 'per_request'
  ) {
    return (
      yuanStringToMicros(
        pricing.pricePerRequestYuan,
      ) !== null
    );
  }

  return [
    pricing.inputYuanPerMillion,
    pricing.cacheWriteYuanPerMillion,
    pricing.cacheReadYuanPerMillion,
    pricing.outputYuanPerMillion,
  ].every(
    value =>
      yuanStringToMicros(value)
      !== null,
  );
}
