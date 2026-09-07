import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchStoryUpstream, resolveStoryEgressRoute } from './storyEgress';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('story egress routing', () => {
  it('keeps direct Cloudflare egress when relay is not configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const controller = new AbortController();

    await fetchStoryUpstream(
      {},
      'https://example.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer upstream-key',
        },
        body: '{"stream":true}',
        signal: controller.signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/v1/chat/completions');
    expect(init?.signal).toBe(controller.signal);
    expect(new Headers(init?.headers).get('X-Sully-Egress-Target')).toBeNull();
  });

  it('routes every upstream through the configured relay without changing the model request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const controller = new AbortController();

    await fetchStoryUpstream(
      {
        STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress',
        STORY_EGRESS_RELAY_TOKEN: 'relay-secret',
      },
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer upstream-key',
        },
        body: '{"model":"x","stream":true}',
        signal: controller.signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ag.apixb.top/sullyos-story-egress');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer upstream-key');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Sully-Egress-Target')).toBe('https://749code.com/v1/chat/completions');
    expect(headers.get('X-Sully-Egress-Token')).toBe('relay-secret');
    expect(headers.get('X-Sully-Egress-Version')).toBe('1');
    expect(init?.body).toBe('{"model":"x","stream":true}');
    expect(init?.signal).toBe(controller.signal);
  });

  it('fails closed when only half of the relay config exists', () => {
    expect(() => resolveStoryEgressRoute(
      { STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress' },
      'https://example.com/v1/chat/completions',
    )).toThrow(/必须同时配置/);

    expect(() => resolveStoryEgressRoute(
      { STORY_EGRESS_RELAY_TOKEN: 'secret' },
      'https://example.com/v1/chat/completions',
    )).toThrow(/必须同时配置/);
  });

  it('refuses to send the relay token over plain HTTP', () => {
    expect(() => resolveStoryEgressRoute(
      {
        STORY_EGRESS_RELAY_URL: 'http://relay.example/relay',
        STORY_EGRESS_RELAY_TOKEN: 'secret',
      },
      'https://example.com/v1/chat/completions',
    )).toThrow(/必须使用 HTTPS/);
  });
});
