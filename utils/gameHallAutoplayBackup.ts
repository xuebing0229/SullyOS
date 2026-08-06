import type { GameHallSession } from './gameHallTypes';
import {
  GAME_HALL_AI_SETTINGS_KEY,
  loadGameHallAiSettings,
  normalizeGameHallAiSettings,
  saveGameHallAiSettings,
  type GameHallAiSettings,
} from './gameHallAiSettings';
import {
  GAME_HALL_API_SETTINGS_STORAGE_KEY,
  loadGameHallApiSettings,
  normalizeGameHallApiSettings,
  saveGameHallApiSettings,
  type GameHallApiSettings,
} from './gameHallApiPreset';
import {
  GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY,
  clearGameHallAutoplayCommandQueue,
} from './gameHallAutoplayIntent';

export const GAME_HALL_AUTOPLAY_BACKUP_VERSION = 1 as const;

export interface GameHallAutoplayBackup {
  version: typeof GAME_HALL_AUTOPLAY_BACKUP_VERSION;
  /** 仅保存来源与预设 ID，不复制 API Key。 */
  aiSettings: GameHallAiSettings;
  autoplaySettings: GameHallApiSettings;
}

export interface GameHallAutoplayImportResult {
  settingsRestored: boolean;
  migratedLegacySettings: boolean;
  commandQueueCleared: boolean;
}

const hasOwn = (value: unknown, key: PropertyKey): boolean =>
  Boolean(
    value
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key),
  );

const safeParseJson = (value: unknown): unknown => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const legacyAiSettings = (value: unknown): GameHallAiSettings | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const selectedPresetId =
    typeof raw.activePresetId === 'string'
    && raw.activePresetId.trim()
      ? raw.activePresetId.trim()
      : undefined;
  return normalizeGameHallAiSettings({
    source: selectedPresetId ? 'preset' : 'global',
    selectedPresetId,
    updatedAt: 0,
  });
};

export function exportGameHallAutoplayBackup(): GameHallAutoplayBackup {
  return {
    version: GAME_HALL_AUTOPLAY_BACKUP_VERSION,
    aiSettings: loadGameHallAiSettings(),
    autoplaySettings: loadGameHallApiSettings(),
  };
}

export function sanitizeGameHallAutoplayBackup(
  value: unknown,
): GameHallAutoplayBackup | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== GAME_HALL_AUTOPLAY_BACKUP_VERSION) return null;

  // 兼容补丁早期草案的单一 settings 结构。
  const legacy = raw.settings;
  return {
    version: GAME_HALL_AUTOPLAY_BACKUP_VERSION,
    aiSettings: normalizeGameHallAiSettings(
      raw.aiSettings ?? legacyAiSettings(legacy) ?? undefined,
    ),
    autoplaySettings: normalizeGameHallApiSettings(
      raw.autoplaySettings ?? legacy,
    ),
  };
}

export function importGameHallAutoplayBackup(
  explicitBackup: unknown,
  legacyEventFlags?: Record<string, string> | null,
): GameHallAutoplayImportResult {
  const explicit = sanitizeGameHallAutoplayBackup(explicitBackup);
  const legacy = safeParseJson(
    legacyEventFlags?.[GAME_HALL_API_SETTINGS_STORAGE_KEY],
  );
  let settingsRestored = false;
  let migratedLegacySettings = false;

  if (explicit) {
    saveGameHallAiSettings(explicit.aiSettings);
    saveGameHallApiSettings(explicit.autoplaySettings);
    settingsRestored = true;
  } else if (legacy !== undefined) {
    const migratedAi = legacyAiSettings(legacy);
    if (migratedAi) saveGameHallAiSettings(migratedAi);
    saveGameHallApiSettings(normalizeGameHallApiSettings(legacy));
    settingsRestored = true;
    migratedLegacySettings = true;
  }

  clearGameHallAutoplayCommandQueue();
  return {
    settingsRestored,
    migratedLegacySettings,
    commandQueueCleared: true,
  };
}

export function isGameHallAutoplayRuntimeStorageKey(key: string): boolean {
  return key === GAME_HALL_AI_SETTINGS_KEY
    || key === GAME_HALL_API_SETTINGS_STORAGE_KEY
    || key === GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY;
}

export function exportLegacySullyEventFlags(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'> = localStorage,
): Record<string, string> | undefined {
  const flags: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith('sullyos_')) continue;
    if (isGameHallAutoplayRuntimeStorageKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) flags[key] = value;
  }
  return Object.keys(flags).length > 0 ? flags : undefined;
}

export function stripGameHallAutoplayKeysFromLegacyFlags(
  flags: Record<string, string> | undefined | null,
): Record<string, string> | undefined {
  if (!flags || typeof flags !== 'object') return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (isGameHallAutoplayRuntimeStorageKey(key)) continue;
    if (typeof value === 'string') cleaned[key] = value;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function backupContainsGameHallAutoplayData(data: {
  gameHallAutoplayLocal?: unknown;
  gameHallSessions?: unknown;
  eventNotifFlags?: Record<string, string>;
}): boolean {
  return hasOwn(data, 'gameHallAutoplayLocal')
    || hasOwn(data, 'gameHallSessions')
    || hasOwn(data.eventNotifFlags, GAME_HALL_API_SETTINGS_STORAGE_KEY)
    || hasOwn(
      data.eventNotifFlags,
      GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY,
    );
}

const RESTORE_PAUSE_STATUSES = new Set(['queued', 'running', 'stopping']);

export function shouldPauseAutoplayAfterRestore(
  session: GameHallSession,
): boolean {
  return Boolean(
    session.autoplay
    && RESTORE_PAUSE_STATUSES.has(session.autoplay.status),
  );
}

export function prepareGameHallSessionForRestore(
  session: GameHallSession,
  restoredAt = Date.now(),
): GameHallSession {
  if (!shouldPauseAutoplayAfterRestore(session)) return session;
  return {
    ...session,
    updatedAt: restoredAt,
    autoplay: {
      ...session.autoplay!,
      status: 'paused',
      stopReason: 'restored-from-backup',
      restoredFromBackupAt: restoredAt,
      updatedAt: restoredAt,
      completedAt: undefined,
    },
  };
}

export function prepareGameHallSessionsForRestore(
  sessions: GameHallSession[] | undefined | null,
  restoredAt = Date.now(),
): { sessions: GameHallSession[]; pausedCount: number } {
  if (!Array.isArray(sessions)) return { sessions: [], pausedCount: 0 };
  let pausedCount = 0;
  const prepared = sessions.map((session) => {
    if (shouldPauseAutoplayAfterRestore(session)) pausedCount += 1;
    return prepareGameHallSessionForRestore(session, restoredAt);
  });
  return { sessions: prepared, pausedCount };
}

export function countAutoplaySessionsNeedingRestorePause(
  sessions: GameHallSession[] | undefined | null,
): number {
  return Array.isArray(sessions)
    ? sessions.filter(shouldPauseAutoplayAfterRestore).length
    : 0;
}
