import type { ApiPreset, ApiPricing } from '../types';

export type ApiPresetModelEntry = {
  model: string;
  pricing?: ApiPricing;
  /**
   * 仅供文游正文与剧情生图规划器读取。主聊天故意忽略这个字段。
   * 部分 OpenAI 兼容站会在大段 system / Gemini system_instruction 上异常，
   * 开启后文游会把完整 system 规则转移到普通消息兼容通道。
   */
  storySystemCompatibility?: boolean;
};

const EDGE_INVISIBLE_CHARS = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

export const normalizeApiPresetModelName = (value: unknown): string =>
  String(value ?? '').replace(EDGE_INVISIBLE_CHARS, '');

const rawModelEntries = (preset: ApiPreset): ApiPresetModelEntry[] =>
  Array.isArray(preset.models) ? preset.models : [];

/**
 * Old presets stored one model + one top-level price. New presets keep a model
 * collection, with pricing attached to each model. Reading stays backwards
 * compatible so old backups work before/after the one-time normalization.
 */
export function getApiPresetModelEntries(preset: ApiPreset): ApiPresetModelEntry[] {
  const raw = rawModelEntries(preset);
  const byModel = new Map<string, ApiPresetModelEntry>();

  for (const item of raw) {
    const model = normalizeApiPresetModelName(item?.model);
    if (!model) continue;
    const previous = byModel.get(model);
    byModel.set(model, {
      model,
      pricing: item?.pricing ?? previous?.pricing,
      ...(item?.storySystemCompatibility === true || previous?.storySystemCompatibility === true
        ? { storySystemCompatibility: true }
        : {}),
    });
  }

  const defaultModel = normalizeApiPresetModelName(preset.config?.model);
  if (raw.length === 0) {
    if (defaultModel) {
      byModel.set(defaultModel, {
        model: defaultModel,
        pricing: preset.pricing,
      });
    }
  } else if (defaultModel && !byModel.has(defaultModel)) {
    byModel.set(defaultModel, { model: defaultModel });
  }

  return [...byModel.values()];
}

export function apiPresetHasModel(preset: ApiPreset, model: unknown): boolean {
  const target = normalizeApiPresetModelName(model);
  return Boolean(target) && getApiPresetModelEntries(preset)
    .some(item => item.model === target);
}

export function getApiPresetPricing(
  preset: ApiPreset | undefined,
  model: unknown,
  fallbackToDefault = false,
): ApiPricing | undefined {
  if (!preset) return undefined;
  const target = normalizeApiPresetModelName(model);
  const entries = getApiPresetModelEntries(preset);
  const exact = target ? entries.find(item => item.model === target) : undefined;
  if (exact?.pricing) return exact.pricing;

  if (fallbackToDefault) {
    const defaultModel = normalizeApiPresetModelName(preset.config?.model);
    return entries.find(item => item.model === defaultModel)?.pricing;
  }

  return undefined;
}

export function getApiPresetStorySystemCompatibility(
  preset: ApiPreset | undefined,
  model: unknown,
): boolean {
  if (!preset) return false;
  const target = normalizeApiPresetModelName(model || preset.config?.model);
  if (!target) return false;
  return getApiPresetModelEntries(preset)
    .find(item => item.model === target)
    ?.storySystemCompatibility === true;
}

export function ensureApiPresetModel(
  preset: ApiPreset,
  model: unknown,
): ApiPreset {
  const target = normalizeApiPresetModelName(model);
  if (!target) return preset;
  const entries = getApiPresetModelEntries(preset);
  if (!entries.some(item => item.model === target)) {
    entries.push({ model: target });
  }
  return { ...preset, models: entries };
}

export function setApiPresetDefaultModel(
  preset: ApiPreset,
  model: unknown,
): ApiPreset {
  const target = normalizeApiPresetModelName(model);
  if (!target) return preset;
  const ensured = ensureApiPresetModel(preset, target);
  return {
    ...ensured,
    config: {
      ...ensured.config,
      model: target,
    },
  };
}

export function removeApiPresetModel(
  preset: ApiPreset,
  model: unknown,
): ApiPreset {
  const target = normalizeApiPresetModelName(model);
  if (!target) return preset;

  const entries = getApiPresetModelEntries(preset);
  if (entries.length <= 1) return preset;

  const remaining = entries.filter(item => item.model !== target);
  if (remaining.length === entries.length) return preset;

  const defaultModel = normalizeApiPresetModelName(preset.config?.model);
  const nextDefaultModel = defaultModel === target
    ? remaining[0]?.model || ''
    : defaultModel;

  return {
    ...preset,
    models: remaining,
    config: {
      ...preset.config,
      model: nextDefaultModel,
    },
  };
}

export function setApiPresetModelPricing(
  preset: ApiPreset,
  model: unknown,
  pricing: ApiPricing,
): ApiPreset {
  const target = normalizeApiPresetModelName(model);
  if (!target) return preset;
  const entries = getApiPresetModelEntries(preset);
  const index = entries.findIndex(item => item.model === target);
  if (index >= 0) {
    entries[index] = { ...entries[index], pricing };
  } else {
    entries.push({ model: target, pricing });
  }
  return { ...preset, models: entries };
}

export function setApiPresetModelStorySystemCompatibility(
  preset: ApiPreset,
  model: unknown,
  enabled: boolean,
): ApiPreset {
  const target = normalizeApiPresetModelName(model);
  if (!target) return preset;
  const entries = getApiPresetModelEntries(preset);
  const index = entries.findIndex(item => item.model === target);
  const current = index >= 0 ? entries[index] : { model: target };
  const next: ApiPresetModelEntry = { ...current };
  if (enabled) next.storySystemCompatibility = true;
  else delete next.storySystemCompatibility;
  if (index >= 0) entries[index] = next;
  else entries.push(next);
  return { ...preset, models: entries };
}

export function normalizeApiPresetModels(preset: ApiPreset): ApiPreset {
  return {
    ...preset,
    models: getApiPresetModelEntries(preset),
  };
}
