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

  it('compacts adjacent story system messages for ordinary upstreams', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchStoryUpstream(
      {},
      'https://example.com/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini',
          messages: [
            { role: 'system', content: 'rule-a' },
            { role: 'system', content: 'rule-b' },
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'rule-c' },
            { role: 'assistant', content: 'world' },
          ],
        }),
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).messages).toEqual([
      { role: 'system', content: 'rule-a\n\nrule-b' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'rule-c' },
      { role: 'assistant', content: 'world' },
    ]);
  });

  it('moves full 749 Gemini system rules into the final user turn while keeping a short system anchor', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: ok\n\n', { status: 200 }));

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
          model: '[反重力次]gemini-3.1-pro-high',
          stream: true,
          stream_options: { include_usage: true },
          temperature: 1,
          top_p: 0.98,
          messages: [
            { role: 'system', content: 'rule-a' },
            { role: 'system', content: 'rule-b' },
            { role: 'user', content: 'old user turn' },
            { role: 'assistant', content: 'old assistant turn' },
            { role: 'system', content: 'rule-c' },
            { role: 'user', content: 'continue story' },
          ],
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(body.messages).toHaveLength(4);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('<SULLY_SYSTEM_INSTRUCTIONS>');
    expect(body.messages[0].content.length).toBeLessThan(300);
    expect(body.messages[1]).toEqual({ role: 'user', content: 'old user turn' });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'old assistant turn' });
    expect(body.messages[3].role).toBe('user');
    expect(body.messages[3].content).toContain('<SULLY_SYSTEM_INSTRUCTIONS>\nrule-a\n\nrule-b\n\nrule-c\n</SULLY_SYSTEM_INSTRUCTIONS>');
    expect(body.messages[3].content).toContain('<SULLY_CURRENT_USER_TURN>\ncontinue story\n</SULLY_CURRENT_USER_TURN>');
  });

  it('does not rewrite system roles for non-Gemini models on 749', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchStoryUpstream(
      {},
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.6',
          messages: [
            { role: 'system', content: 'rule' },
            { role: 'user', content: 'hello' },
          ],
        }),
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).messages).toEqual([
      { role: 'system', content: 'rule' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('adds sanitized final-request diagnostics without launching extra 749 probes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"resource exhausted"}}', { status: 429 }),
    );

    const response = await fetchStoryUpstream(
      {},
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-3.1-pro-high',
          messages: [
            { role: 'system', content: 'large rules' },
            { role: 'user', content: 'continue' },
          ],
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = await response.text();
    expect(text).toContain('[sully_story_diag]');
    expect(text).toContain('"systemCompat749Gemini":true');
    expect(text).not.toContain('sully_story_probe749');
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
