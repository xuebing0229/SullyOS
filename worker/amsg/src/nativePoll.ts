/** Android 无 Google 构建的后台轮询收件箱。设备令牌本身就是这条通道的 bearer。 */

export interface NativePollStatement {
  bind(...values: unknown[]): NativePollStatement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

export interface NativePollDb {
  prepare(sql: string): NativePollStatement;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_BATCH = 20;
const MAX_ACK_IDS = 50;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const nativePollTokenFromEndpoint = (endpoint: unknown): string | null => {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('poll:')) return null;
  const token = endpoint.slice(5).trim();
  return TOKEN_RE.test(token) ? token : null;
};

const ensureTable = async (db: NativePollDb) => {
  await db.prepare(`CREATE TABLE IF NOT EXISTS native_poll_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_token TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_native_poll_device ON native_poll_messages(device_token, id)',
  ).run();
};

export const enqueueNativePollMessage = async (
  db: NativePollDb | undefined,
  deviceToken: string,
  payload: string,
) => {
  if (!db) throw new Error('NATIVE_POLL_DB_MISSING: Worker 未绑定 D1');
  if (!TOKEN_RE.test(deviceToken)) throw new Error('NATIVE_POLL_TOKEN_INVALID');
  await ensureTable(db);
  const now = Date.now();
  await db.prepare(
    'INSERT INTO native_poll_messages (device_token, payload, created_at) VALUES (?, ?, ?)',
  ).bind(deviceToken, payload, now).run();
  await db.prepare('DELETE FROM native_poll_messages WHERE created_at < ?')
    .bind(now - RETENTION_MS).run();
  return { statusCode: 201 };
};

const readToken = (request: Request): string | null => {
  const token = request.headers.get('X-Device-Token')?.trim() || '';
  return TOKEN_RE.test(token) ? token : null;
};

export type NativePollResponse = {
  status: number;
  body: Record<string, unknown>;
};

export const handleNativePollRequest = async (
  request: Request,
  db: NativePollDb | undefined,
): Promise<NativePollResponse> => {
  if (!db) return { status: 503, body: { success: false, error: { code: 'DB_MISSING', message: 'Worker 未绑定 D1' } } };
  const token = readToken(request);
  if (!token) return { status: 401, body: { success: false, error: { code: 'INVALID_DEVICE_TOKEN', message: '设备令牌无效' } } };
  await ensureTable(db);

  if (request.method === 'GET') {
    const rows = await db.prepare(
      'SELECT id, payload FROM native_poll_messages WHERE device_token = ? ORDER BY id ASC LIMIT ?',
    ).bind(token, MAX_BATCH).all<{ id: number; payload: string }>();
    return { status: 200, body: { success: true, data: { messages: rows.results || [] } } };
  }

  if (request.method === 'POST') {
    const parsed = await request.json().catch(() => null) as { ids?: unknown } | null;
    const ids = Array.isArray(parsed?.ids)
      ? parsed.ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0).slice(0, MAX_ACK_IDS)
      : [];
    for (const id of ids) {
      await db.prepare('DELETE FROM native_poll_messages WHERE device_token = ? AND id = ?')
        .bind(token, id).run();
    }
    return { status: 200, body: { success: true, data: { acknowledged: ids.length } } };
  }

  return { status: 405, body: { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' } } };
};
