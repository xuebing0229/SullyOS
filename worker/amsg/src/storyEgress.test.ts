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

  it('ignores legacy relay config and still sends ordinary upstreams directly', async () => {
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
    expect(url).toBe('https://example.com/v1/chat/completions');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer upstream-key');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Sully-Egress-Target')).toBeNull();
    expect(headers.get('X-Sully-Egress-Token')).toBeNull();
    expect(headers.get('X-Sully-Egress-Version')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'x', stream: true });
    expect(init?.signal).toBe(controller.signal);
  });

  it('keeps 749 direct while preserving its Authorization header', async () => {
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

  it('uses the frozen baseUrl + model switch and strips Sully private fields before egress', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchStoryUpstream(
      {},
      'https://fragile.example/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-3.1-pro',
          _sullyStorySystemCompatibilityRoutes: [
            { baseUrl: 'https://other.example/v1', model: 'gemini-3.1-pro', enabled: false },
            { baseUrl: 'https://fragile.example/v1/', model: 'gemini-3.1-pro', enabled: true },
          ],
          messages: [
            { role: 'system', content: 'rule-a' },
            { role: 'system', content: 'rule-b' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'continue' },
          ],
          stream: true,
        }),
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body._sullyStorySystemCompatibilityRoutes).toBeUndefined();
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('<SULLY_SYSTEM_INSTRUCTIONS>');
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'old answer' });
    expect(body.messages[2].role).toBe('user');
    expect(body.messages[2].content).toContain('<SULLY_SYSTEM_INSTRUCTIONS>\nrule-a\n\nrule-b\n</SULLY_SYSTEM_INSTRUCTIONS>');
    expect(body.messages[2].content).toContain('<SULLY_CURRENT_USER_TURN>\ncontinue\n</SULLY_CURRENT_USER_TURN>');
  });

  it('lets a frozen explicit off override the legacy 749 Gemini migration fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchStoryUpstream(
      {},
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-3.1-pro',
          _sullyStorySystemCompatibilityRoutes: [
            { baseUrl: 'https://749code.com/v1', model: 'gemini-3.1-pro', enabled: false },
          ],
          messages: [
            { role: 'system', content: 'keep-me-system' },
            { role: 'user', content: 'hello' },
          ],
        }),
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body._sullyStorySystemCompatibilityRoutes).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'keep-me-system' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('keeps the verified 749 Gemini compatibility for old clients that do not send the new switch map', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchStoryUpstream(
      {},
      'https://749code.com/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: '[反重力次]gemini-3.1-pro-high',
          messages: [
            { role: 'system', content: 'legacy-rule' },
            { role: 'user', content: 'continue' },
          ],
        }),
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('<SULLY_SYSTEM_INSTRUCTIONS>');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('legacy-rule');
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

  it('treats stale or partial relay settings as inert legacy config', () => {
    expect(resolveStoryEgressRoute(
      { STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress' },
      'https://example.com/v1/chat/completions',
    )).toEqual({ url: 'https://example.com/v1/chat/completions', relayed: false });

    expect(resolveStoryEgressRoute(
      { STORY_EGRESS_RELAY_TOKEN: 'secret' },
      'https://example.com/v1/chat/completions',
    )).toEqual({ url: 'https://example.com/v1/chat/completions', relayed: false });

    expect(resolveStoryEgressRoute(
      {
        STORY_EGRESS_RELAY_URL: 'http://relay.example/relay',
        STORY_EGRESS_RELAY_TOKEN: 'secret',
      },
      'https://example.com/v1/chat/completions',
    )).toEqual({ url: 'https://example.com/v1/chat/completions', relayed: false });
  });
});
