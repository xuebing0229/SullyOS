/**
 * 游戏厅持久数据的唯一备份登记表。
 *
 * 角色外部账号档案包含完整注册/登录资料，按用户要求随自用备份原样导出导入。
 * gameHallProtocolCache 是可重新发现的 MCP 协议缓存，故意不进入永久备份。
 */
export const GAME_HALL_BACKUP_STORES = [
  { storeName: 'gameHallSessions', field: 'gameHallSessions', label: '游戏厅会话' },
  { storeName: 'gameHallMessages', field: 'gameHallMessages', label: '游戏厅消息与完整工具返回' },
  { storeName: 'gameHallPendingActions', field: 'gameHallPendingActions', label: '游戏厅待确认行动' },
  { storeName: 'characterExternalAccounts', field: 'characterExternalAccounts', label: '角色外部账号档案' },
  // 旧版数据继续备份，防止升级后丢历史；新版交接不再依赖这些旁路表。
  { storeName: 'gameHallBridgeSnapshots', field: 'gameHallBridgeSnapshots', label: '旧版游戏厅聊天桥接快照' },
  { storeName: 'gameHallEvents', field: 'gameHallEvents', label: '旧版游戏厅事件' },
  { storeName: 'gameHallMemoryCandidates', field: 'gameHallMemoryCandidates', label: '旧版游戏厅记忆候选' },
  { storeName: 'gameHallPreferenceEvidence', field: 'gameHallPreferenceEvidence', label: '旧版游戏厅偏好证据' },
] as const;

export const GAME_HALL_PROTOCOL_CACHE_STORE = 'gameHallProtocolCache' as const;

export type GameHallBackupStoreName = typeof GAME_HALL_BACKUP_STORES[number]['storeName'];
export type GameHallBackupField = typeof GAME_HALL_BACKUP_STORES[number]['field'];

export const GAME_HALL_BACKUP_STORE_NAMES: readonly GameHallBackupStoreName[] =
  GAME_HALL_BACKUP_STORES.map(item => item.storeName);

export const GAME_HALL_BACKUP_FIELD_BY_STORE: Readonly<Record<GameHallBackupStoreName, GameHallBackupField>> =
  Object.freeze(Object.fromEntries(
    GAME_HALL_BACKUP_STORES.map(item => [item.storeName, item.field]),
  ) as Record<GameHallBackupStoreName, GameHallBackupField>);
