export const GAME_HALL_API_SETTINGS_EVENT =
  'sullyos:game-hall-api-settings-changed';

const KEY = 'sullyos_game_hall_api_settings_v1';

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
