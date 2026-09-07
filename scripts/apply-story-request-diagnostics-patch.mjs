import fs from 'node:fs';

const path = 'worker/amsg/src/storyJobs.ts';
let source = fs.readFileSync(path, 'utf8');

const replaceOnce = (before, after) => {
  const count = source.split(before).length - 1;
  if (count === 0 && source.includes(after)) return;
  if (count !== 1) throw new Error(`[story-request-diag] expected one match, got ${count}: ${JSON.stringify(before)}`);
  source = source.replace(before, after);
};

replaceOnce(
`interface StoryAttempt {\n  routeIndex: number;\n  presetId?: string;\n  presetName?: string;\n  baseUrl: string;\n  model: string;\n  ok: boolean;\n  status?: number;\n  error?: string;\n  durationMs: number;\n}`,
`interface StoryRequestShape {\n  egress: 'direct' | 'relay' | 'partial';\n  relayHost?: string;\n  requestBytes: number;\n  bodyKeys: string[];\n  messageCount: number;\n  messageChars: number;\n  roleCounts: { system: number; user: number; assistant: number; other: number };\n  lastMessageRole?: string;\n  stream?: boolean;\n  hasStreamOptions: boolean;\n  maxTokens?: number;\n  maxCompletionTokens?: number;\n  temperature?: number;\n  topP?: number;\n  frequencyPenalty?: number;\n  presencePenalty?: number;\n}\n\ninterface StoryAttempt {\n  routeIndex: number;\n  presetId?: string;\n  presetName?: string;\n  baseUrl: string;\n  model: string;\n  ok: boolean;\n  status?: number;\n  error?: string;\n  durationMs: number;\n  requestShape?: StoryRequestShape;\n}`,
);

replaceOnce(
`const jsonSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;\nconst now = (): number => Date.now();\nconst normalizeBaseUrl = (value: string): string => value.trim().replace(/\\/+$/, '');`,
`const jsonSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;\nconst now = (): number => Date.now();\nconst normalizeBaseUrl = (value: string): string => value.trim().replace(/\\/+$/, '');\n\nconst numericBodyField = (value: unknown): number | undefined => {\n  const parsed = Number(value);\n  return Number.isFinite(parsed) ? parsed : undefined;\n};\n\nconst summarizeStoryRequest = (env: StoryJobsEnv, body: Record<string, unknown>): StoryRequestShape => {\n  const relayUrl = String(env.STORY_EGRESS_RELAY_URL || '').trim();\n  const relayToken = String(env.STORY_EGRESS_RELAY_TOKEN || '').trim();\n  const messages = Array.isArray(body.messages) ? body.messages : [];\n  const roleCounts = { system: 0, user: 0, assistant: 0, other: 0 };\n  let messageChars = 0;\n  let lastMessageRole: string | undefined;\n  for (const item of messages) {\n    const message = item && typeof item === 'object' && !Array.isArray(item)\n      ? item as Record<string, unknown>\n      : {};\n    const role = String(message.role || '');\n    lastMessageRole = role || lastMessageRole;\n    if (role === 'system') roleCounts.system += 1;\n    else if (role === 'user') roleCounts.user += 1;\n    else if (role === 'assistant') roleCounts.assistant += 1;\n    else roleCounts.other += 1;\n    const content = message.content;\n    if (typeof content === 'string') messageChars += content.length;\n    else if (content != null) {\n      try { messageChars += JSON.stringify(content).length; } catch { /* diagnostics only */ }\n    }\n  }\n  let relayHost: string | undefined;\n  if (relayUrl) {\n    try { relayHost = new URL(relayUrl).host; } catch { relayHost = 'invalid-url'; }\n  }\n  return {\n    egress: relayUrl && relayToken ? 'relay' : relayUrl || relayToken ? 'partial' : 'direct',\n    ...(relayHost ? { relayHost } : {}),\n    requestBytes: jsonSize(body),\n    bodyKeys: Object.keys(body).sort(),\n    messageCount: messages.length,\n    messageChars,\n    roleCounts,\n    ...(lastMessageRole ? { lastMessageRole } : {}),\n    ...(typeof body.stream === 'boolean' ? { stream: body.stream } : {}),\n    hasStreamOptions: Boolean(body.stream_options && typeof body.stream_options === 'object'),\n    ...(numericBodyField(body.max_tokens) !== undefined ? { maxTokens: numericBodyField(body.max_tokens) } : {}),\n    ...(numericBodyField(body.max_completion_tokens) !== undefined ? { maxCompletionTokens: numericBodyField(body.max_completion_tokens) } : {}),\n    ...(numericBodyField(body.temperature) !== undefined ? { temperature: numericBodyField(body.temperature) } : {}),\n    ...(numericBodyField(body.top_p) !== undefined ? { topP: numericBodyField(body.top_p) } : {}),\n    ...(numericBodyField(body.frequency_penalty) !== undefined ? { frequencyPenalty: numericBodyField(body.frequency_penalty) } : {}),\n    ...(numericBodyField(body.presence_penalty) !== undefined ? { presencePenalty: numericBodyField(body.presence_penalty) } : {}),\n  };\n};`,
);

replaceOnce(
`    let routeRequest: StoryRouteRequest | null = null;\n    let explicitErrorText = '';`,
`    let routeRequest: StoryRouteRequest | null = null;\n    let explicitErrorText = '';\n    let lastRequestShape: StoryRequestShape | undefined;`,
);

replaceOnce(
`      } else {\n        delete body.stream_options;\n      }\n\n      const controller = new AbortController();`,
`      } else {\n        delete body.stream_options;\n      }\n      lastRequestShape = summarizeStoryRequest(env, body);\n\n      const controller = new AbortController();`,
);

replaceOnce(
`      } else {\n        delete body.stream_options;\n      }\n      lastRequestShape = summarizeStoryRequest(env, body);\n\n      const controller = new AbortController();`,
`      } else {\n        delete body.stream_options;\n      }\n\n      // Large imported story presets can contain 100+ consecutive system messages.\n      // OpenAI accepts that shape, but several Gemini-compatible relays translate every\n      // system message separately and can reject the resulting request as resource-exhausted.\n      // Merge only adjacent system messages; keep every character and the original order.\n      if (Array.isArray(body.messages)) {\n        const compacted: Array<Record<string, unknown>> = [];\n        for (const rawMessage of body.messages) {\n          if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {\n            compacted.push({ role: 'system', content: String(rawMessage ?? '') });\n            continue;\n          }\n          const message = rawMessage as Record<string, unknown>;\n          const role = String(message.role || '');\n          const content = message.content;\n          const previous = compacted[compacted.length - 1];\n          if (\n            role === 'system'\n            && previous?.role === 'system'\n            && typeof previous.content === 'string'\n            && typeof content === 'string'\n          ) {\n            previous.content = `${previous.content}\\n\\n${content}`;\n          } else {\n            compacted.push({ ...message });\n          }\n        }\n        body.messages = compacted;\n      }\n\n      lastRequestShape = summarizeStoryRequest(env, body);\n\n      const controller = new AbortController();`,
);

const attemptLine = `      const attempt = routeAttempt(route, index, attemptStartedAt);\n`;
const attemptCount = source.split(attemptLine).length - 1;
if (attemptCount !== 4) throw new Error(`[story-request-diag] expected 4 route attempts, got ${attemptCount}`);
const attemptWithShape = `${attemptLine}      attempt.requestShape = lastRequestShape;\n`;
if (!source.includes(attemptWithShape)) {
  source = source.split(attemptLine).join(attemptWithShape);
}

fs.writeFileSync(path, source);
console.log('[story-request-diag] patched worker/amsg/src/storyJobs.ts');
