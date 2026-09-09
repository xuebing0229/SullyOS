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
        body: '{"model":"gemini","stream":true,"max_tokens":32000,"frequency_penalty":0,"presence_penalty":0}',
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

  it('preserves explicitly non-zero penalties', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchStoryUpstream(
      {},
      'https://example.com/v1/chat/completions',
      {
        method: 'POST',
        body: '{"model":"x","frequency_penalty":0.5,"presence_penalty":-0.25}',
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'x',
      frequency_penalty: 0.5,
      presence_penalty: -0.25,
    });
  });

  it('compacts adjacent story system messages in the actual final request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchStoryUpstream(
      {},
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer 749-key',
        },
        body: JSON.stringify({
          model: 'gemini',
          messages: [
            { role: 'system', content: 'rule-a' },
            { role: 'system', content: 'rule-b' },
            { role: 'system', content: 'rule-c' },
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'rule-d' },
            { role: 'system', content: 'rule-e' },
            { role: 'assistant', content: 'world' },
          ],
          max_tokens: 32000,
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gemini',
      messages: [
        { role: 'system', content: 'rule-a\n\nrule-b\n\nrule-c' },
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'rule-d\n\nrule-e' },
        { role: 'assistant', content: 'world' },
      ],
    });
  });

  it('splits real system content from real dialogue content after minimal and shape probes succeed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":{"message":"resource exhausted"}}', { status: 429 }))
      .mockResolvedValueOnce(new Response('data: ok\n\n', { status: 200 }))
      .mockResolvedValueOnce(new Response('data: ok\n\n', { status: 200 }))
      .mockResolvedValueOnce(new Response('data: ok\n\n', { status: 200 }))
      .mockResolvedValueOnce(new Response('data: ok\n\n', { status: 200 }));

    const response = await fetchStoryUpstream(
      {},
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer 749-key',
        },
        body: JSON.stringify({
          model: 'gemini',
          stream: true,
          stream_options: { include_usage: true },
          temperature: 1,
          top_p: 0.98,
          messages: [
            { role: 'system', content: 'very long rules' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'world' },
            { role: 'user', content: 'continue' },
          ],
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const minimalBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(minimalBody.messages).toEqual([{ role: 'user', content: 'Reply with exactly OK.' }]);

    const shapeBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(shapeBody.messages).toEqual([
      { role: 'system', content: 'x' },
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'x' },
      { role: 'user', content: 'Reply with exactly OK.' },
    ]);

    const systemRealBody = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(systemRealBody.messages).toEqual([
      { role: 'system', content: 'very long rules' },
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'x' },
      { role: 'user', content: 'Reply with exactly OK.' },
    ]);

    const dialogueRealBody = JSON.parse(String(fetchMock.mock.calls[4][1]?.body));
    expect(dialogueRealBody.messages).toEqual([
      { role: 'system', content: 'x' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'user', content: 'continue' },
    ]);

    const text = await response.text();
    expect(text).toContain('"probe749"');
    expect(text).toContain('"name":"minimal-current","status":200');
    expect(text).toContain('"name":"shape-current","status":200');
    expect(text).toContain('"name":"system-real","status":200');
    expect(text).toContain('"name":"dialogue-real","status":200');
    expect(text).toContain('"messageShapes"');
  });

  it('probes RikkaHub-like headers when the minimal current-header request still fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":{"message":"resource exhausted"}}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"error":{"message":"resource exhausted"}}', { status: 429 }))
      .mockResolvedValueOnce(new Response('data: ok\n\n', { status: 200 }));

    const response = await fetchStoryUpstream(
      {},
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer 749-key',
        },
        body: JSON.stringify({
          model: 'gemini',
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'big request' }],
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const variantHeaders = new Headers(fetchMock.mock.calls[2][1]?.headers);
    expect(variantHeaders.get('Accept')).toBe('text/event-stream');
    expect(variantHeaders.get('X-Session-ID')).toBe('sully-story-749-probe');
    const text = await response.text();
    expect(text).toContain('"name":"minimal-current","status":429');
    expect(text).toContain('"name":"minimal-rikkahub-headers","status":200');
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
