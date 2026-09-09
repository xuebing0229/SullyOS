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

  it('routes ordinary upstreams through the configured relay and omits output token ceilings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const controller = new AbortController();

    await fetchStoryUpstream(
      {
        STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress',
        STORY_EGRESS_RELAY_TOKEN: 'relay-secret',
      },
      'https://example.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer upstream-key',
        },
        body: '{"model":"x","stream":true,"max_tokens":32000,"max_completion_tokens":16000}',
        signal: controller.signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ag.apixb.top/sullyos-story-egress');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer upstream-key');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Sully-Egress-Target')).toBe('https://example.com/v1/chat/completions');
    expect(headers.get('X-Sully-Egress-Token')).toBe('relay-secret');
    expect(headers.get('X-Sully-Egress-Version')).toBe('1');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'x', stream: true });
    expect(init?.signal).toBe(controller.signal);
  });

  it('bypasses the relay for 749 while preserving its Authorization header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

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
          Authorization: 'Bearer 749-key',
        },
        body: '{"model":"gemini","stream":true,"max_tokens":32000}',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://749code.com/v1/chat/completions');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer 749-key');
    expect(headers.get('X-Sully-Egress-Target')).toBeNull();
    expect(headers.get('X-Sully-Egress-Token')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'gemini', stream: true });
  });

  it('fails closed when only half of the relay config exists for ordinary upstreams', () => {
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
