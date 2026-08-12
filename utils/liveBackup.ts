export const LIVE_BACKUP_STORES = [
  { storeName: 'live_settings', field: 'liveSettings', label: '直播设置' },
  { storeName: 'live_rooms', field: 'liveRooms', label: '直播间与贡献榜' },
  { storeName: 'live_events', field: 'liveEvents', label: '直播时间线' },
  { storeName: 'live_sessions', field: 'liveSessions', label: '我开直播历史' },
] as const;

export type LiveBackupStoreName = typeof LIVE_BACKUP_STORES[number]['storeName'];
export type LiveBackupField = typeof LIVE_BACKUP_STORES[number]['field'];

export const LIVE_BACKUP_FIELD_BY_STORE: Readonly<Record<LiveBackupStoreName, LiveBackupField>> =
  Object.freeze(Object.fromEntries(
    LIVE_BACKUP_STORES.map(item => [item.storeName, item.field]),
  ) as Record<LiveBackupStoreName, LiveBackupField>);

/** 备份恢复只恢复持久状态，不会在导入后自动继续计时。 */
export const prepareLiveRowsForRestore = (storeName: LiveBackupStoreName, rows: any[]): any[] => {
  if (storeName === 'live_rooms') {
    return rows.map(row => row?.status === 'live' ? { ...row, status: 'paused' } : row);
  }
  if (storeName === 'live_sessions') {
    return rows.map(row => row?.status === 'active' ? { ...row, status: 'paused' } : row);
  }
  return rows;
};
