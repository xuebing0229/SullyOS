import type { APIConfig, ApiPreset } from '../types';

export const GAME_HALL_API_SETTINGS_EVENT =
  'sullyos:game-hall-api-settings-changed';

const KEY = 'sullyos_game_hall_api_settings_v1';

export interface GameHallApiSettings {
  version: 1;

  /**
   * null = 跟随当前聊天 API。
   * 非空 = 使用 apiPresets 中对应预设。用户随时可切换，不锁死。
   */
  activePresetId: string | null;

  /** 默认不限；只有用户填了正整数才限制。 */
  maxTurns: number | null;

  /** 可设为 0。 */
  stepDelayMs: number;

  /** 自主玩完后是否自动生成交接卡回到主聊天。 */
  autoHandoffOnFinish: boolean;
}

export const DEFAULT_GAME_HALL_API_SETTINGS: GameHallApiSettings = {
  version: 1,
  activePresetId: null,
  maxTurns: null,
  stepDelayMs: 1200,
  autoHandoffOnFinish: true,
};

const finiteNonNegative = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function loadGameHallApiSettings(): GameHallApiSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULT_GAME_HALL_API_SETTINGS };
    }
    const max = Number(raw.maxTurns);
    return {
      version: 1,
      activePresetId:
        typeof raw.activePresetId === 'string' && raw.activePresetId.trim()
          ? raw.activePresetId
          : null,
      maxTurns:
        Number.isFinite(max) && max > 0
          ? Math.floor(max)
          : null,
      stepDelayMs: finiteNonNegative(
        raw.stepDelayMs,
        DEFAULT_GAME_HALL_API_SETTINGS.stepDelayMs,
      ),
      autoHandoffOnFinish:
        raw.autoHandoffOnFinish !== false,
    };
  } catch {
    return { ...DEFAULT_GAME_HALL_API_SETTINGS };
  }
}

export function saveGameHallApiSettings(
  settings: GameHallApiSettings,
): void {
  localStorage.setItem(KEY, JSON.stringify({
    ...settings,
    version: 1,
  }));
  try {
    window.dispatchEvent(
      new CustomEvent(GAME_HALL_API_SETTINGS_EVENT),
    );
  } catch {
    // SSR / test
  }
}

export interface ResolvedGameHallApi {
  config: APIConfig;
  presetId: string | null;
  presetName: string;
  fellBackToDefault: boolean;
}

export function resolveGameHallApiConfig(
  defaultApi: APIConfig,
  presets: ApiPreset[],
  settings: GameHallApiSettings = loadGameHallApiSettings(),
): ResolvedGameHallApi {
  if (!settings.activePresetId) {
    return {
      config: defaultApi,
      presetId: null,
      presetName: '跟随当前聊天 API',
      fellBackToDefault: false,
    };
  }

  const preset = presets.find(item => item.id === settings.activePresetId);
  if (!preset) {
    return {
      config: defaultApi,
      presetId: null,
      presetName: '所选预设已不存在，已跟随当前聊天 API',
      fellBackToDefault: true,
    };
  }

  return {
    config: preset.config,
    presetId: preset.id,
    presetName: preset.name,
    fellBackToDefault: false,
  };
}
