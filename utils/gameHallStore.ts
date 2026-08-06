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

export async function saveGameHallMessages(values: GameHallMessage[]): Promise<void> {
  if (!values.length) return;
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.messages, 'readwrite');
  const store = tx.objectStore(GAME_HALL_STORES.messages);
  values.forEach(value => store.put(value));
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


export const getOpenGameHallUserMessages = (
  messages: GameHallMessage[],
  openTurnId: string | undefined,
): GameHallMessage[] => {
  if (!openTurnId) return [];
  return messages
    .filter(message => message.role === 'user' && message.turnId === openTurnId && !message.replyRequestedAt)
    .sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
};

export async function sealGameHallTurnForReply(input: {
  sessionId: string;
  expectedOpenTurnId: string;
  userMessageIds: string[];
}): Promise<GameHallSession> {
  const ids = Array.from(new Set(input.userMessageIds.filter(Boolean)));
  if (!ids.length) throw new Error('当前没有等待角色回复的消息。');
  const db = await openDB();
  const tx = db.transaction([GAME_HALL_STORES.sessions, GAME_HALL_STORES.messages], 'readwrite');
  const sessionStore = tx.objectStore(GAME_HALL_STORES.sessions);
  const messageStore = tx.objectStore(GAME_HALL_STORES.messages);
  try {
    const session = await reqResult<GameHallSession | undefined>(sessionStore.get(input.sessionId));
    if (!session) throw new Error('游戏厅会话不存在。');
    if (session.openTurnId !== input.expectedOpenTurnId) throw new Error('本轮消息已经变化，请刷新后重试。');
    if (session.activeReplyTurn?.status === 'running') throw new Error('角色正在回复上一轮。');
    const allSessionMessages = await reqResult<GameHallMessage[]>(
      messageStore.index('sessionId').getAll(session.id),
    );
    const openMessages = getOpenGameHallUserMessages(allSessionMessages, input.expectedOpenTurnId);
    const actualIds = openMessages.map(message => message.id);
    if (actualIds.length !== ids.length || actualIds.some(id => !ids.includes(id))) {
      throw new Error('本轮消息已经变化，请刷新后重试。');
    }
    const messages = await Promise.all(ids.map(id => reqResult<GameHallMessage | undefined>(messageStore.get(id))));
    if (messages.some(message => !message
      || message.sessionId !== session.id
      || message.charId !== session.charId
      || message.role !== 'user'
      || message.turnId !== input.expectedOpenTurnId
      || !!message.replyRequestedAt)) {
      throw new Error('待回复消息与当前回合不一致。');
    }
    const now = Date.now();
    messages.forEach(message => messageStore.put({ ...message!, replyRequestedAt: now }));
    const next: GameHallSession = {
      ...session,
      activeReplyTurn: {
        turnId: input.expectedOpenTurnId, userMessageIds: ids, status: 'running', requestedAt: now, updatedAt: now,
      },
      openTurnId: gameHallId('ghturn'),
      updatedAt: now,
    };
    sessionStore.put(next);
    await txDone(tx);
    return next;
  } catch (error) {
    try { tx.abort(); } catch { /* already completed/aborted */ }
    throw error;
  }
}

export async function completeGameHallReplyTurn(sessionId: string, turnId: string): Promise<GameHallSession> {
  const session = await getGameHallSession(sessionId);
  if (!session || session.activeReplyTurn?.turnId !== turnId) throw new Error('找不到正在完成的游戏厅回合。');
  const next: GameHallSession = { ...session, activeReplyTurn: undefined, lastCompletedTurnId: turnId, updatedAt: Date.now() };
  await saveGameHallSession(next);
  return next;
}

export async function failGameHallReplyTurn(sessionId: string, turnId: string, error: string): Promise<GameHallSession> {
  const session = await getGameHallSession(sessionId);
  if (!session || session.activeReplyTurn?.turnId !== turnId) throw new Error('找不到失败的游戏厅回合。');
  const next: GameHallSession = {
    ...session,
    activeReplyTurn: { ...session.activeReplyTurn, status: 'failed', error, updatedAt: Date.now() },
    updatedAt: Date.now(),
  };
  await saveGameHallSession(next);
  return next;
}

export async function recoverInterruptedGameHallReplyTurn(session: GameHallSession): Promise<GameHallSession> {
  let next = session;
  if (!next.openTurnId) next = { ...next, openTurnId: gameHallId('ghturn'), updatedAt: Date.now() };
  if (next.activeReplyTurn?.status === 'running') {
    next = {
      ...next,
      activeReplyTurn: {
        ...next.activeReplyTurn, status: 'failed', error: '上次回复在完成前中断，可手动重试。', updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
  }
  if (next !== session) await saveGameHallSession(next);
  return next;
}
