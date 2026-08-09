import { describe, expect, it, vi } from 'vitest';
import {
  buildFcmMessage,
  createHybridPushTransport,
  fcmTokenFromEndpoint,
  pollTokenFromEndpoint,
} from './nativeFcm';

describe('AMSG2 native FCM transport', () => {
  it('普通 Web Push endpoint 原样委托旧发送器', async () => {
    const sendNotification = vi.fn().mockResolvedValue('web-ok');
    const transport = createHybridPushTransport({}, { sendNotification });
    const subscription = { endpoint: 'https://push.example/sub', keys: { p256dh: 'a', auth: 'b' } };
    await expect(transport.sendNotification(subscription, '{"message":"hi"}')).resolves.toBe('web-ok');
    expect(sendNotification).toHaveBeenCalledWith(subscription, '{"message":"hi"}');
  });

  it('只有 fcm: endpoint 才识别为原生 token', () => {
    expect(fcmTokenFromEndpoint('fcm:abc:123')).toBe('abc:123');
    expect(fcmTokenFromEndpoint('https://push.example/sub')).toBeNull();
    expect(fcmTokenFromEndpoint('fcm:   ')).toBeNull();
  });

  it('poll: endpoint 只接受足够长的随机设备令牌', () => {
    const token = 'a'.repeat(64);
    expect(pollTokenFromEndpoint(`poll:${token}`)).toBe(token);
    expect(pollTokenFromEndpoint('poll:too-short')).toBeNull();
    expect(pollTokenFromEndpoint('https://example.com')).toBeNull();
  });

  it('轮询 endpoint 写进 D1 信箱，不调用 Web Push', async () => {
    const batches: unknown[][] = [];
    const makeStatement = (sql: string) => {
      const statement: any = { sql, values: [] };
      statement.bind = (...values: unknown[]) => { statement.values = values; return statement; };
      statement.run = vi.fn().mockResolvedValue({});
      statement.all = vi.fn().mockResolvedValue({ results: [] });
      return statement;
    };
    const env: any = {
      DB: {
        prepare: vi.fn(makeStatement),
        batch: vi.fn(async (statements: unknown[]) => { batches.push(statements); return []; }),
      },
    };
    const web = { sendNotification: vi.fn() };
    const transport = createHybridPushTransport(env, web);
    await transport.sendNotification({ endpoint: `poll:${'b'.repeat(64)}` }, '{"message":"hi"}');
    expect(web.sendNotification).not.toHaveBeenCalled();
    expect(batches.flat().some((statement: any) => String(statement.sql).includes('INSERT INTO native_push_mailbox'))).toBe(true);
  });

  it('正文只放 notification 一份，data 保留 AMSG2 路由字段', () => {
    const request = buildFcmMessage('token', JSON.stringify({
      messageId: 'm1', message: '你好', contactName: 'Sully',
      metadata: { charId: 'char-1', activeMsg2: true },
    }));
    expect(request.message.notification).toEqual({ title: 'Sully', body: '你好' });
    expect(request.message.data.amsgHasBody).toBe('1');
    const portable = JSON.parse(request.message.data.amsgPayload);
    expect(portable.message).toBeUndefined();
    expect(portable.metadata.charId).toBe('char-1');
  });
});

