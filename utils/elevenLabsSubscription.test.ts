import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ELEVENLABS_USAGE_CHANGED_EVENT,
  fetchElevenLabsSubscriptionBalance,
  notifyElevenLabsUsageChanged,
  parseElevenLabsSubscriptionBalance,
} from './elevenLabsSubscription';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ElevenLabs subscription balance', () => {
  it('calculates included remaining quota without adding paid overage', () => {
    expect(parseElevenLabsSubscriptionBalance({
      tier: 'starter', character_count: 2400, character_limit: 10000,
      next_character_count_reset_unix: 1796000000, can_extend_character_limit: true,
      max_credit_limit_extension: 1000,
    })).toEqual({
      used: 2400, limit: 10000, remaining: 7600, tier: 'starter',
      nextResetUnix: 1796000000, overageEnabled: true,
    });
    expect(parseElevenLabsSubscriptionBalance({
      character_count: 12000, character_limit: 10000, max_credit_limit_extension: 0,
    }).remaining).toBe(0);
    expect(() => parseElevenLabsSubscriptionBalance({ tier: 'starter' })).toThrow('额度字段不完整');
  });

  it('queries with the selected Key in header, never the URL', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({
      character_count: 75, character_limit: 250,
    }), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const result = await fetchElevenLabsSubscriptionBalance('my-selected-key');
    expect(result.remaining).toBe(175);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/elevenlabs/subscription');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('my-selected-key');
    expect(url).not.toContain('my-selected-key');
  });

  it('displays a permission-specific error rather than blocking voice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    await expect(fetchElevenLabsSubscriptionBalance('restricted-key')).rejects.toThrow('User: Read');
  });

  it('publishes only the account preset ID', () => {
    // The repository uses Vitest's node environment, not jsdom.
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail: unknown }) {
        this.type = type;
        this.detail = init.detail;
      }
    });
    notifyElevenLabsUsageChanged('account-b');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0].type).toBe(ELEVENLABS_USAGE_CHANGED_EVENT);
    expect(dispatchEvent.mock.calls[0][0].detail).toEqual({ presetId: 'account-b' });
  });
});
