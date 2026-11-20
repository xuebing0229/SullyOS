import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ElevenLabs subscription read-only proxy', () => {
  it('forwards GET with the caller Key without caching', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({
      character_count: 900, character_limit: 1000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', mock);
    const response = await worker.fetch(new Request('https://proxy.test/elevenlabs/subscription', {
      headers: { 'xi-api-key': 'my-account-b' },
    }), {}, { waitUntil: () => {} });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ character_count: 900, character_limit: 1000 });
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/user/subscription');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string,string>)['xi-api-key']).toBe('my-account-b');
  });

  it('rejects POST and requests without Key before upstream', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    const call = (init?: RequestInit) => worker.fetch(
      new Request('https://proxy.test/elevenlabs/subscription', init), {}, { waitUntil: () => {} },
    );
    expect((await call({ method: 'POST' })).status).toBe(405);
    expect((await call()).status).toBe(401);
    expect(mock).not.toHaveBeenCalled();
  });
});
