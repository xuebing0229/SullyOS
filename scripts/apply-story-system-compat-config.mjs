import fs from 'node:fs';

const fail = (message) => { throw new Error(message); };

const replaceExact = (path, before, after, expected = 1) => {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== expected) fail(`${path}: expected ${expected} matches, found ${count}`);
  fs.writeFileSync(path, source.replaceAll(before, after));
};

// Cloud-side routing experiment is over: keep legacy env fields harmlessly, but never relay Story traffic.
replaceExact(
  'worker/amsg/src/storyEgress.ts',
  `const normalizeRelayUrl = (value: string): string => value.trim();\n\nconst is749Target = (targetUrl: string): boolean => {\n  try {\n    const host = new URL(targetUrl).hostname.toLowerCase();\n    return host === '749code.com' || host.endsWith('.749code.com');\n  } catch {\n    return false;\n  }\n};\n\nconst shouldBypassStoryRelay = (targetUrl: string): boolean => is749Target(targetUrl);\n\nexport const resolveStoryEgressRoute = (\n  env: StoryEgressEnv,\n  targetUrl: string,\n): StoryEgressRoute => {\n  // 749 对出口来源较敏感；主聊天 / RikkaHub 直连正常而 relay 路径出现上游 OAuth 401。\n  // 这条仅是网络出口兼容，与下面可配置的 system 兼容开关互相独立。\n  if (shouldBypassStoryRelay(targetUrl)) {\n    return { url: targetUrl, relayed: false };\n  }\n\n  const relayUrl = normalizeRelayUrl(String(env.STORY_EGRESS_RELAY_URL || ''));\n  const relayToken = String(env.STORY_EGRESS_RELAY_TOKEN || '').trim();\n\n  if (!relayUrl && !relayToken) {\n    return { url: targetUrl, relayed: false };\n  }\n  if (!relayUrl || !relayToken) {\n    throw new Error('剧情统一出口配置不完整：STORY_EGRESS_RELAY_URL 与 STORY_EGRESS_RELAY_TOKEN 必须同时配置');\n  }\n\n  let parsed: URL;\n  try {\n    parsed = new URL(relayUrl);\n  } catch {\n    throw new Error('剧情统一出口地址无效：STORY_EGRESS_RELAY_URL 不是合法 URL');\n  }\n  if (parsed.protocol !== 'https:') {\n    throw new Error('剧情统一出口必须使用 HTTPS');\n  }\n\n  return { url: parsed.toString(), relayed: true };\n};\n`,
  `const is749Target = (targetUrl: string): boolean => {\n  try {\n    const host = new URL(targetUrl).hostname.toLowerCase();\n    return host === '749code.com' || host.endsWith('.749code.com');\n  } catch {\n    return false;\n  }\n};\n\n/**\n * 剧情统一出口实验已结束。保留 env 参数只为了兼容现有部署配置，\n * 但所有文游正文都直接由 Worker 请求模型上游，不再经过日本 relay。\n */\nexport const resolveStoryEgressRoute = (\n  _env: StoryEgressEnv,\n  targetUrl: string,\n): StoryEgressRoute => ({ url: targetUrl, relayed: false });\n`,
);

replaceExact(
  'worker/amsg/src/storyEgress.ts',
  ` * - 749：继续 Worker 直连，避免 relay 出口触发不同的上游鉴权路径。\n * - systemCompatibility：由文游预设中的“具体模型 + 具体站点”显式决定；主聊天不读。\n * - 新客户端携带线路开关表时它是权威值；显式关闭会覆盖 749 迁移兜底。\n * - 旧客户端没有该字段时，749 + Gemini 暂时沿用迁移兜底，避免 APK 更新前回归 429。\n * - 其他上游未配置 relay：保持 Cloudflare Worker 直接请求模型上游。\n * - 其他上游 relay URL + token 同时配置：经 relay 出网。\n * - 最终发出前移除 Sully 私有字段、最大输出 token 字段、纯 0 penalty，并合并相邻 system 消息。\n`,
  ` * - 所有文游正文：Worker 直接请求模型上游，不再经日本 relay。\n * - systemCompatibility：由文游预设中的“具体模型 + 具体站点”显式决定；主聊天不读。\n * - 新客户端携带线路开关表时它是权威值；显式关闭会覆盖 749 迁移兜底。\n * - 旧客户端没有该字段时，749 + Gemini 暂时沿用迁移兜底，避免 APK 更新前回归 429。\n * - 最终发出前移除 Sully 私有字段、最大输出 token 字段、纯 0 penalty，并合并相邻 system 消息。\n`,
);

replaceExact(
  'worker/amsg/src/storyEgress.ts',
  `  if (!route.relayed) {\n    const response = await fetch(targetUrl, requestInit);\n    return annotateFailure(response, requestInit.body, targetUrl, route, systemCompatibility);\n  }\n\n  const headers = new Headers(requestInit.headers || {});\n  headers.set('X-Sully-Egress-Version', '1');\n  headers.set('X-Sully-Egress-Target', targetUrl);\n  headers.set('X-Sully-Egress-Token', String(env.STORY_EGRESS_RELAY_TOKEN || '').trim());\n\n  const response = await fetch(route.url, {\n    ...requestInit,\n    headers,\n  });\n  return annotateFailure(response, requestInit.body, targetUrl, route, systemCompatibility);\n`,
  `  const response = await fetch(targetUrl, requestInit);\n  return annotateFailure(response, requestInit.body, targetUrl, route, systemCompatibility);\n`,
);

replaceExact(
  'worker/amsg/src/storyEgress.test.ts',
  `  it('routes ordinary upstreams through the configured relay and omits output token ceilings', async () => {\n    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));\n    const controller = new AbortController();\n\n    await fetchStoryUpstream(\n      {\n        STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress',\n        STORY_EGRESS_RELAY_TOKEN: 'relay-secret',\n      },\n      'https://example.com/v1/chat/completions',\n      {\n        method: 'POST',\n        headers: {\n          'Content-Type': 'application/json',\n          Authorization: 'Bearer upstream-key',\n        },\n        body: '{\"model\":\"x\",\"stream\":true,\"max_tokens\":32000,\"max_completion_tokens\":16000}',\n        signal: controller.signal,\n      },\n    );\n\n    expect(fetchMock).toHaveBeenCalledTimes(1);\n    const [url, init] = fetchMock.mock.calls[0];\n    expect(url).toBe('https://ag.apixb.top/sullyos-story-egress');\n    const headers = new Headers(init?.headers);\n    expect(headers.get('Authorization')).toBe('Bearer upstream-key');\n    expect(headers.get('Content-Type')).toBe('application/json');\n    expect(headers.get('X-Sully-Egress-Target')).toBe('https://example.com/v1/chat/completions');\n    expect(headers.get('X-Sully-Egress-Token')).toBe('relay-secret');\n    expect(headers.get('X-Sully-Egress-Version')).toBe('1');\n    expect(JSON.parse(String(init?.body))).toEqual({ model: 'x', stream: true });\n    expect(init?.signal).toBe(controller.signal);\n  });\n`,
  `  it('ignores legacy relay config and still sends ordinary upstreams directly', async () => {\n    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));\n    const controller = new AbortController();\n\n    await fetchStoryUpstream(\n      {\n        STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress',\n        STORY_EGRESS_RELAY_TOKEN: 'relay-secret',\n      },\n      'https://example.com/v1/chat/completions',\n      {\n        method: 'POST',\n        headers: {\n          'Content-Type': 'application/json',\n          Authorization: 'Bearer upstream-key',\n        },\n        body: '{\"model\":\"x\",\"stream\":true,\"max_tokens\":32000,\"max_completion_tokens\":16000}',\n        signal: controller.signal,\n      },\n    );\n\n    expect(fetchMock).toHaveBeenCalledTimes(1);\n    const [url, init] = fetchMock.mock.calls[0];\n    expect(url).toBe('https://example.com/v1/chat/completions');\n    const headers = new Headers(init?.headers);\n    expect(headers.get('Authorization')).toBe('Bearer upstream-key');\n    expect(headers.get('Content-Type')).toBe('application/json');\n    expect(headers.get('X-Sully-Egress-Target')).toBeNull();\n    expect(headers.get('X-Sully-Egress-Token')).toBeNull();\n    expect(headers.get('X-Sully-Egress-Version')).toBeNull();\n    expect(JSON.parse(String(init?.body))).toEqual({ model: 'x', stream: true });\n    expect(init?.signal).toBe(controller.signal);\n  });\n`,
);

replaceExact(
  'worker/amsg/src/storyEgress.test.ts',
  `  it('bypasses the relay for 749 while preserving its Authorization header', async () => {\n`,
  `  it('keeps 749 direct while preserving its Authorization header', async () => {\n`,
);

replaceExact(
  'worker/amsg/src/storyEgress.test.ts',
  `  it('fails closed when only half of the relay config exists for ordinary upstreams', () => {\n    expect(() => resolveStoryEgressRoute(\n      { STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress' },\n      'https://example.com/v1/chat/completions',\n    )).toThrow(/必须同时配置/);\n\n    expect(() => resolveStoryEgressRoute(\n      { STORY_EGRESS_RELAY_TOKEN: 'secret' },\n      'https://example.com/v1/chat/completions',\n    )).toThrow(/必须同时配置/);\n  });\n\n  it('refuses to send the relay token over plain HTTP', () => {\n    expect(() => resolveStoryEgressRoute(\n      {\n        STORY_EGRESS_RELAY_URL: 'http://relay.example/relay',\n        STORY_EGRESS_RELAY_TOKEN: 'secret',\n      },\n      'https://example.com/v1/chat/completions',\n    )).toThrow(/必须使用 HTTPS/);\n  });\n`,
  `  it('treats stale or partial relay settings as inert legacy config', () => {\n    expect(resolveStoryEgressRoute(\n      { STORY_EGRESS_RELAY_URL: 'https://ag.apixb.top/sullyos-story-egress' },\n      'https://example.com/v1/chat/completions',\n    )).toEqual({ url: 'https://example.com/v1/chat/completions', relayed: false });\n\n    expect(resolveStoryEgressRoute(\n      { STORY_EGRESS_RELAY_TOKEN: 'secret' },\n      'https://example.com/v1/chat/completions',\n    )).toEqual({ url: 'https://example.com/v1/chat/completions', relayed: false });\n\n    expect(resolveStoryEgressRoute(\n      {\n        STORY_EGRESS_RELAY_URL: 'http://relay.example/relay',\n        STORY_EGRESS_RELAY_TOKEN: 'secret',\n      },\n      'https://example.com/v1/chat/completions',\n    )).toEqual({ url: 'https://example.com/v1/chat/completions', relayed: false });\n  });\n`,
);

console.log('Disabled the temporary Japanese story relay and restored direct Worker egress.');
