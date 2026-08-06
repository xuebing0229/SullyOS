export const GAME_HALL_API_SETTINGS_EVENT =
  'sullyos:game-hall-api-settings-changed';

export const GAME_HALL_API_SETTINGS_STORAGE_KEY =
  'sullyos_game_hall_api_settings_v1';

export interface GameHallApiSettings {
  version: 1;

  /** 默认不限；只有用户填了正整数才限制。 */
  maxTurns: number | null;

  /** 可设为 0。 */
  stepDelayMs: number;

  /** 自主玩完后是否自动生成交接卡回到主聊天。 */
  autoHandoffOnFinish: boolean;
}

export const DEFAULT_GAME_HALL_API_SETTINGS: GameHallApiSettings = {
  version: 1,
  maxTurns: null,
  stepDelayMs: 1200,
  autoHandoffOnFinish: true,
};

export function normalizeGameHallApiSettings(
  value: unknown,
): GameHallApiSettings {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  const maxTurns = Number(raw.maxTurns);
  const stepDelayMs = Number(raw.stepDelayMs);
  return {
    version: 1,
    maxTurns:
      Number.isFinite(maxTurns) && maxTurns > 0
        ? Math.floor(maxTurns)
        : null,
    stepDelayMs:
      Number.isFinite(stepDelayMs) && stepDelayMs >= 0
        ? stepDelayMs
        : DEFAULT_GAME_HALL_API_SETTINGS.stepDelayMs,
    autoHandoffOnFinish: raw.autoHandoffOnFinish !== false,
  };
}

export function loadGameHallApiSettings(): GameHallApiSettings {
  try {
    return normalizeGameHallApiSettings(
      JSON.parse(
        localStorage.getItem(
          GAME_HALL_API_SETTINGS_STORAGE_KEY,
        ) || 'null',
      ),
    );
  } catch {
    return { ...DEFAULT_GAME_HALL_API_SETTINGS };
  }
}

export function saveGameHallApiSettings(
  settings: GameHallApiSettings,
): void {
  localStorage.setItem(
    GAME_HALL_API_SETTINGS_STORAGE_KEY,
    JSON.stringify(normalizeGameHallApiSettings(settings)),
  );
  try {
    window.dispatchEvent(
      new CustomEvent(GAME_HALL_API_SETTINGS_EVENT),
    );
  } catch {
    // SSR / test
  }
}
