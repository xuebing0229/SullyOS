export interface StoryEgressEnv {
  STORY_EGRESS_RELAY_URL?: string;
  STORY_EGRESS_RELAY_TOKEN?: string;
}

export interface StoryEgressRoute {
  url: string;
  relayed: boolean;
}

const STORY_749_GEMINI_SYSTEM_ANCHOR =
  'The final user message contains a <SULLY_SYSTEM_INSTRUCTIONS> block with the full system instructions for this request. Treat that block as the system instructions and follow it throughout the conversation.';

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
  // 749 目前由 Worker 直连；日本 relay 路径曾被该站上游拒绝为 OAuth 401。
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
    const previous = compacted[compacted.length - 1];
    if (
      message.role === 'system'
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
      if (Object.prototype.hasOwnProperty.call(parsed, key) && Number(parsed[key]) === 0) {
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

const isGeminiModel = (model: unknown): boolean => (
  typeof model === 'string' && model.toLowerCase().includes('gemini')
);

/**
 * 749 的 Gemini 兼容层会把 OpenAI `system` 映射到 Gemini system_instruction。
 * 实测同一份约 8 万字符的文游规则：system_instruction 稳定 429 RESOURCE_EXHAUSTED，
 * 原文改走 user 通道则 200；短 system 消息也能正常 200。
 *
 * 因此仅对 749 + Gemini：
 * - 保留一个很短的 system 锚点，维持“规则属于系统指令”的语义；
 * - 原 system 原文一字不删，按原顺序汇总进最终 user 消息的明确指令块；
 * - 非 system 对话顺序完全保持；
 * - 其他站子、749 的非 Gemini 模型完全不改。
 */
const apply749GeminiSystemCompatibility = (
  body: BodyInit | null | undefined,
  targetUrl: string,
): BodyInit | null | undefined => {
  if (!is749Target(targetUrl) || typeof body !== 'string') return body;

  const parsed = parseBodyRecord(body);
  if (!parsed || !isGeminiModel(parsed.model) || !Array.isArray(parsed.messages)) return body;

  const systemTextParts: string[] = [];
  const nonSystemMessages: Record<string, unknown>[] = [];
  let finalUserIndex = -1;

  for (const rawMessage of parsed.messages) {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return body;
    const message = rawMessage as Record<string, unknown>;

    if (message.role === 'system') {
      // 当前文游 system 均为纯文本；遇到复合内容时宁可保持原请求，也绝不静默丢内容。
      if (typeof message.content !== 'string') return body;
      systemTextParts.push(message.content);
      continue;
    }

    const cloned = { ...message };
    nonSystemMessages.push(cloned);
    if (cloned.role === 'user' && typeof cloned.content === 'string') {
      finalUserIndex = nonSystemMessages.length - 1;
    }
  }

  if (systemTextParts.length === 0 || finalUserIndex < 0) return body;

  const finalUser = nonSystemMessages[finalUserIndex];
  const originalUserContent = String(finalUser.content || '');
  const systemText = systemTextParts.join('\n\n');
  finalUser.content = [
    '<SULLY_SYSTEM_INSTRUCTIONS>',
    systemText,
    '</SULLY_SYSTEM_INSTRUCTIONS>',
    '',
    '<SULLY_CURRENT_USER_TURN>',
    originalUserContent,
    '</SULLY_CURRENT_USER_TURN>',
  ].join('\n');

  parsed.messages = [
    { role: 'system', content: STORY_749_GEMINI_SYSTEM_ANCHOR },
    ...nonSystemMessages,
  ];

  return JSON.stringify(parsed);
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
  let systemCompat749Gemini = false;

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

    if (message.role === 'system' && message.content === STORY_749_GEMINI_SYSTEM_ANCHOR) {
      systemCompat749Gemini = true;
    }

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

  const largestMessages = [...messageShapes]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);

  return {
    egress: route.relayed ? 'relay' : 'direct',
    targetHost: safeHost(targetUrl),
    relayHost: route.relayed ? safeHost(route.url) : undefined,
    systemCompat749Gemini,
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
 * - 749：Worker 直连，避免 relay 出口改变 749 的上游路由。
 * - 749 + Gemini：将大段 system 原文移到最终 user 指令块，只保留短 system 锚点，规避 749 的 system_instruction 429。
 * - 其他上游未配置 relay：保持 Cloudflare Worker 直接请求模型上游。
 * - 其他上游 relay URL + token 同时配置：经 relay 出网。
 * - 只配置一半：明确失败，不偷偷回退 Cloudflare 直连。
 * - 最终发出前移除最大输出 token 字段、纯 0 penalty，并合并相邻 system 消息。
 */
export const fetchStoryUpstream = async (
  env: StoryEgressEnv,
  targetUrl: string,
  init: RequestInit,
): Promise<Response> => {
  const route = resolveStoryEgressRoute(env, targetUrl);
  const sanitizedBody = sanitizeStoryRequestBody(init.body);
  const compatibleBody = apply749GeminiSystemCompatibility(sanitizedBody, targetUrl);
  const requestInit: RequestInit = compatibleBody === init.body
    ? init
    : { ...init, body: compatibleBody };

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
