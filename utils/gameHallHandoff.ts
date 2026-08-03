import type { APIConfig, CharacterProfile, UserProfile } from '../types';
import { DB } from './db';
import { processNewMessages } from './memoryPalace/pipeline';
import type {
  CharacterExternalAccount,
  GameHallHandoffLine,
  GameHallHandoffMeta,
  GameHallMessage,
  GameHallSession,
} from './gameHallTypes';
import { saveGameHallSession } from './gameHallStore';

interface MemoryConfigLike {
  embedding?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
  };
  lightLLM?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}

const roleLabel = (role: GameHallMessage['role']): string => {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '角色';
  if (role === 'tool') return '工具';
  return '系统';
};

/**
 * 主对话交接不复制登录凭证：不是打码，而是只保存账号引用。
 * 真凭证始终完整留在角色账号档案，由客户端调用时直接注入，避免模型抄错。
 */
const toHandoffLine = (message: GameHallMessage): GameHallHandoffLine => ({
  role: message.role,
  text: message.role === 'tool'
    ? message.content.replace(/\n+工具(?:完整)?返回：[\s\S]*$/u, '').trim()
    : message.content,
  toolName: message.toolName,
  accountRef: message.accountRef,
  createdAt: message.createdAt,
});

const unique = <T,>(values: T[]): T[] => Array.from(new Set(values));

export const buildGameHallHandoffMeta = (input: {
  session: GameHallSession;
  messages: GameHallMessage[];
  accounts: CharacterExternalAccount[];
  charName: string;
}): GameHallHandoffMeta => {
  const { session, messages, accounts, charName } = input;
  const after = session.lastHandoffMessageAt || 0;
  const fresh = messages.filter(message => message.createdAt > after);
  const source = fresh.length ? fresh : messages.slice(-30);
  const transcript = source.map(toHandoffLine);
  const accountRefs = unique([
    ...accounts.filter(account => account.status === 'active').map(account => account.accountRef),
    ...source.map(message => message.accountRef).filter((value): value is string => !!value),
  ]);
  const gameName = session.gameName || 'Cedar Toy';
  const userTurns = transcript.filter(line => line.role === 'user').length;
  const charTurns = transcript.filter(line => line.role === 'assistant').length;
  const toolTurns = transcript.filter(line => line.role === 'tool').length;
  const summary = `我和${charName}刚从${gameName}游戏厅回到主对话继续。刚才共有 ${userTurns} 条用户发言、${charTurns} 条角色回复、${toolTurns} 次工具结果；请直接承接下面的真实对话和未完话题。`;
  return {
    gameHallCard: true,
    sessionId: session.id,
    charId: session.charId,
    provider: 'cedar_toy',
    gameId: session.gameId,
    gameName: session.gameName,
    title: `游戏厅 · ${gameName}`,
    summary,
    transcript,
    accountRefs,
    createdAt: Date.now(),
  };
};

const buildMainChatContent = (meta: GameHallHandoffMeta): string => {
  const lines = meta.transcript.map(line => {
    const tool = line.toolName ? `(${line.toolName})` : '';
    const account = line.accountRef ? ` [账号档案：${line.accountRef}]` : '';
    return `${roleLabel(line.role)}${tool}：${line.text}${account}`;
  });
  return [
    `「${meta.title} · 交接」`,
    meta.summary,
    meta.accountRefs.length
      ? `已保存的角色账号档案：${meta.accountRefs.join('、')}。登录时直接读取账号档案，不要凭记忆重写凭证。`
      : '',
    '刚才在游戏厅的对话：',
    ...lines,
    '现在已经回到主对话，请从这里自然继续。',
  ].filter(Boolean).join('\n');
};

/**
 * 像「彼方」一样写入 messages 主表，并触发现有记忆宫殿管线。
 * 成功落主消息后才更新 session 水位，失败可再次点击，不会误消费交接。
 */
export async function createGameHallMainChatHandoff(input: {
  session: GameHallSession;
  messages: GameHallMessage[];
  accounts: CharacterExternalAccount[];
  char: CharacterProfile;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  memoryPalaceConfig?: MemoryConfigLike;
}): Promise<{ messageId: number; meta: GameHallHandoffMeta }> {
  const { session, messages, accounts, char, userProfile, apiConfig, memoryPalaceConfig } = input;
  const meta = buildGameHallHandoffMeta({
    session,
    messages,
    accounts,
    charName: char.name,
  });
  const content = buildMainChatContent(meta);
  const messageId = await DB.saveMessage({
    charId: char.id,
    role: 'assistant',
    type: 'game_hall_card' as any,
    content,
    metadata: meta,
  } as any);

  const latestMessageAt = messages.reduce(
    (max, message) => Math.max(max, message.createdAt),
    session.lastHandoffMessageAt || 0,
  );
  await saveGameHallSession({
    ...session,
    status: 'active',
    lastHandoffAt: Date.now(),
    lastHandoffMessageAt: latestMessageAt,
    updatedAt: Date.now(),
  });

  try {
    const embedding = memoryPalaceConfig?.embedding;
    const configuredLightLLM = memoryPalaceConfig?.lightLLM;
    const lightLLM = configuredLightLLM?.baseUrl
      ? configuredLightLLM
      : {
          baseUrl: apiConfig.baseUrl,
          apiKey: apiConfig.apiKey,
          model: apiConfig.model,
        };
    if (
      char.memoryPalaceEnabled &&
      embedding?.baseUrl &&
      embedding?.apiKey &&
      lightLLM.baseUrl
    ) {
      const recentMessages = await DB.getRecentMessagesByCharId(char.id, 50);
      void processNewMessages(
        recentMessages,
        char.id,
        char.name,
        embedding as any,
        lightLLM as any,
        userProfile?.name || '',
        false,
      ).catch(() => undefined);
    }
  } catch {
    // 交接卡已经写入主聊天；记忆整理失败不回滚主消息。
  }

  return { messageId, meta };
}
