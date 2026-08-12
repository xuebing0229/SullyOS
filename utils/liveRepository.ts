import { openDB } from './db';
import type { LiveEvent, LiveRoom, LiveSession, LiveSettings } from './liveTypes';
import { defaultLiveSettings } from './liveTypes';

const txDone = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('直播数据写入失败'));
  tx.onabort = () => reject(tx.error || new Error('直播数据写入已中止'));
});

const requestResult = <T,>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('直播数据读取失败'));
});

export const LiveRepository = {
  async getSettings(): Promise<LiveSettings> {
    const db = await openDB();
    const saved = await requestResult(db.transaction('live_settings', 'readonly').objectStore('live_settings').get('main')) as LiveSettings | undefined;
    return saved ? { ...defaultLiveSettings(), ...saved, id: 'main' } : defaultLiveSettings();
  },
  async saveSettings(settings: LiveSettings): Promise<void> {
    const db = await openDB();
    const tx = db.transaction('live_settings', 'readwrite');
    tx.objectStore('live_settings').put({ ...settings, id: 'main', updatedAt: Date.now() });
    await txDone(tx);
  },
  async getRooms(kind?: LiveRoom['kind']): Promise<LiveRoom[]> {
    const db = await openDB();
    const store = db.transaction('live_rooms', 'readonly').objectStore('live_rooms');
    const rows = kind
      ? await requestResult(store.index('kind').getAll(kind)) as LiveRoom[]
      : await requestResult(store.getAll()) as LiveRoom[];
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async saveRoom(room: LiveRoom): Promise<void> {
    const db = await openDB();
    const tx = db.transaction('live_rooms', 'readwrite');
    tx.objectStore('live_rooms').put({ ...room, updatedAt: Date.now() });
    await txDone(tx);
  },
  async saveRooms(rooms: LiveRoom[]): Promise<void> {
    if (!rooms.length) return;
    const db = await openDB();
    const tx = db.transaction('live_rooms', 'readwrite');
    const store = tx.objectStore('live_rooms');
    rooms.forEach(room => store.put({ ...room, updatedAt: Date.now() }));
    await txDone(tx);
  },
  async getEvents(roomId: string): Promise<LiveEvent[]> {
    const db = await openDB();
    const store = db.transaction('live_events', 'readonly').objectStore('live_events');
    const rows = await requestResult(store.index('roomId').getAll(roomId)) as LiveEvent[];
    return rows.sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
  },
  async replaceEvents(roomId: string, events: LiveEvent[]): Promise<void> {
    const db = await openDB();
    const tx = db.transaction('live_events', 'readwrite');
    const store = tx.objectStore('live_events');
    await new Promise<void>((resolve, reject) => {
      const cursor = store.index('roomId').openKeyCursor(IDBKeyRange.only(roomId));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) { resolve(); return; }
        store.delete(current.primaryKey);
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    events.forEach(event => store.put(event));
    await txDone(tx);
  },
  async saveSession(session: LiveSession): Promise<void> {
    const db = await openDB();
    const tx = db.transaction('live_sessions', 'readwrite');
    tx.objectStore('live_sessions').put({ ...session, updatedAt: Date.now() });
    await txDone(tx);
  },
  async getSessions(): Promise<LiveSession[]> {
    const db = await openDB();
    const rows = await requestResult(db.transaction('live_sessions', 'readonly').objectStore('live_sessions').getAll()) as LiveSession[];
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
};
