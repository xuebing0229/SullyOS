import { openDB } from './db';
import type {
  GameHallBridgeSnapshot,
  GameHallMessage,
  GameHallPendingAction,
  GameHallSession,
} from './gameHallTypes';
import type {
  GameHallEvent,
  GameHallMemoryCandidate,
  GameHallPreferenceEvidence,
} from './gameHallMemoryTypes';

export const GAME_HALL_STORES = {
  sessions: 'gameHallSessions',
  messages: 'gameHallMessages',
  pending: 'gameHallPendingActions',
  snapshots: 'gameHallBridgeSnapshots',
  protocol: 'gameHallProtocolCache',
  events: 'gameHallEvents',
  candidates: 'gameHallMemoryCandidates',
  preferences: 'gameHallPreferenceEvidence',
} as const;

const txDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error('IndexedDB transaction aborted'));
  });

const reqResult = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export const gameHallId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export async function saveGameHallSession(
  value: GameHallSession,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.sessions, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.sessions).put(value);
  await txDone(tx);
}

export async function getGameHallSession(
  id: string,
): Promise<GameHallSession | undefined> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.sessions, 'readonly');
  return reqResult(tx.objectStore(GAME_HALL_STORES.sessions).get(id));
}

/**
 * 优先返回当前 active 会话。
 * 兼容旧版“按返回键就把会话写成 ended”的数据：没有 active 时恢复最近一次会话，
 * 让用户升级后能重新看到此前已经落库、但被 UI 隐藏的游戏厅聊天。
 */
export async function getActiveGameHallSession(
  charId: string,
): Promise<GameHallSession | undefined> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.sessions, 'readonly');
  const all = await reqResult<GameHallSession[]>(
    tx.objectStore(GAME_HALL_STORES.sessions).index('charId').getAll(charId),
  );
  const latest = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  return latest.find(session => session.status === 'active') || latest[0];
}

export async function saveGameHallMessage(
  value: GameHallMessage,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.messages, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.messages).put(value);
  await txDone(tx);
}

export async function getGameHallMessages(
  sessionId: string,
): Promise<GameHallMessage[]> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.messages, 'readonly');
  const all = await reqResult<GameHallMessage[]>(
    tx.objectStore(GAME_HALL_STORES.messages).index('sessionId').getAll(sessionId),
  );
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function savePendingGameHallAction(
  value: GameHallPendingAction,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.pending, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.pending).put(value);
  await txDone(tx);
}

export async function getPendingGameHallActions(
  sessionId: string,
): Promise<GameHallPendingAction[]> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.pending, 'readonly');
  const all = await reqResult<GameHallPendingAction[]>(
    tx.objectStore(GAME_HALL_STORES.pending).index('sessionId').getAll(sessionId),
  );
  return all
    .filter(action => action.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveGameHallBridgeSnapshot(
  value: GameHallBridgeSnapshot,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.snapshots, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.snapshots).put(value);
  await txDone(tx);
}

export async function getLatestGameHallBridgeSnapshot(
  charId: string,
): Promise<GameHallBridgeSnapshot | undefined> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.snapshots, 'readonly');
  const all = await reqResult<GameHallBridgeSnapshot[]>(
    tx.objectStore(GAME_HALL_STORES.snapshots).index('charId').getAll(charId),
  );
  const now = Date.now();
  return all
    .filter(snapshot => !snapshot.expiresAt || snapshot.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export async function saveGameHallEvent(
  value: GameHallEvent,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.events, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.events).put(value);
  await txDone(tx);
}

export async function getGameHallEvents(
  sessionId: string,
): Promise<GameHallEvent[]> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.events, 'readonly');
  const all = await reqResult<GameHallEvent[]>(
    tx.objectStore(GAME_HALL_STORES.events).index('sessionId').getAll(sessionId),
  );
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveGameHallMemoryCandidate(
  value: GameHallMemoryCandidate,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.candidates, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.candidates).put(value);
  await txDone(tx);
}

export async function getPendingGameHallMemoryCandidates(
  charId: string,
): Promise<GameHallMemoryCandidate[]> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.candidates, 'readonly');
  const all = await reqResult<GameHallMemoryCandidate[]>(
    tx.objectStore(GAME_HALL_STORES.candidates).index('charId').getAll(charId),
  );
  return all
    .filter(candidate => candidate.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveGameHallPreferenceEvidence(
  value: GameHallPreferenceEvidence,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(GAME_HALL_STORES.preferences, 'readwrite');
  tx.objectStore(GAME_HALL_STORES.preferences).put(value);
  await txDone(tx);
}
