import type {
  ApiFailoverScope,
  ApiFailureKind,
  ClassifiedApiError,
  ResolvedApiRoute,
} from './apiFailover';

export const API_FAILOVER_ROUTE_COOLDOWN_STORAGE_KEY =
  'os_api_failover_route_cooldowns_v1';

export const API_FAILOVER_ROUTE_COOLDOWN_EVENT =
  'sullyos:api-failover-route-cooldown-changed';

export const API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS =
  3 * 60 * 1000;

export interface ApiRouteCooldownEntry {
  version: 1;
  key: string;
  scope: ApiFailoverScope;
  presetId: string;
  presetName: string;
  baseUrl: string;
  model: string;
  failedAt: number;
  blockedUntil: number;
  failureKind: ApiFailureKind;
  status?: number;
}

interface ApiRouteCooldownState {
  version: 1;
  entries: ApiRouteCooldownEntry[];
}

const normalizeBaseUrl = (value: unknown): string =>
  String(value || '').trim().replace(/\/+$/, '');

export function makeApiRouteCooldownKey(
  scope: ApiFailoverScope,
  route: Pick<ResolvedApiRoute, 'presetId' | 'api'>,
): string {
  return [
    scope,
    route.presetId,
    normalizeBaseUrl(route.api.baseUrl),
    String(route.api.model || '').trim(),
  ].join('|');
}

const sanitizeEntry = (value: unknown): ApiRouteCooldownEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as any;
  if (
    typeof raw.key !== 'string'
    || (raw.scope !== 'chat' && raw.scope !== 'emotion')
    || typeof raw.presetId !== 'string'
    || typeof raw.presetName !== 'string'
    || typeof raw.baseUrl !== 'string'
    || typeof raw.model !== 'string'
    || !Number.isFinite(raw.failedAt)
    || !Number.isFinite(raw.blockedUntil)
    || typeof raw.failureKind !== 'string'
  ) return null;

  return {
    version: 1,
    key: raw.key,
    scope: raw.scope,
    presetId: raw.presetId,
    presetName: raw.presetName,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    model: raw.model.trim(),
    failedAt: raw.failedAt,
    blockedUntil: raw.blockedUntil,
    failureKind: raw.failureKind,
    status: Number.isFinite(raw.status) ? Number(raw.status) : undefined,
  };
};

function dispatchChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(API_FAILOVER_ROUTE_COOLDOWN_EVENT));
  } catch { /* SSR / test */ }
}

function readState(now = Date.now()): ApiRouteCooldownState {
  if (typeof localStorage === 'undefined') return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(API_FAILOVER_ROUTE_COOLDOWN_STORAGE_KEY) || 'null');
    const entries = Array.isArray(raw?.entries)
      ? raw.entries.map(sanitizeEntry).filter(Boolean).filter(
          (entry: ApiRouteCooldownEntry) => entry.blockedUntil > now,
        ) as ApiRouteCooldownEntry[]
      : [];
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeState(state: ApiRouteCooldownState, now = Date.now()): void {
  if (typeof localStorage === 'undefined') return;
  const latest = new Map<string, ApiRouteCooldownEntry>();
  for (const entry of state.entries) {
    if (entry.blockedUntil <= now) continue;
    const old = latest.get(entry.key);
    if (!old || old.blockedUntil <= entry.blockedUntil) latest.set(entry.key, entry);
  }
  localStorage.setItem(API_FAILOVER_ROUTE_COOLDOWN_STORAGE_KEY, JSON.stringify({
    version: 1,
    entries: [...latest.values()],
  }));
  dispatchChanged();
}

export function getApiRouteCooldown(
  scope: ApiFailoverScope,
  route: ResolvedApiRoute,
  now = Date.now(),
): ApiRouteCooldownEntry | null {
  const key = makeApiRouteCooldownKey(scope, route);
  return readState(now).entries.find(entry => entry.key === key) || null;
}

export function listActiveApiRouteCooldowns(now = Date.now()): ApiRouteCooldownEntry[] {
  return readState(now).entries.sort((a, b) => a.blockedUntil - b.blockedUntil);
}

export function markApiRouteCooldown(
  scope: ApiFailoverScope,
  route: ResolvedApiRoute,
  classification: ClassifiedApiError,
  now = Date.now(),
): ApiRouteCooldownEntry | null {
  if (!classification.circuitFailure) return null;
  const key = makeApiRouteCooldownKey(scope, route);
  const state = readState(now);
  const entry: ApiRouteCooldownEntry = {
    version: 1,
    key,
    scope,
    presetId: route.presetId,
    presetName: route.presetName,
    baseUrl: normalizeBaseUrl(route.api.baseUrl),
    model: String(route.api.model || '').trim(),
    failedAt: now,
    blockedUntil: now + API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS,
    failureKind: classification.kind,
    status: classification.status,
  };
  state.entries = [...state.entries.filter(item => item.key !== key), entry];
  writeState(state, now);
  return entry;
}

export function clearApiRouteCooldown(
  scope: ApiFailoverScope,
  route: ResolvedApiRoute,
): void {
  const key = makeApiRouteCooldownKey(scope, route);
  // Explicitly clearing one route must not prune unrelated entries as a side effect.
  const state = readState(0);
  const next = state.entries.filter(entry => entry.key !== key);
  writeState({ version: 1, entries: next }, 0);
}

export function clearAllApiRouteCooldowns(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(API_FAILOVER_ROUTE_COOLDOWN_STORAGE_KEY);
  dispatchChanged();
}

export function formatApiRouteCooldownRemaining(
  blockedUntil: number,
  now = Date.now(),
): string {
  const total = Math.max(0, Math.ceil((blockedUntil - now) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  if (seconds <= 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
}
