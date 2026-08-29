import { describe, expect, it } from 'vitest';
import {
  enqueueNativePollMessage,
  handleNativePollRequest,
  nativePollTokenFromEndpoint,
  type NativePollDb,
} from './nativePoll';

const TOKEN = 'a'.repeat(64);

class MemoryPollDb implements NativePollDb {
  rows: Array<{ id: number; device_token: string; payload: string; created_at: number }> = [];
  nextId = 1;

  prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind: (...next: unknown[]) => { values = next; return this.prepareBound(sql, () => values); },
      run: async () => undefined,
      first: async <T>() => null as T | null,
      all: async <T>() => ({ results: [] as T[] }),
    };
  }

  private prepareBound(sql: string, values: () => unknown[]) {
    return {
      bind: (...next: unknown[]) => this.prepareBound(sql, () => next),
      run: async () => {
        const args = values();
        if (sql.startsWith('INSERT INTO native_poll_messages')) {
          this.rows.push({ id: this.nextId++, device_token: String(args[0]), payload: String(args[1]), created_at: Number(args[2]) });
        } else if (sql.includes('device_token = ? AND id = ?')) {
          this.rows = this.rows.filter((row) => row.device_token !== args[0] || row.id !== args[1]);
        } else if (sql.includes('created_at < ?')) {
          this.rows = this.rows.filter((row) => row.created_at >= Number(args[0]));
        }
      },
      first: async <T>() => null as T | null,
      all: async <T>() => ({
        results: this.rows
          .filter((row) => row.device_token === values()[0])
          .slice(0, Number(values()[1]))
          .map(({ id, payload }) => ({ id, payload })) as T[],
      }),
    };
  }
}

describe('AMSG2 Android native poll inbox', () => {
  it('只识别合法的 poll: 设备端点', () => {
    expect(nativePollTokenFromEndpoint(`poll:${TOKEN}`)).toBe(TOKEN);
    expect(nativePollTokenFromEndpoint('poll:short')).toBeNull();
    expect(nativePollTokenFromEndpoint(`fcm:${TOKEN}`)).toBeNull();
  });

  it('消息入队后能由对应设备领取并确认删除', async () => {
    const db = new MemoryPollDb();
    await enqueueNativePollMessage(db, TOKEN, '{"message":"你好"}');

    const headers = { 'X-Device-Token': TOKEN };
    const pulled = await handleNativePollRequest(new Request('https://w/native-poll', { headers }), db);
    expect(pulled.status).toBe(200);
    expect((pulled.body.data as any).messages).toEqual([{ id: 1, payload: '{"message":"你好"}' }]);

    const acked = await handleNativePollRequest(new Request('https://w/native-poll/ack', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"ids":[1]}',
    }), db);
    expect(acked.status).toBe(200);
    expect(db.rows).toHaveLength(0);
  });

  it('没有设备令牌时不泄露队列', async () => {
    const response = await handleNativePollRequest(new Request('https://w/native-poll'), new MemoryPollDb());
    expect(response.status).toBe(401);
  });
});
