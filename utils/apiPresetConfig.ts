import type { APIConfig, ApiPreset } from '../types';

export interface ApiPresetConnectionDraft {
  baseUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  temperature: number;
}

export type ApiPresetConnectionConfig = Pick<
  APIConfig,
  'baseUrl' | 'apiKey' | 'model' | 'stream' | 'temperature'
>;

/** API presets contain chat connection fields only, never unrelated global APIs. */
export function buildApiPresetConfig(
  draft: ApiPresetConnectionDraft,
): ApiPresetConnectionConfig {
  return {
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
    stream: draft.stream,
    temperature: Number.isFinite(draft.temperature) ? draft.temperature : 0.85,
  };
}

/** Apply a chat preset without dropping MiniMax, Fish Audio, ACE-Step, etc. */
export function applyApiPresetConfig(
  current: APIConfig,
  preset: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'> & Partial<ApiPresetConnectionConfig>,
): APIConfig {
  return {
    ...current,
    baseUrl: preset.baseUrl,
    apiKey: preset.apiKey,
    model: preset.model,
    stream: preset.stream === true,
    temperature: typeof preset.temperature === 'number' && Number.isFinite(preset.temperature)
      ? preset.temperature
      : 0.85,
  };
}

/** Merge an edit without dropping pricing or other preset metadata. */
export function mergeApiPresetPatch(
  previous: ApiPreset,
  patch: Partial<ApiPreset>,
): ApiPreset {
  return {
    ...previous,
    ...patch,
    config: patch.config ?? previous.config,
  };
}
