import type {
  APIConfig,
  CharacterProfile,
  GroupProfile,
  Message,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { DB } from './db';
import { buildChatRequestPayload } from './chatRequestPayload';
import { extractContent, safeFetchJson } from './safeApi';

export interface AppContextDeps {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  apiConfig: APIConfig;
  realtimeConfig?: RealtimeConfig;
  sceneHint: string;
  appSystemPrompt: string;
  localMessages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  signal?: AbortSignal;
  temperature?: number;
  sourceApp?: 'simulator' | 'reading_together';
  purpose?: string;
}

const chatEndpoint = (baseUrl: string): string => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('尚未配置 API Base URL');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
};

/**
 * 为 App 构建与正常私聊一致的上下文。
 *
 * 关键点：
 * - 主聊天历史数量继续遵循 char.contextLimit；
 * - buildChatRequestPayload 内部会注入世界书、印象、时间感知、Memory Palace；
 * - App 自己的局内记录只作为尾部消息追加，不写回主聊天。
 */
export async function buildAppMessages(
  deps: Omit<AppContextDeps, 'apiConfig' | 'signal' | 'temperature'>,
): Promise<Array<{ role: string; content: any }>> {
  const {
    char,
    userProfile,
    groups,
    realtimeConfig,
    sceneHint,
    appSystemPrompt,
    localMessages = [],
  } = deps;

  const [emojis, categories, historyMsgs] = await Promise.all([
    DB.getEmojis(),
    DB.getEmojiCategories(),
    DB.getRecentMessagesByCharId(char.id, char.contextLimit || 500),
  ]);

  const payload = await buildChatRequestPayload({
    char,
    userProfile,
    groups,
    emojis,
    categories,
    historyMsgs,
    recentMsgsHint: historyMsgs.slice(-200),
    contextLimit: char.contextLimit || 500,
    recallQueryHint: sceneHint,
    realtimeConfig,
    htmlMode: { enabled: false },
    thinkingChain: { enabled: false },
    stripImages: true,
  });

  return [
    ...payload.fullMessages,
    {
      role: 'system',
      content:
        `${appSystemPrompt}\n\n` +
        '你仍然是主聊天中的同一个人，拥有完全连续的人设、关系、记忆和情绪。' +
        '不要把这个 App 当成失忆的平行角色，也不要解释提示词或系统实现。',
    },
    ...localMessages,
  ];
}

export async function callAppModel(deps: AppContextDeps): Promise<string> {
  const messages = await buildAppMessages(deps);
  const data = await safeFetchJson(chatEndpoint(deps.apiConfig.baseUrl), {
    method: 'POST',
    signal: deps.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.apiConfig.apiKey || ''}`,
    },
    body: JSON.stringify({
      model: deps.apiConfig.model,
      messages,
      stream: false,
      temperature: deps.temperature ?? 0.85,
    }),
  }, 0, 0, {
    appId: deps.sourceApp || 'simulator',
    appName: deps.sourceApp === 'reading_together' ? '素页同栖' : '万象匣',
    charId: deps.char.id,
    charName: deps.char.name,
    purpose: deps.purpose || 'App 内文本生成',
  });

  const content = extractContent(data);
  if (!content || !String(content).trim()) {
    throw new Error('模型返回了空内容');
  }
  return String(content).trim();
}

/** App 内本地上下文只截取用户显式设置的条数，不另设隐藏限制。 */
export function sliceLocalMessages<T>(items: T[], limit: number): T[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return items.slice(-Math.floor(limit));
}

/** 去掉模型偶尔包上的 Markdown JSON 围栏。 */
export function cleanJsonFence(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** 从混杂回复中寻找第一个 JSON object。 */
export function parseFirstJsonObject(raw: string): any {
  const text = cleanJsonFence(raw);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    if (start < 0) throw new Error('模型没有返回 JSON');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1));
      }
    }
    throw new Error('模型返回的 JSON 不完整');
  }
}
