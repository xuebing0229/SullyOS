export interface StoryEgressEnv {
  STORY_EGRESS_RELAY_URL?: string;
  STORY_EGRESS_RELAY_TOKEN?: string;
}

export interface StoryEgressRoute {
  url: string;
  relayed: boolean;
}

interface Story749ProbeResult {
  name:
    | 'minimal-current'
    | 'minimal-rikkahub-headers'
    | 'shape-current'
    | 'system-real'
    | 'dialogue-real';
  status?: number;
  durationMs: number;
  error?: string;
}

const normalizeRelayUrl = (value: string): string => value.trim();

const is749Target = (targetUrl: string): boolean => {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return host === '749code.com' || host.endsWith('.749code.com');
  } catch {
    return false;
  }
};

const shouldBypassStoryRelay = (targetUrl: string): boolean => is749Target(targetUrl);

export const resolveStoryEgressRoute = (
  env: StoryEgressEnv,
  targetUrl: string,
): StoryEgressRoute => {
  // 749 对出口来源较敏感；主聊天 / RikkaHub 直连正常而 relay 路径出现上游 OAuth 401。
  // 文游后台对该站恢复 Worker 直连行为，避免日本 relay 改变 749 的上游路由选择。
  if (shouldBypassStoryRelay(targetUrl)) {
    return { url: targetUrl, relayed: false };
  }

  const relayUrl = normalizeRelayUrl(String(env.STORY_EGRESS_RELAY_URL || ''));
  const relayToken = String(env.STORY_EGRESS_RELAY_TOKEN || '').trim();

  if (!relayUrl && !relayToken) {
    return { url: targetUrl, relayed: false };
  }
  if (!relayUrl || !relayToken) {
    throw new Error('剧情统一出口配置不完整：STORY_EGRESS_RELAY_URL 与 STORY_EGRESS_RELAY_TOKEN 必须同时配置');
  }

  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error('剧情统一出口地址无效：STORY_EGRESS_RELAY_URL 不是合法 URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('剧情统一出口必须使用 HTTPS');
  }

  return { url: parsed.toString(), relayed: true };
};

const compactAdjacentSystemMessages = (messages: unknown[]): unknown[] => {
  const compacted: unknown[] = [];

  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      compacted.push(rawMessage);
      continue;
    }

    const message = rawMessage as Record<string, unknown>;
    const role = String(message.role || '');
    const previous = compacted[compacted.length - 1];

    if (
      role === 'system'
      && typeof message.content === 'string'
      && previous
      && typeof previous === 'object'
      && !Array.isArray(previous)
    ) {
      const previousMessage = previous as Record<string, unknown>;
      if (previousMessage.role === 'system' && typeof previousMessage.content === 'string') {
        previousMessage.content = `${previousMessage.content}\n\n${message.content}`;
        continue;
      }
    }

    compacted.push({ ...message });
  }

  return compacted;
};

const sanitizeStoryRequestBody = (
  body: BodyInit | null | undefined,
): BodyInit | null | undefined => {
  if (typeof body !== 'string') return body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;

    let changed = false;
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        delete parsed[key];
        changed = true;
      }
    }

    // RikkaHub 的 Chat Completions 默认不会发送纯 0 penalty；删除它们不改变采样效果。
    for (const key of ['frequency_penalty', 'presence_penalty']) {
      if (
        Object.prototype.hasOwnProperty.call(parsed, key)
        && Number(parsed[key]) === 0
      ) {
        delete parsed[key];
        changed = true;
      }
    }

    if (Array.isArray(parsed.messages)) {
      const beforeCount = parsed.messages.length;
      const compacted = compactAdjacentSystemMessages(parsed.messages);
      if (compacted.length !== beforeCount) {
        parsed.messages = compacted;
        changed = true;
      }
    }

    return changed ? JSON.stringify(parsed) : body;
  } catch {
    return body;
  }
};

const textLength = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, item) => {
    if (typeof item === 'string') return total + item.length;
    if (!item || typeof item !== 'object') return total;
    const record = item as Record<string, unknown>;
    return total
      + (typeof record.text === 'string' ? record.text.length : 0)
      + (typeof record.content === 'string' ? record.content.length : 0);
  }, 0);
};

const parseBodyRecord = (body: BodyInit | null | undefined): Record<string, unknown> | null => {
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const safeHost = (value: string): string => {
  try { return new URL(value).host; } catch { return 'invalid-url'; }
};

const summarizeRequest = (
  body: BodyInit | null | undefined,
  targetUrl: string,
  route: StoryEgressRoute,
): Record<string, unknown> => {
  const raw = typeof body === 'string' ? body : '';
  const parsed = parseBodyRecord(body) || {};
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const roleCounts: Record<string, number> = {};
  let messageTextChars = 0;
  const contentKinds = new Set<string>();
  const messageShapes: Array<{ index: number; role: string; chars: number }> = [];

  messages.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      messageShapes.push({ index, role: 'invalid', chars: 0 });
      return;
    }
    const message = item as Record<string, unknown>;
    const role = String(message.role || 'unknown');
    const chars = textLength(message.content);
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    messageTextChars += chars;
    messageShapes.push({ index, role, chars });

    if (typeof message.content === 'string') contentKinds.add('string');
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === 'object') {
          contentKinds.add(String((block as Record<string, unknown>).type || 'object'));
        } else {
          contentKinds.add(typeof block);
        }
      }
    } else {
      contentKinds.add(typeof message.content);
    }
  });

  // 诊断日志会被 App/云任务截断；只保留最大的 5 条，完整正文永不进入日志。
  const largestMessages = [...messageShapes]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);

  return {
    egress: route.relayed ? 'relay' : 'direct',
    targetHost: safeHost(targetUrl),
    relayHost: route.relayed ? safeHost(route.url) : undefined,
    bodyBytes: raw ? new TextEncoder().encode(raw).byteLength : undefined,
    bodyKeys: Object.keys(parsed).sort(),
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    stream: typeof parsed.stream === 'boolean' ? parsed.stream : undefined,
    streamOptions: parsed.stream_options && typeof parsed.stream_options === 'object'
      ? Object.keys(parsed.stream_options as Record<string, unknown>).sort()
      : [],
    temperature: typeof parsed.temperature === 'number' ? parsed.temperature : undefined,
    topP: typeof parsed.top_p === 'number' ? parsed.top_p : undefined,
    maxTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : undefined,
    maxCompletionTokens: typeof parsed.max_completion_tokens === 'number' ? parsed.max_completion_tokens : undefined,
    reasoningEffort: typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : undefined,
    messageCount: messages.length,
    roleCounts,
    messageTextChars,
    largestMessages,
    contentKinds: [...contentKinds].sort(),
  };
};

const buildProbeBase = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of ['model', 'stream', 'stream_options', 'temperature', 'top_p']) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) result[key] = parsed[key];
  }
  return result;
};

const run749Probe = async (
  name: Story749ProbeResult['name'],
  targetUrl: string,
  requestInit: RequestInit,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<Story749ProbeResult> => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = new Headers(requestInit.headers || {});
    for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result: Story749ProbeResult = {
      name,
      status: response.status,
      durationMs: Date.now() - startedAt,
    };
    if (response.ok) {
      try { await response.body?.cancel(); } catch { /* diagnostics only */ }
      return result;
    }
    const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) result.error = text.slice(0, 160);
    return result;
  } catch (error) {
    return {
      name,
      durationMs: Date.now() - startedAt,
      error: String((error as Error)?.message || error).slice(0, 160),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeProbeMessages = (messages: unknown[]): Array<{ role: string; content: string }> => (
  messages.map(item => {
    const message = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const role = ['system', 'assistant', 'user'].includes(String(message.role))
      ? String(message.role)
      : 'user';
    return {
      role,
      content: typeof message.content === 'string' ? message.content : 'x',
    };
  })
);

const run749429Probes = async (
  targetUrl: string,
  requestInit: RequestInit,
): Promise<Story749ProbeResult[]> => {
  const parsed = parseBodyRecord(requestInit.body);
  if (!parsed || typeof parsed.model !== 'string') return [];

  const base = buildProbeBase(parsed);
  const minimalBody = {
    ...base,
    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
  };
  const minimal = await run749Probe('minimal-current', targetUrl, requestInit, minimalBody);

  if (minimal.status === 200) {
    const sourceMessages = normalizeProbeMessages(Array.isArray(parsed.messages) ? parsed.messages : []);
    const shapeMessages = sourceMessages.map((message, index) => ({
      role: message.role,
      content: index === sourceMessages.length - 1 && message.role === 'user'
        ? 'Reply with exactly OK.'
        : 'x',
    }));
    const shape = await run749Probe('shape-current', targetUrl, requestInit, {
      ...base,
      messages: shapeMessages.length > 0 ? shapeMessages : minimalBody.messages,
    });
    if (shape.status !== 200 || sourceMessages.length === 0) return [minimal, shape];

    const systemRealMessages = sourceMessages.map((message, index) => ({
      role: message.role,
      content: message.role === 'system'
        ? message.content
        : index === sourceMessages.length - 1 && message.role === 'user'
          ? 'Reply with exactly OK.'
          : 'x',
    }));
    const dialogueRealMessages = sourceMessages.map(message => ({
      role: message.role,
      content: message.role === 'system' ? 'x' : message.content,
    }));

    const systemReal = await run749Probe('system-real', targetUrl, requestInit, {
      ...base,
      messages: systemRealMessages,
    });
    const dialogueReal = await run749Probe('dialogue-real', targetUrl, requestInit, {
      ...base,
      messages: dialogueRealMessages,
    });
    return [minimal, shape, systemReal, dialogueReal];
  }

  const headerVariant = await run749Probe(
    'minimal-rikkahub-headers',
    targetUrl,
    requestInit,
    minimalBody,
    {
      Accept: 'text/event-stream',
      'X-Session-ID': 'sully-story-749-probe',
    },
  );
  return [minimal, headerVariant];
};

const annotateFailure = async (
  response: Response,
  requestBody: BodyInit | null | undefined,
  targetUrl: string,
  route: StoryEgressRoute,
  probes: Story749ProbeResult[] = [],
): Promise<Response> => {
  if (response.ok) return response;
  const original = await response.text().catch(() => '');
  const summary = summarizeRequest(requestBody, targetUrl, route);
  const diagnostic = {
    ...(probes.length > 0 ? { probe749: probes } : {}),
    ...summary,
  };
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store');

  // probe 独立放在完整诊断前，防止 App/云任务错误字段长度限制把最关键结果截掉。
  const probeLine = probes.length > 0
    ? `[sully_story_probe749] ${JSON.stringify(probes)}\n`
    : '';
  return new Response(
    `${original}${original ? '\n' : ''}${probeLine}[sully_story_diag] ${JSON.stringify(diagnostic)}`,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
};

/**
 * 剧情云端任务的统一模型出口。
 *
 * - 749：Worker 直连，避免 relay 出口改变 749 的上游路由。
 * - 其他上游未配置 relay：保持 Cloudflare Worker 直接请求模型上游。
 * - 其他上游 relay URL + token 同时配置：经 relay 出网。
 * - 只配置一半：明确失败，不偷偷回退 Cloudflare 直连。
 * - 最终发出前移除最大输出 token 字段、纯 0 penalty，并合并相邻 system 消息。
 * - 749 返回 429 时自动追加诊断探针，区分 headers、message shape、真实 system 与真实对话内容。
 */
export const fetchStoryUpstream = async (
  env: StoryEgressEnv,
  targetUrl: string,
  init: RequestInit,
): Promise<Response> => {
  const route = resolveStoryEgressRoute(env, targetUrl);
  const sanitizedBody = sanitizeStoryRequestBody(init.body);
  const requestInit: RequestInit = sanitizedBody === init.body
    ? init
    : { ...init, body: sanitizedBody };

  if (!route.relayed) {
    const response = await fetch(targetUrl, requestInit);
    const probes = response.status === 429 && is749Target(targetUrl)
      ? await run749429Probes(targetUrl, requestInit)
      : [];
    return annotateFailure(response, requestInit.body, targetUrl, route, probes);
  }

  const headers = new Headers(requestInit.headers || {});
  headers.set('X-Sully-Egress-Version', '1');
  headers.set('X-Sully-Egress-Target', targetUrl);
  headers.set('X-Sully-Egress-Token', String(env.STORY_EGRESS_RELAY_TOKEN || '').trim());

  const response = await fetch(route.url, {
    ...requestInit,
    headers,
  });
  return annotateFailure(response, requestInit.body, targetUrl, route);
};