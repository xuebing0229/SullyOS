import type { APIConfig, ApiPreset } from '../types';
import { API_FAILOVER_STORAGE_KEY } from './apiFailover';

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

/**
 * Failover members historically persisted the concrete model even when the row merely
 * pointed at a preset's default model. That turns a Story route into a stale snapshot:
 * editing the preset from model A to model B still leaves the route pinned to A.
 *
 * When the stored member equals the preset's *previous* default, drop that redundant
 * model override so the row resumes following preset.config.model. A genuinely selected
 * alternate model is left untouched.
 */
function releaseStaleDefaultModelBindings(
  previous: ApiPreset,
  next: ApiPreset,
): void {
  if (typeof localStorage === 'undefined') return;

  const previousModel = String(previous.config?.model || '').trim();
  const nextModel = String(next.config?.model || '').trim();
  if (!previousModel || previousModel === nextModel) return;

  try {
    const parsed = JSON.parse(
      localStorage.getItem(API_FAILOVER_STORAGE_KEY) || '[]',
    );
    if (!Array.isArray(parsed)) return;

    let changed = false;
    const updatedAt = Date.now();
    const updatedGroups = parsed.map((group: any) => {
      if (!Array.isArray(group?.members)) return group;

      let groupChanged = false;
      const members = group.members.map((member: any) => {
        if (
          String(member?.presetId || '').trim() !== previous.id
          || String(member?.model || '').trim() !== previousModel
        ) {
          return member;
        }

        const { model: _staleDefaultModel, ...rest } = member;
        groupChanged = true;
        changed = true;
        return rest;
      });

      return groupChanged
        ? { ...group, members, updatedAt }
        : group;
    });

    if (changed) {
      localStorage.setItem(
        API_FAILOVER_STORAGE_KEY,
        JSON.stringify(updatedGroups),
      );
    }
  } catch (error) {
    console.warn('[apiPreset] failed to refresh routed preset model', error);
  }
}

/** Merge an edit without dropping pricing or other preset metadata. */
export function mergeApiPresetPatch(
  previous: ApiPreset,
  patch: Partial<ApiPreset>,
): ApiPreset {
  const next: ApiPreset = {
    ...previous,
    ...patch,
    config: patch.config ?? previous.config,
  };

  releaseStaleDefaultModelBindings(previous, next);
  return next;
}
