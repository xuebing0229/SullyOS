import { openDB, STORE_AI_RESPONSE_CACHE } from './db';

export type AiRequestKind = 'chat' | 'emotion';
export type AiRequestSource = 'network' | 'memory-dedupe' | 'indexeddb-cache';

export interface AiCacheEntry<T = unknown> {
  key: string;
  version: string;
  kind: AiRequestKind;
  value: T;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  size: number;
  model?: string;
  provider?: string;
  promptVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface AiRequestResult<T> {
  value: T;
  key: string;
  source: AiRequestSource;
  durationMs: number;
  networkRequest: boolean;
}

export interface AiRequestOptions<T> {
  kind: AiRequestKind;
  request: unknown;
  execute: () => Promise<T>;
  ttlMs?: number;
  bypass?: boolean;
  forceRefresh?: boolean;
  version?: string;
  model?: string;
  provider?: string;
  promptVersion?: string;
  metadata?: Record<string, unknown>;
  shouldCache?: (value: T) => boolean;
}

export const AI_CACHE_VERSION = 'ai-cache-v1';
export const CHAT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EMOTION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AI_CACHE_MAX_BYTES = 150 * 1024 * 1024;

const inFlight = new Map<string, Promise<unknown>>();

export function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: any): any => {
    if (input === undefined) return { __type: 'undefined' };
    if (typeof input === 'number' && !Number.isFinite(input)) return { __type: String(input) };
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) throw new TypeError('Cannot cache a circular request');
    seen.add(input);
    if (Array.isArray(input)) {
      const output = input.map(normalize);
      seen.delete(input);
      return output;
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) output[key] = normalize(input[key]);
    seen.delete(input);
    return output;
  };
  return JSON.stringify(normalize(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildAiCacheKey(kind: AiRequestKind, request: unknown, version = AI_CACHE_VERSION): Promise<string> {
  return sha256Hex(stableSerialize({ version, kind, request }));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

async function readEntry<T>(key: string, version: string): Promise<AiCacheEntry<T> | null> {
  const db = await openDB();
  if (!db.objectStoreNames.contains(STORE_AI_RESPONSE_CACHE)) return null;
  const tx = db.transaction(STORE_AI_RESPONSE_CACHE, 'readwrite');
  const store = tx.objectStore(STORE_AI_RESPONSE_CACHE);
  const entry = await requestResult(store.get(key)) as AiCacheEntry<T> | undefined;
  const now = Date.now();
  if (!entry || entry.version !== version || entry.expiresAt <= now) {
    if (entry) store.delete(key);
    await transactionDone(tx);
    return null;
  }
  entry.lastAccessedAt = now;
  store.put(entry);
  await transactionDone(tx);
  return entry;
}

async function writeEntry<T>(entry: AiCacheEntry<T>): Promise<void> {
  const db = await openDB();
  if (!db.objectStoreNames.contains(STORE_AI_RESPONSE_CACHE)) return;
  const tx = db.transaction(STORE_AI_RESPONSE_CACHE, 'readwrite');
  tx.objectStore(STORE_AI_RESPONSE_CACHE).put(entry);
  await transactionDone(tx);
  void cleanupAiCache().catch(() => {});
}

function approximateSize(value: unknown): number {
  return new TextEncoder().encode(stableSerialize(value)).byteLength;
}

export async function cleanupAiCache(maxBytes = AI_CACHE_MAX_BYTES): Promise<void> {
  const db = await openDB();
  if (!db.objectStoreNames.contains(STORE_AI_RESPONSE_CACHE)) return;
  const tx = db.transaction(STORE_AI_RESPONSE_CACHE, 'readwrite');
  const store = tx.objectStore(STORE_AI_RESPONSE_CACHE);
  const entries = await requestResult(store.getAll()) as AiCacheEntry[];
  const now = Date.now();
  let total = 0;
  const live: AiCacheEntry[] = [];
  for (const entry of entries) {
    if (entry.expiresAt <= now || entry.version !== AI_CACHE_VERSION) store.delete(entry.key);
    else { total += entry.size || 0; live.push(entry); }
  }
  if (total > maxBytes) {
    live.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    for (const entry of live) {
      if (total <= maxBytes) break;
      store.delete(entry.key);
      total -= entry.size || 0;
    }
  }
  await transactionDone(tx);
}

export async function clearAiCache(): Promise<void> {
  inFlight.clear();
  const db = await openDB();
  if (!db.objectStoreNames.contains(STORE_AI_RESPONSE_CACHE)) return;
  const tx = db.transaction(STORE_AI_RESPONSE_CACHE, 'readwrite');
  tx.objectStore(STORE_AI_RESPONSE_CACHE).clear();
  await transactionDone(tx);
}

export async function invalidateAiCacheWhere(predicate: (entry: AiCacheEntry) => boolean): Promise<number> {
  const db = await openDB();
  if (!db.objectStoreNames.contains(STORE_AI_RESPONSE_CACHE)) return 0;
  const tx = db.transaction(STORE_AI_RESPONSE_CACHE, 'readwrite');
  const store = tx.objectStore(STORE_AI_RESPONSE_CACHE);
  const entries = await requestResult(store.getAll()) as AiCacheEntry[];
  let deleted = 0;
  for (const entry of entries) {
    if (predicate(entry)) { store.delete(entry.key); deleted += 1; }
  }
  await transactionDone(tx);
  return deleted;
}

export async function runAiRequest<T>(options: AiRequestOptions<T>): Promise<AiRequestResult<T>> {
  const startedAt = performance.now();
  const version = options.version || AI_CACHE_VERSION;
  const key = await buildAiCacheKey(options.kind, options.request, version);
  const bypassRead = !!options.bypass || !!options.forceRefresh;

  if (!options.forceRefresh) {
    const running = inFlight.get(key) as Promise<AiRequestResult<T>> | undefined;
    if (running) {
      const settled = await running;
      return { ...settled, source: 'memory-dedupe', durationMs: performance.now() - startedAt, networkRequest: false };
    }
  }

  const perform = (async (): Promise<AiRequestResult<T>> => {
    if (!bypassRead) {
      const cached = await readEntry<T>(key, version);
      if (cached) return { value: cached.value, key, source: 'indexeddb-cache', durationMs: performance.now() - startedAt, networkRequest: false };
    }

    const value = await options.execute();
    if (options.shouldCache ? options.shouldCache(value) : value != null) {
      const now = Date.now();
      const ttlMs = options.ttlMs ?? (options.kind === 'emotion' ? EMOTION_CACHE_TTL_MS : CHAT_CACHE_TTL_MS);
      try {
        await writeEntry({
          key, version, kind: options.kind, value, createdAt: now, expiresAt: now + ttlMs,
          lastAccessedAt: now, size: approximateSize(value), model: options.model,
          provider: options.provider, promptVersion: options.promptVersion, metadata: options.metadata,
        });
      } catch (error) {
        console.warn('[AI cache] write failed; returning network response', error);
      }
    }
    return { value, key, source: 'network', durationMs: performance.now() - startedAt, networkRequest: true };
  })();

  if (!options.forceRefresh) inFlight.set(key, perform);
  try {
    return await perform;
  } finally {
    if (!options.forceRefresh && inFlight.get(key) === perform) inFlight.delete(key);
  }
}

export const __aiRequestManagerTest = { inFlight };
