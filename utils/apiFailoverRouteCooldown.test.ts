import { beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedApiRoute } from './apiFailover';
import {
  API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS,
  clearAllApiRouteCooldowns,
  clearApiRouteCooldown,
  getApiRouteCooldown,
  listActiveApiRouteCooldowns,
  makeApiRouteCooldownKey,
  markApiRouteCooldown,
} from './apiFailoverRouteCooldown';

const route = (id = 'a', baseUrl = 'https://a.example/v1/', model = 'gemini-3.1-pro-preview'): ResolvedApiRoute => ({
  presetId: id,
  presetName: id.toUpperCase(),
  api: { baseUrl, apiKey: `secret-${id}`, model, stream: false } as any,
  routeIndex: 0,
});

const failure = (kind: any = 'server', status: number | undefined = 503) => ({
  kind,
  message: 'unavailable',
  status,
  retrySameRoute: true,
  failoverEligible: true,
  circuitFailure: true,
});

describe('apiFailoverRouteCooldown', () => {
  beforeEach(() => localStorage.clear());

  it('uses route identity without API keys', () => {
    const key = makeApiRouteCooldownKey('chat', route());
    expect(key).toContain('chat|a|https://a.example/v1|gemini');
    expect(key).not.toContain('secret-');
  });

  it('blocks a failed route for exactly three minutes', () => {
    const now = 1000;
    const entry = markApiRouteCooldown('chat', route(), failure() as any, now);
    expect(entry?.blockedUntil).toBe(now + API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS);
    expect(getApiRouteCooldown('chat', route(), now + 179999)).not.toBeNull();
    expect(getApiRouteCooldown('chat', route(), now + 180000)).toBeNull();
  });

  it('does not cool non-route failures', () => {
    expect(markApiRouteCooldown('chat', route(), {
      kind: 'bad_request', message: 'invalid tools', status: 400,
      retrySameRoute: false, failoverEligible: false, circuitFailure: false,
    }, 1000)).toBeNull();
    expect(listActiveApiRouteCooldowns(1000)).toEqual([]);
  });

  it('survives localStorage reload semantics', () => {
    markApiRouteCooldown('emotion', route('b'), failure('network', undefined), 2000);
    expect(getApiRouteCooldown('emotion', route('b'), 3000)).toMatchObject({ presetId: 'b', failureKind: 'network' });
  });

  it('does not block a changed URL or model', () => {
    markApiRouteCooldown('chat', route('a', 'https://old.example/v1', 'm1'), failure() as any, 1000);
    expect(getApiRouteCooldown('chat', route('a', 'https://new.example/v1', 'm1'), 2000)).toBeNull();
    expect(getApiRouteCooldown('chat', route('a', 'https://old.example/v1', 'm2'), 2000)).toBeNull();
  });

  it('clears one or all routes explicitly', () => {
    const a = route('a'); const b = route('b');
    markApiRouteCooldown('chat', a, failure() as any, 1000);
    markApiRouteCooldown('chat', b, failure() as any, 1000);
    clearApiRouteCooldown('chat', a);
    expect(getApiRouteCooldown('chat', a, 2000)).toBeNull();
    expect(getApiRouteCooldown('chat', b, 2000)).not.toBeNull();
    clearAllApiRouteCooldowns();
    expect(listActiveApiRouteCooldowns(2000)).toEqual([]);
  });
});
