import { openDB } from './db';
import type { GameHallMessage, GameHallPendingAction, GameHallSession } from './gameHallTypes';

export const GAME_HALL_STORES = {
  sessions: 'gameHallSessions',
  messages: 'gameHallMessages',
  pending: 'gameHallPendingActions',
  protocol: 'gameHallProtocolCache',
} as const;

const txDone = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
});
const reqResult = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const gameHallId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export async function saveGameHallSession(value: GameHallSession): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.sessions, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.sessions).put(value);
  await txDone(tx);
}

export async function getGameHallSession(id: string): Promise<GameHallSession | undefined> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.sessions, 'readonly');
  return reqResult(tx.objectStore(GAME_HALL_STORES.sessions).get(id));
}

export async function getActiveGameHallSession(charId: string): Promise<GameHallSession | undefined> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.sessions, 'readonly');
  const all = await reqResult<GameHallSession[]>(
    tx.objectStore(GAME_HALL_STORES.sessions).index('charId').getAll(charId),
  );
  const latest = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  return latest.find(session => session.status === 'active') || latest[0];
}

export async function saveGameHallMessage(value: GameHallMessage): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.messages, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.messages).put(value);
  await txDone(tx);
}

export async function getGameHallMessages(sessionId: string): Promise<GameHallMessage[]> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.messages, 'readonly');
  const all = await reqResult<GameHallMessage[]>(
    tx.objectStore(GAME_HALL_STORES.messages).index('sessionId').getAll(sessionId),
  );
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

/** 只有“主聊天摘要与图片全部落库成功”后才允许调用。 */
export async function deleteGameHallMessages(ids: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (!uniqueIds.length) return;
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.messages, 'readwrite');
  const store = tx.objectStore(GAME_HALL_STORES.messages);
  uniqueIds.forEach(id => store.delete(id));
  await txDone(tx);
}

/**
 * 交接最终提交：会话确认与精确删除原文必须原子完成。
 * 任一写入失败时 IndexedDB 会回滚整个事务，避免原文已删但交接游标未更新。
 */
export async function commitGameHallHandoff(
  session: GameHallSession,
  sourceMessageIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(new Set(sourceMessageIds.filter(Boolean)));
  if (!uniqueIds.length) throw new Error('游戏厅交接缺少原文 ID。');
  const db = await openDB();
  const tx = db.transaction(
    [GAME_HALL_STORES.sessions, GAME_HALL_STORES.messages],
    'readwrite',
  );
  tx.objectStore(GAME_HALL_STORES.sessions).put(session);
  const messageStore = tx.objectStore(GAME_HALL_STORES.messages);
  uniqueIds.forEach(id => messageStore.delete(id));
  await txDone(tx);
}

export async function savePendingGameHallAction(value: GameHallPendingAction): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.pending, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.pending).put(value);
  await txDone(tx);
}

/** 失败行动也保留在面板中，用户可以原样重试或取消。 */
export async function getPendingGameHallActions(sessionId: string): Promise<GameHallPendingAction[]> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.pending, 'readonly');
  const all = await reqResult<GameHallPendingAction[]>(
    tx.objectStore(GAME_HALL_STORES.pending).index('sessionId').getAll(sessionId),
  );
  return all
    .filter(action => action.status === 'pending' || action.status === 'failed' || action.status === 'confirmed')
    .sort((a, b) => a.createdAt - b.createdAt);
}
