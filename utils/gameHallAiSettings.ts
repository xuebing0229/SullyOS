import type { APIConfig, ApiPreset } from '../types';

export const GAME_HALL_AI_SETTINGS_KEY =
  'sullyos.gameHall.ai.settings.v1';

export type GameHallAiSource =
  | 'global'
  | 'preset';

export interface GameHallAiSettings {
  source: GameHallAiSource;
  /** 当前选择，可随时改；不是锁定或绑定。 */
  selectedPresetId?: string;
  updatedAt: number;
}

export interface GameHallApiIdentity {
  presetId?: string;
  presetName?: string;
  source: GameHallAiSource;
}

export interface ResolvedGameHallAi {
  settings: GameHallAiSettings;
  apiConfig: APIConfig;
  identity: GameHallApiIdentity;
  selectedPreset?: ApiPreset;
  globalPreset?: ApiPreset;
  fallbackToGlobal: boolean;
  warning?: string;
}

const defaultSettings = (): GameHallAiSettings => ({
  source: 'global',
  updatedAt: 0,
});

export const normalizeGameHallAiSettings = (
  value: unknown,
): GameHallAiSettings => {
  const raw =
    value
    && typeof value === 'object'
    && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};

  const source: GameHallAiSource =
    raw.source === 'preset'
      ? 'preset'
      : 'global';

  const selectedPresetId =
    typeof raw.selectedPresetId === 'string'
      && raw.selectedPresetId.trim()
      ? raw.selectedPresetId.trim()
      : undefined;

  return {
    source,
    selectedPresetId,
    updatedAt:
      Number.isFinite(Number(raw.updatedAt))
        ? Number(raw.updatedAt)
        : 0,
  };
};

export const loadGameHallAiSettings =
  (): GameHallAiSettings => {
    try {
      return normalizeGameHallAiSettings(
        JSON.parse(
          localStorage.getItem(
            GAME_HALL_AI_SETTINGS_KEY,
          ) || '{}',
        ),
      );
    } catch {
      return defaultSettings();
    }
  };

export const saveGameHallAiSettings = (
  settings: GameHallAiSettings,
): GameHallAiSettings => {
  const normalized = normalizeGameHallAiSettings({
    ...settings,
    updatedAt: Date.now(),
  });
  localStorage.setItem(
    GAME_HALL_AI_SETTINGS_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
};

const normalizeBase = (value: string): string =>
  String(value || '')
    .trim()
    .replace(/\/+$/, '');

const sameApi = (
  left: APIConfig | undefined,
  right: APIConfig | undefined,
): boolean =>
  !!left
  && !!right
  && normalizeBase(left.baseUrl)
      === normalizeBase(right.baseUrl)
  && String(left.model || '').trim()
      === String(right.model || '').trim()
  && String(left.apiKey || '').trim()
      === String(right.apiKey || '').trim();

const resolveGlobalPreset = (
  apiConfig: APIConfig,
  apiPresets: ApiPreset[],
  activeApiPresetId?: string | null,
): ApiPreset | undefined => {
  if (activeApiPresetId) {
    const active = apiPresets.find(
      preset =>
        preset.id === activeApiPresetId
        && sameApi(preset.config, apiConfig),
    );
    if (active) return active;
  }

  const exact = apiPresets.filter(
    preset => sameApi(preset.config, apiConfig),
  );
  return exact.length === 1
    ? exact[0]
    : undefined;
};

/**
 * 解析游戏厅本次应使用的 API。
 *
 * - global：实时跟随全局；
 * - preset：使用当前下拉框选中的预设，可随时切换；
 * - 已选预设被删除：保留选择值并给出可见警告，本次临时回退全局。
 */
export const resolveGameHallAi = (input: {
  settings: GameHallAiSettings;
  apiConfig: APIConfig;
  apiPresets: ApiPreset[];
  activeApiPresetId?: string | null;
}): ResolvedGameHallAi => {
  const settings =
    normalizeGameHallAiSettings(input.settings);
  const globalPreset =
    resolveGlobalPreset(
      input.apiConfig,
      input.apiPresets,
      input.activeApiPresetId,
    );

  if (settings.source === 'preset') {
    const selectedPreset =
      settings.selectedPresetId
        ? input.apiPresets.find(
            preset =>
              preset.id
              === settings.selectedPresetId,
          )
        : undefined;

    if (selectedPreset) {
      return {
        settings,
        apiConfig: {
          ...selectedPreset.config,
        },
        identity: {
          source: 'preset',
          presetId: selectedPreset.id,
          presetName: selectedPreset.name,
        },
        selectedPreset,
        globalPreset,
        fallbackToGlobal: false,
      };
    }

    return {
      settings,
      apiConfig: {
        ...input.apiConfig,
      },
      identity: {
        source: 'global',
        presetId: globalPreset?.id,
        presetName:
          globalPreset?.name
          || '当前全局 API',
      },
      globalPreset,
      fallbackToGlobal: true,
      warning:
        settings.selectedPresetId
          ? `游戏厅所选预设 ${settings.selectedPresetId} 已不存在；当前临时使用全局 API。请在下拉框重新选择。`
          : '游戏厅尚未选择专用预设；当前临时使用全局 API。',
    };
  }

  return {
    settings,
    apiConfig: {
      ...input.apiConfig,
    },
    identity: {
      source: 'global',
      presetId: globalPreset?.id,
      presetName:
        globalPreset?.name
        || '当前全局 API',
    },
    globalPreset,
    fallbackToGlobal: false,
  };
};
