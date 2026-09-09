export interface StoryEgressEnv {
  STORY_EGRESS_RELAY_URL?: string;
  STORY_EGRESS_RELAY_TOKEN?: string;
}

export interface StoryEgressRoute {
  url: string;
  relayed: boolean;
}

const normalizeRelayUrl = (value: string): string => value.trim();

const shouldBypassStoryRelay = (targetUrl: string): boolean => {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return host === '749code.com' || host.endsWith('.749code.com');
  } catch {
    return false;
  }
};

export const resolveStoryEgressRoute = (
  env: StoryEgressEnv,
  targetUrl: string,
): StoryEgressRoute => {
  // 749 对出口来源较敏感；主聊天 / RikkaHub 直连正常而 relay 路径出现上游 OAuth 401。
  // 文游后台对该站恢复旧的 Worker 直连行为，避免日本 relay 改变 749 的上游路由选择。
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

const stripStoryOutputLimits = (
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

const summarizeRequest = (
  body: BodyInit | null | undefined,
  targetUrl: string,
  route: StoryEgressRoute,
): Record<string, unknown> => {
  const raw = typeof body === 'string' ? body : '';
  let parsed: Record<string, unknown> = {};
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // Only report shape; never include raw request content.
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const roleCounts: Record<string, number> = {};
  let messageTextChars = 0;
  const contentKinds = new Set<string>();
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    const role = String(message.role || 'unknown');
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    messageTextChars += textLength(message.content);
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
  }

  const safeHost = (value: string): string => {
    try { return new URL(value).host; } catch { return 'invalid-url'; }
  };

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
    contentKinds: [...contentKinds].sort(),
  };
};

const annotateFailure = async (
  response: Response,
  requestBody: BodyInit | null | undefined,
  targetUrl: string,
  route: StoryEgressRoute,
): Promise<Response> => {
  if (response.ok) return response;
  const original = await response.text().catch(() => '');
  const diagnostic = summarizeRequest(requestBody, targetUrl, route);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store');
  return new Response(
    `${original}${original ? '\n' : ''}[sully_story_diag] ${JSON.stringify(diagnostic)}`,
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
 * - 749：恢复 Worker 直连，避免 relay 出口触发与其他前端不同的上游鉴权路径。
 * - 其他上游未配置 relay：保持 Cloudflare Worker 直接请求模型上游。
 * - 其他上游 relay URL + token 同时配置：经 relay 出网。
 * - 只配置一半：明确失败，不偷偷回退 Cloudflare 直连。
 * - 所有文游上游请求：最终发出前移除最大输出 token 字段，与 RikkaHub 默认请求形状一致。
 */
export const fetchStoryUpstream = async (
  env: StoryEgressEnv,
  targetUrl: string,
  init: RequestInit,
): Promise<Response> => {
  const route = resolveStoryEgressRoute(env, targetUrl);
  const strippedBody = stripStoryOutputLimits(init.body);
  const requestInit: RequestInit = strippedBody === init.body
    ? init
    : { ...init, body: strippedBody };

  if (!route.relayed) {
    const response = await fetch(targetUrl, requestInit);
    return annotateFailure(response, requestInit.body, targetUrl, route);
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
