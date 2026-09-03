import { DurableObject } from 'cloudflare:workers';
import { constantTimeEqual } from './instantChat';

type D1Prepared = {
  bind(...values: unknown[]): D1Prepared;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};

export interface StoryJobsDb {
  prepare(sql: string): D1Prepared;
}

export interface StoryTickNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): {
    kick(userId: string, jobId: string): Promise<unknown>;
  };
}

export interface StoryJobsEnv {
  AMSG_MASTER_KEY: string;
  AMSG_SERVER_TOKEN?: string;
  DB: StoryJobsDb;
  STORY_TICK?: StoryTickNamespace;
}

export interface StoryJobRoute {
  presetId?: string;
  presetName?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  firstByteTimeoutMs?: number;
}

export interface StoryJobSpec {
  jobId: string;
  clientRequestId: string;
  ownerKey: string;
  title: string;
  mode: 'direct' | 'failover';
  routes: StoryJobRoute[];
  baseBody: Record<string, unknown>;
}

type StoryJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface StoryJobRow {
  job_id: string;
  user_id: string;
  client_request_id: string;
  owner_key: string;
  title: string;
  status: StoryJobStatus;
  request_cipher: string;
  partial_cipher: string | null;
  response_cipher: string | null;
  error: string | null;
  attempts_json: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_chars: number | null;
  visible_chars: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface StoryAttempt {
  routeIndex: number;
  presetId?: string;
  presetName?: string;
  baseUrl: string;
  model: string;
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID_RE = /^[A-Za-z0-9_-]{12,160}$/;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROUTES = 8;
const MAX_REQUEST_BYTES = 2_000_000;
const PARTIAL_PERSIST_INTERVAL_MS = 900;
const PARTIAL_PERSIST_CHAR_STEP = 512;
const STORY_ALARM_KEY = 'storyJob';

const jsonSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const now = (): number => Date.now();
const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const deriveStorageKey = async (masterKey: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(masterKey));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const sealJson = async (
  env: StoryJobsEnv,
  userId: string,
  jobId: string,
  kind: string,
  value: unknown,
): Promise<string> => {
  const key = await deriveStorageKey(env.AMSG_MASTER_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${userId}:${jobId}:${kind}`);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(cipher) });
};

const openJson = async <T>(
  env: StoryJobsEnv,
  userId: string,
  jobId: string,
  kind: string,
  envelope: string,
): Promise<T> => {
  const parsed = JSON.parse(envelope) as { iv?: string; data?: string };
  if (!parsed?.iv || !parsed?.data) throw new Error('剧情后台任务密文损坏');
  const key = await deriveStorageKey(env.AMSG_MASTER_KEY);
  const aad = new TextEncoder().encode(`${userId}:${jobId}:${kind}`);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(parsed.iv), additionalData: aad },
    key,
    fromBase64(parsed.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
};

export const ensureStoryJobsSchema = async (db: StoryJobsDb): Promise<void> => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS story_jobs (
      job_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      request_cipher TEXT NOT NULL,
      partial_cipher TEXT,
      response_cipher TEXT,
      error TEXT,
      attempts_json TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      reasoning_chars INTEGER,
      visible_chars INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    )
  `).run();
  await db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_story_jobs_user_client
    ON story_jobs(user_id, client_request_id)
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_story_jobs_updated
    ON story_jobs(updated_at)
  `).run();
};

const cleanupOldJobs = async (db: StoryJobsDb): Promise<void> => {
  const cutoff = now() - TERMINAL_RETENTION_MS;
  await db.prepare(
    "DELETE FROM story_jobs WHERE status IN ('succeeded','failed','cancelled') AND updated_at < ?",
  ).bind(cutoff).run();
};

const loadRowById = async (db: StoryJobsDb, userId: string, jobId: string): Promise<StoryJobRow | null> =>
  db.prepare('SELECT * FROM story_jobs WHERE user_id = ? AND job_id = ? LIMIT 1')
    .bind(userId, jobId)
    .first<StoryJobRow>();

const loadRowByClient = async (
  db: StoryJobsDb,
  userId: string,
  clientRequestId: string,
): Promise<StoryJobRow | null> =>
  db.prepare('SELECT * FROM story_jobs WHERE user_id = ? AND client_request_id = ? LIMIT 1')
    .bind(userId, clientRequestId)
    .first<StoryJobRow>();

const parseAttempts = (raw: string | null): StoryAttempt[] => {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const publicJob = async (env: StoryJobsEnv, row: StoryJobRow): Promise<Record<string, unknown>> => {
  let partialContent = '';
  let response: unknown = undefined;
  try {
    if (row.partial_cipher) {
      partialContent = await openJson<string>(env, row.user_id, row.job_id, 'partial', row.partial_cipher);
    }
  } catch {
    partialContent = '';
  }
  try {
    if (row.response_cipher) {
      response = await openJson<unknown>(env, row.user_id, row.job_id, 'response', row.response_cipher);
    }
  } catch {
    response = undefined;
  }
  return {
    jobId: row.job_id,
    clientRequestId: row.client_request_id,
    ownerKey: row.owner_key,
    title: row.title,
    status: row.status,
    partialContent,
    ...(response !== undefined ? { response } : {}),
    ...(row.error ? { error: row.error } : {}),
    attempts: parseAttempts(row.attempts_json),
    ...(row.prompt_tokens != null ? { promptTokens: row.prompt_tokens } : {}),
    ...(row.completion_tokens != null ? { completionTokens: row.completion_tokens } : {}),
    reasoningChars: row.reasoning_chars ?? 0,
    visibleChars: row.visible_chars ?? partialContent.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at != null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at != null ? { completedAt: row.completed_at } : {}),
  };
};

const validateSpec = (value: unknown): StoryJobSpec => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('剧情后台任务参数无效');
  const raw = value as Record<string, unknown>;
  const jobId = String(raw.jobId || '').trim();
  const clientRequestId = String(raw.clientRequestId || '').trim();
  const ownerKey = String(raw.ownerKey || '').trim();
  const title = String(raw.title || '剧情').trim() || '剧情';
  const mode = raw.mode === 'failover' ? 'failover' : 'direct';
  const routesRaw = Array.isArray(raw.routes) ? raw.routes : [];
  if (!JOB_ID_RE.test(jobId)) throw new Error('剧情后台 jobId 无效');
  if (!JOB_ID_RE.test(clientRequestId)) throw new Error('剧情后台 clientRequestId 无效');
  if (!ownerKey || ownerKey.length > 240) throw new Error('剧情后台 ownerKey 无效');
  if (routesRaw.length < 1 || routesRaw.length > MAX_ROUTES) throw new Error('剧情后台线路数量无效');
  if (!raw.baseBody || typeof raw.baseBody !== 'object' || Array.isArray(raw.baseBody)) {
    throw new Error('剧情后台请求体无效');
  }
  const routes: StoryJobRoute[] = routesRaw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`剧情后台线路 ${index + 1} 无效`);
    const route = item as Record<string, unknown>;
    const baseUrl = normalizeBaseUrl(String(route.baseUrl || ''));
    const model = String(route.model || '').trim();
    const apiKey = String(route.apiKey || '');
    if (!/^https?:\/\//i.test(baseUrl) || !model) throw new Error(`剧情后台线路 ${index + 1} 配置不完整`);
    return {
      presetId: typeof route.presetId === 'string' ? route.presetId : undefined,
      presetName: typeof route.presetName === 'string' ? route.presetName : undefined,
      baseUrl,
      apiKey,
      model,
      firstByteTimeoutMs: Number.isFinite(Number(route.firstByteTimeoutMs))
        ? Math.max(0, Number(route.firstByteTimeoutMs))
        : undefined,
    };
  });
  const spec: StoryJobSpec = {
    jobId,
    clientRequestId,
    ownerKey,
    title: title.slice(0, 200),
    mode,
    routes,
    baseBody: raw.baseBody as Record<string, unknown>,
  };
  if (jsonSize(spec) > MAX_REQUEST_BYTES) throw new Error('剧情后台请求体过大');
  return spec;
};

const authenticate = async (
  request: Request,
  env: StoryJobsEnv,
): Promise<{ ok: true; userId: string } | { ok: false; status: number; code: string; message: string }> => {
  const expected = (env.AMSG_SERVER_TOKEN || '').trim();
  const actual = request.headers.get('X-Client-Token') || '';
  if (expected && (!actual || !(await constantTimeEqual(actual, expected)))) {
    return { ok: false, status: 401, code: 'INVALID_CLIENT_TOKEN', message: '共享密钥无效或缺失' };
  }
  const userId = request.headers.get('X-User-Id') || '';
  if (!UUID_V4_RE.test(userId)) {
    return { ok: false, status: 400, code: 'INVALID_USER_ID', message: 'X-User-Id 无效' };
  }
  return { ok: true, userId };
};

export type StoryTickKickResult =
  | { ok: true }
  | { ok: false; reason: 'missing-binding' }
  | { ok: false; reason: 'kick-failed'; error: unknown };

export const kickStoryTick = async (
  env: StoryJobsEnv,
  userId: string,
  jobId: string,
): Promise<StoryTickKickResult> => {
  const ns = env.STORY_TICK;
  if (!ns || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function') {
    return { ok: false, reason: 'missing-binding' };
  }
  try {
    await ns.get(ns.idFromName(`${userId}:${jobId}`)).kick(userId, jobId);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'kick-failed', error };
  }
};

const routeAttempt = (route: StoryJobRoute, index: number, startedAt: number): StoryAttempt => ({
  routeIndex: index,
  presetId: route.presetId,
  presetName: route.presetName,
  baseUrl: route.baseUrl,
  model: route.model,
  ok: false,
  durationMs: now() - startedAt,
});

interface StreamState {
  content: string;
  reasoning: string;
  role: string;
  finishReason: string | null;
  usage: Record<string, unknown> | undefined;
  firstChunk: Record<string, unknown> | null;
  activity: boolean;
  terminal: boolean;
}

const appendChunk = (state: StreamState, chunk: any): { contentDelta: string; reasoningDelta: string } => {
  if (!state.firstChunk && chunk && typeof chunk === 'object') state.firstChunk = chunk;
  if (chunk?.usage && typeof chunk.usage === 'object') state.usage = chunk.usage;
  if (chunk?.usageMetadata && typeof chunk.usageMetadata === 'object') {
    const u = chunk.usageMetadata;
    const prompt = Number(u.promptTokenCount);
    const completion = Number(u.candidatesTokenCount);
    const total = Number(u.totalTokenCount);
    const reasoning = Number(u.thoughtsTokenCount);
    state.usage = {
      ...(Number.isFinite(prompt) ? { prompt_tokens: prompt } : {}),
      ...(Number.isFinite(completion) ? { completion_tokens: completion } : {}),
      ...(Number.isFinite(total) ? { total_tokens: total } : {}),
      ...(Number.isFinite(reasoning) ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
      usage_metadata: u,
    };
  }

  let contentDelta = '';
  let reasoningDelta = '';
  const choice = chunk?.choices?.[0];

  if (!choice) {
    if (Array.isArray(chunk?.choices) && chunk.choices.length === 0 && chunk?.usage && state.activity) {
      state.terminal = true;
      return { contentDelta, reasoningDelta };
    }
    const candidate = chunk?.candidates?.[0];
    if (!candidate) return { contentDelta, reasoningDelta };
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part?.text !== 'string' || !part.text) continue;
      if (part.thought === true) {
        state.reasoning += part.text;
        reasoningDelta += part.text;
      } else {
        state.content += part.text;
        contentDelta += part.text;
      }
      state.activity = true;
    }
    if (candidate?.content?.role) state.role = candidate.content.role === 'model' ? 'assistant' : String(candidate.content.role);
    const finish = String(candidate?.finishReason || '').trim();
    if (finish) {
      state.finishReason = finish.toUpperCase() === 'STOP'
        ? 'stop'
        : finish.toUpperCase() === 'MAX_TOKENS'
          ? 'length'
          : finish.toLowerCase();
      state.terminal = true;
    }
    return { contentDelta, reasoningDelta };
  }

  const source = choice.delta || choice.message || {};
  if (typeof source.content === 'string') {
    state.content += source.content;
    contentDelta += source.content;
    if (source.content) state.activity = true;
  } else if (Array.isArray(source.content)) {
    for (const block of source.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        state.content += block.text;
        contentDelta += block.text;
        if (block.text) state.activity = true;
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        state.reasoning += block.thinking;
        reasoningDelta += block.thinking;
        if (block.thinking) state.activity = true;
      }
    }
  }
  const reasoning = source.reasoning_content ?? source.reasoning ?? source.thinking;
  if (typeof reasoning === 'string' && reasoning) {
    state.reasoning += reasoning;
    reasoningDelta += reasoning;
    state.activity = true;
  }
  if (source.role) state.role = String(source.role);
  const finish = String(choice.finish_reason ?? choice.finishReason ?? '').trim();
  if (finish) {
    state.finishReason = finish;
    state.terminal = true;
  }
  return { contentDelta, reasoningDelta };
};

const completionFromState = (state: StreamState, model: string): Record<string, unknown> => ({
  id: (state.firstChunk as any)?.id || 'story-cloud-job',
  object: 'chat.completion',
  created: Number((state.firstChunk as any)?.created) || Math.floor(now() / 1000),
  model: (state.firstChunk as any)?.model || model,
  choices: [{
    index: 0,
    message: {
      role: state.role || 'assistant',
      content: state.content,
      ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
    },
    finish_reason: state.finishReason,
  }],
  ...(state.usage ? { usage: state.usage } : {}),
});

const normalizeJsonCompletion = (value: any, model: string): { response: Record<string, unknown>; content: string; reasoning: string; terminal: boolean } => {
  if (Array.isArray(value) || Array.isArray(value?.candidates)) {
    const state: StreamState = {
      content: '',
      reasoning: '',
      role: 'assistant',
      finishReason: null,
      usage: undefined,
      firstChunk: null,
      activity: false,
      terminal: false,
    };
    for (const chunk of (Array.isArray(value) ? value : [value])) appendChunk(state, chunk);
    return {
      response: completionFromState(state, model),
      content: state.content,
      reasoning: state.reasoning,
      terminal: state.terminal || Boolean(state.content),
    };
  }
  const content = typeof value?.choices?.[0]?.message?.content === 'string'
    ? value.choices[0].message.content
    : '';
  const reasoning = String(
    value?.choices?.[0]?.message?.reasoning_content
    ?? value?.choices?.[0]?.message?.reasoning
    ?? '',
  );
  const finish = value?.choices?.[0]?.finish_reason ?? value?.choices?.[0]?.finishReason;
  return {
    response: value,
    content,
    reasoning,
    terminal: Boolean(finish) || Boolean(content),
  };
};

const persistProgress = async (
  env: StoryJobsEnv,
  row: StoryJobRow,
  content: string,
  reasoningChars: number,
): Promise<void> => {
  const cipher = await sealJson(env, row.user_id, row.job_id, 'partial', content);
  await env.DB.prepare(
    'UPDATE story_jobs SET partial_cipher = ?, reasoning_chars = ?, visible_chars = ?, updated_at = ? WHERE user_id = ? AND job_id = ? AND status = ?',
  ).bind(cipher, reasoningChars, content.length, now(), row.user_id, row.job_id, 'running').run();
};

const readStreamingResponse = async (
  env: StoryJobsEnv,
  row: StoryJobRow,
  response: Response,
  model: string,
): Promise<{ response: Record<string, unknown>; content: string; reasoning: string; terminal: boolean }> => {
  if (!response.body?.getReader) {
    const raw = await response.text();
    return normalizeJsonCompletion(JSON.parse(raw), model);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = {
    content: '',
    reasoning: '',
    role: 'assistant',
    finishReason: null,
    usage: undefined,
    firstChunk: null,
    activity: false,
    terminal: false,
  };
  let pending = '';
  let raw = '';
  let sawSse = false;
  let lastPersistAt = 0;
  let lastPersistChars = 0;

  const maybePersist = async (force = false) => {
    const t = now();
    const enoughTime = t - lastPersistAt >= PARTIAL_PERSIST_INTERVAL_MS;
    const enoughChars = state.content.length - lastPersistChars >= PARTIAL_PERSIST_CHAR_STEP;
    if (!force && !enoughTime && !enoughChars) return;
    if (!state.content && !state.reasoning) return;
    await persistProgress(env, row, state.content, state.reasoning.length);
    lastPersistAt = t;
    lastPersistChars = state.content.length;
  };

  const consumeLine = async (line: string) => {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith('data:')) return;
    sawSse = true;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      state.terminal = true;
      return;
    }
    let chunk: unknown;
    try { chunk = JSON.parse(payload); } catch { return; }
    appendChunk(state, chunk);
    await maybePersist();
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    pending += text;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      await consumeLine(line);
      if (state.terminal) break;
      nl = pending.indexOf('\n');
    }
    if (state.terminal) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  const tail = decoder.decode();
  if (tail) {
    raw += tail;
    pending += tail;
  }
  if (pending.trim()) await consumeLine(pending.trim());
  await maybePersist(true);

  if (!sawSse) {
    return normalizeJsonCompletion(JSON.parse(raw), model);
  }
  return {
    response: completionFromState(state, model),
    content: state.content,
    reasoning: state.reasoning,
    terminal: state.terminal,
  };
};

const finalizeFailed = async (
  env: StoryJobsEnv,
  row: StoryJobRow,
  attempts: StoryAttempt[],
  error: string,
  content = '',
  reasoningChars = 0,
): Promise<void> => {
  const partialCipher = content
    ? await sealJson(env, row.user_id, row.job_id, 'partial', content)
    : row.partial_cipher;
  await env.DB.prepare(
    `UPDATE story_jobs
     SET status = 'failed', partial_cipher = ?, error = ?, attempts_json = ?, reasoning_chars = ?, visible_chars = ?, updated_at = ?, completed_at = ?
     WHERE user_id = ? AND job_id = ?`,
  ).bind(
    partialCipher,
    error.slice(0, 2000),
    JSON.stringify(attempts),
    reasoningChars,
    content.length,
    now(),
    now(),
    row.user_id,
    row.job_id,
  ).run();
};

export const runStoryJob = async (
  env: StoryJobsEnv,
  userId: string,
  jobId: string,
): Promise<void> => {
  await ensureStoryJobsSchema(env.DB);
  const row = await loadRowById(env.DB, userId, jobId);
  if (!row || row.status !== 'queued') return;

  const startedAt = now();
  const claimed = await env.DB.prepare(
    "UPDATE story_jobs SET status = 'running', started_at = ?, updated_at = ? WHERE user_id = ? AND job_id = ? AND status = 'queued'",
  ).bind(startedAt, startedAt, userId, jobId).run();
  if ((claimed.meta?.changes ?? 0) <= 0) return;

  const liveRow = { ...row, status: 'running' as StoryJobStatus, started_at: startedAt, updated_at: startedAt };
  let spec: StoryJobSpec;
  try {
    spec = await openJson<StoryJobSpec>(env, userId, jobId, 'request', row.request_cipher);
  } catch (error) {
    await finalizeFailed(env, liveRow, [], `剧情后台任务解密失败：${(error as Error)?.message || error}`);
    return;
  }

  const attempts: StoryAttempt[] = [];
  let lastError = '剧情后台生成失败';

  for (let index = 0; index < spec.routes.length; index += 1) {
    const route = spec.routes[index];
    const attemptStartedAt = now();
    let response: Response;
    try {
      response = await fetch(`${normalizeBaseUrl(route.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${route.apiKey || 'sk-none'}`,
          'User-Agent': 'SullyOS-StoryWorker/1.0',
        },
        body: JSON.stringify({
          ...spec.baseBody,
          model: route.model,
          stream: true,
        }),
      });
    } catch (error) {
      const attempt = routeAttempt(route, index, attemptStartedAt);
      attempt.error = (error as Error)?.message || String(error);
      attempt.durationMs = now() - attemptStartedAt;
      attempts.push(attempt);
      // 请求是否已经抵达上游不可判定；为了避免重复扣费，网络异常绝不自动切下一条。
      await finalizeFailed(env, liveRow, attempts, `剧情云端请求失败：${attempt.error}`);
      return;
    }

    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 1000);
      const attempt = routeAttempt(route, index, attemptStartedAt);
      attempt.status = response.status;
      attempt.error = text || `HTTP ${response.status}`;
      attempt.durationMs = now() - attemptStartedAt;
      attempts.push(attempt);
      lastError = `剧情上游返回 HTTP ${response.status}${text ? `：${text}` : ''}`;
      if (spec.mode === 'failover' && index < spec.routes.length - 1) continue;
      await finalizeFailed(env, liveRow, attempts, lastError);
      return;
    }

    try {
      const streamed = await readStreamingResponse(env, liveRow, response, route.model);
      const attempt = routeAttempt(route, index, attemptStartedAt);
      attempt.status = response.status;
      attempt.durationMs = now() - attemptStartedAt;

      if (!streamed.content.trim()) {
        attempt.error = streamed.reasoning
          ? '上游只返回了思考内容，没有正文'
          : '上游没有返回正文';
        attempts.push(attempt);
        // HTTP 200 已经进入模型执行，空正文也可能已计费；不自动切线路。
        await finalizeFailed(env, liveRow, attempts, attempt.error, streamed.content, streamed.reasoning.length);
        return;
      }

      if (!streamed.terminal) {
        attempt.error = '流式连接结束时没有收到模型完成标记';
        attempts.push(attempt);
        await finalizeFailed(
          env,
          liveRow,
          attempts,
          attempt.error,
          streamed.content,
          streamed.reasoning.length,
        );
        return;
      }

      attempt.ok = true;
      attempts.push(attempt);
      const responseCipher = await sealJson(env, userId, jobId, 'response', streamed.response);
      const partialCipher = await sealJson(env, userId, jobId, 'partial', streamed.content);
      const usage = (streamed.response as any)?.usage || {};
      const promptTokens = Number(usage?.prompt_tokens);
      const completionTokens = Number(usage?.completion_tokens);
      const finishedAt = now();
      await env.DB.prepare(
        `UPDATE story_jobs
         SET status = 'succeeded', response_cipher = ?, partial_cipher = ?, error = NULL,
             attempts_json = ?, prompt_tokens = ?, completion_tokens = ?, reasoning_chars = ?,
             visible_chars = ?, updated_at = ?, completed_at = ?
         WHERE user_id = ? AND job_id = ?`,
      ).bind(
        responseCipher,
        partialCipher,
        JSON.stringify(attempts),
        Number.isFinite(promptTokens) ? promptTokens : null,
        Number.isFinite(completionTokens) ? completionTokens : null,
        streamed.reasoning.length,
        streamed.content.length,
        finishedAt,
        finishedAt,
        userId,
        jobId,
      ).run();
      return;
    } catch (error) {
      const attempt = routeAttempt(route, index, attemptStartedAt);
      attempt.status = response.status;
      attempt.error = (error as Error)?.message || String(error);
      attempt.durationMs = now() - attemptStartedAt;
      attempts.push(attempt);
      // 已拿到 HTTP 200 后的流错误属于可能已计费的模糊状态，不自动故障转移。
      await finalizeFailed(env, liveRow, attempts, `剧情云端流读取失败：${attempt.error}`);
      return;
    }
  }

  await finalizeFailed(env, liveRow, attempts, lastError);
};

export class StoryTickDO extends DurableObject<StoryJobsEnv> {
  async kick(userId: string, jobId: string): Promise<void> {
    await this.ctx.storage.put(STORY_ALARM_KEY, { userId, jobId });
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  async alarm(): Promise<void> {
    const task = await this.ctx.storage.get<{ userId: string; jobId: string }>(STORY_ALARM_KEY);
    if (!task?.userId || !task.jobId) return;
    try {
      await runStoryJob(this.env, task.userId, task.jobId);
    } finally {
      await this.ctx.storage.delete(STORY_ALARM_KEY);
    }
  }
}

export const handleStoryJobsRequest = async (
  request: Request,
  env: StoryJobsEnv,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return {
      status: auth.status,
      body: { success: false, error: { code: auth.code, message: auth.message } },
    };
  }
  const userId = auth.userId;
  await ensureStoryJobsSchema(env.DB);
  await cleanupOldJobs(env.DB);

  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const marker = parts.lastIndexOf('story-jobs');
  const tail = marker >= 0 ? parts.slice(marker + 1) : [];
  const method = request.method.toUpperCase();

  if (method === 'POST' && tail.length === 0) {
    let spec: StoryJobSpec;
    try {
      spec = validateSpec(await request.json());
    } catch (error) {
      return {
        status: 400,
        body: { success: false, error: { code: 'INVALID_STORY_JOB', message: (error as Error)?.message || String(error) } },
      };
    }

    let existing = await loadRowByClient(env.DB, userId, spec.clientRequestId);
    if (!existing) existing = await loadRowById(env.DB, userId, spec.jobId);
    if (!existing) {
      const t = now();
      const requestCipher = await sealJson(env, userId, spec.jobId, 'request', spec);
      await env.DB.prepare(
        `INSERT INTO story_jobs (
          job_id, user_id, client_request_id, owner_key, title, status, request_cipher,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      ).bind(
        spec.jobId,
        userId,
        spec.clientRequestId,
        spec.ownerKey,
        spec.title,
        requestCipher,
        t,
        t,
      ).run();
      existing = await loadRowById(env.DB, userId, spec.jobId);
    }
    if (!existing) {
      return { status: 500, body: { success: false, error: { code: 'STORY_JOB_CREATE_FAILED', message: '剧情后台任务没能落库' } } };
    }

    if (existing.status === 'queued') {
      const kicked = await kickStoryTick(env, userId, existing.job_id);
      if (!kicked.ok && kicked.reason === 'missing-binding') {
        return {
          status: 503,
          body: {
            success: false,
            job: await publicJob(env, existing),
            error: {
              code: 'STORY_TICK_MISSING',
              message: '剧情后台任务需要更新主动消息 Worker：缺少 STORY_TICK Durable Object。',
            },
          },
        };
      }
      if (!kicked.ok) {
        console.warn('[amsg:story-job] STORY_TICK 叫醒失败，任务仍保留 queued', kicked.error);
      }
    }

    return { status: 202, body: { success: true, job: await publicJob(env, existing) } };
  }

  if (method === 'GET' && tail[0] === 'by-client' && tail[1]) {
    const row = await loadRowByClient(env.DB, userId, decodeURIComponent(tail.slice(1).join('/')));
    return { status: 200, body: { success: true, job: row ? await publicJob(env, row) : null } };
  }

  if (method === 'GET' && tail.length === 1 && tail[0]) {
    const row = await loadRowById(env.DB, userId, decodeURIComponent(tail[0]));
    if (row?.status === 'queued') {
      const kicked = await kickStoryTick(env, userId, row.job_id);
      if (!kicked.ok && kicked.reason === 'kick-failed') {
        console.warn('[amsg:story-job] status 时重叫 STORY_TICK 失败', kicked.error);
      }
    }
    return { status: 200, body: { success: true, job: row ? await publicJob(env, row) : null } };
  }

  if (method === 'DELETE' && tail.length === 1 && tail[0]) {
    const jobId = decodeURIComponent(tail[0]);
    const t = now();
    await env.DB.prepare(
      "UPDATE story_jobs SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE user_id = ? AND job_id = ? AND status IN ('queued','running')",
    ).bind(t, t, userId, jobId).run();
    const row = await loadRowById(env.DB, userId, jobId);
    return { status: 200, body: { success: true, job: row ? await publicJob(env, row) : null } };
  }

  return {
    status: 404,
    body: { success: false, error: { code: 'STORY_JOB_NOT_FOUND', message: '剧情后台任务端点不存在' } },
  };
};
