import type { APIConfig, CharacterProfile, UserProfile } from '../types';
import { DB } from './db';
import { safeResponseJson } from './safeApi';
import type { GameHallApiIdentity } from './gameHallAiSettings';
import { processNewMessages } from './memoryPalace/pipeline';
import type {
  CharacterExternalAccount,
  GameHallHandoffLine,
  GameHallHandoffMeta,
  GameHallMessage,
  GameHallSession,
} from './gameHallTypes';
import { commitGameHallHandoff, gameHallId } from './gameHallStore';
import { formatGameHallToolResult, getGameHallToolResultPayload } from './gameHallAccount';

type GameHallRequestMeta = {
  appId: string;
  appName: string;
  charId: string;
  charName: string;
  purpose: string;
  apiPresetId?: string;
  apiPresetName?: string;
};

interface MemoryConfigLike {
  embedding?: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number };
  lightLLM?: { baseUrl?: string; apiKey?: string; model?: string };
}

type ProgressStage =
  | 'summarizing'
  | 'saving-images'
  | 'saving-card'
  | 'updating-session'
  | 'deleting-source'
  | 'done';

const unique = <T,>(values: T[]): T[] => Array.from(new Set(values));

const sourceMessagesForHandoff = (
  session: GameHallSession,
  messages: GameHallMessage[],
): GameHallMessage[] => {
  const after = session.lastHandoffMessageAt || 0;
  const excludedTurnIds = new Set([
    session.openTurnId,
    session.activeReplyTurn?.turnId,
  ].filter((value): value is string => !!value));
  return [...messages]
    .filter(message => message.createdAt > after)
    .filter(message => !message.turnId || !excludedTurnIds.has(message.turnId))
    .sort((a, b) => a.createdAt - b.createdAt);
};

const sourceLine = (message: GameHallMessage): string => {
  const who = message.role === 'user' ? '用户'
    : message.role === 'assistant' ? '角色'
      : message.role === 'tool' ? `工具${message.toolName ? `(${message.toolName})` : ''}`
        : '系统';
  const image = message.image ? `\n[附图：${message.image.fileName || '游戏厅图片'}]` : '';
  const request = message.toolRequest ? `\n工具请求：${JSON.stringify(message.toolRequest)}` : '';
  const result = message.toolResult
    ? `\n工具完整返回：${formatGameHallToolResult(getGameHallToolResultPayload(message.toolResult))}`
    : '';
  const content = message.displayType === 'emoji'
    ? `[表情包：${message.emojiName || '未知'}]`
    : message.content;
  return `${who}：${content}${image}${request}${result}`;
};

const summarizeHandoff = async (input: {
  source: GameHallMessage[];
  char: CharacterProfile;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  apiIdentity?: GameHallApiIdentity;
  accounts: CharacterExternalAccount[];
  gameName: string;
}): Promise<string> => {
  const { source, char, userProfile, apiConfig, apiIdentity, accounts, gameName } = input;
  if (!apiConfig.baseUrl || !apiConfig.model) throw new Error('没有可用的聊天 API，无法完成游戏厅交接总结。原文未删除。');
  const accountRefs = accounts.filter(account => account.status === 'active').map(account => account.accountRef);
  const parts: any[] = [{
    type: 'text',
    text: `请把下面这段完整游戏厅记录总结成一份可直接交给主对话继续聊的中文交接摘要。
角色：${char.name}；用户：${userProfile?.name || '用户'}；游戏：${gameName}。
必须写清：刚才做了什么、聊了什么、已经达成的约定、尚未完成的话题、游戏/账号当前状态、回主聊天后应从哪里继续。
账号档案引用：${accountRefs.join('、') || '无'}。工具请求、返回和账号相关内容都按原记录理解，不做脱敏或刻意省略；只在确实与后续继续有关时写进摘要。
不要虚构，不要省略重要失败与未完成事项。只输出交接摘要正文。

完整记录：
${source.map(sourceLine).join('\n\n')}`,
  }];
  source.forEach(message => {
    if (message.image?.visionDataUrl) {
      parts.push({ type: 'image_url', image_url: { url: message.image.visionDataUrl } });
    }
  });
  const body: Record<string, unknown> = {
    model: apiConfig.model,
    messages: [{ role: 'user', content: parts }],
    stream: apiConfig.stream === true,
  };
  if (typeof apiConfig.temperature === 'number' && Number.isFinite(apiConfig.temperature)) {
    body.temperature = apiConfig.temperature;
  }
  const meta: GameHallRequestMeta = {
    appId: 'game-hall',
    appName: '游戏厅',
    charId: char.id,
    charName: char.name,
    purpose: '回主对话交接总结',
    apiPresetId: apiIdentity?.presetId,
    apiPresetName: apiIdentity?.presetName,
  };
  const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
    body: JSON.stringify(body),
    __sullyMeta: meta,
  } as RequestInit);
  if (!response.ok) throw new Error(`游戏厅交接总结失败：HTTP ${response.status}。原文未删除。`);
  const data = await safeResponseJson(response);
  const summary = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!summary) throw new Error('游戏厅交接总结没有返回正文。原文未删除。');
  return summary;
};

export const buildGameHallHandoffMeta = (input: {
  session: GameHallSession;
  sourceMessages: GameHallMessage[];
  accounts: CharacterExternalAccount[];
  summary: string;
  transferredImageCount: number;
}): GameHallHandoffMeta => {
  const { session, sourceMessages, accounts, summary, transferredImageCount } = input;
  const accountRefs = unique([
    ...accounts.filter(account => account.status === 'active').map(account => account.accountRef),
    ...sourceMessages.map(message => message.accountRef).filter((value): value is string => !!value),
  ]);
  const summaryLines: GameHallHandoffLine[] = summary
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((text, index) => ({
      role: 'assistant' as const,
      text,
      createdAt: Date.now() + index,
    }));
  return {
    gameHallCard: true,
    handoffId: gameHallId('ghhandoff'),
    sessionId: session.id,
    charId: session.charId,
    provider: 'cedar_toy',
    gameId: session.gameId,
    gameName: session.gameName,
    title: `游戏厅 · ${session.gameName || 'Cedar Toy'}`,
    summary,
    transcript: summaryLines,
    accountRefs,
    sourceMessageIds: sourceMessages.map(message => message.id),
    sourceMessageCount: sourceMessages.length,
    transferredImageCount,
    createdAt: Date.now(),
  };
};

export async function createGameHallMainChatHandoff(input: {
  session: GameHallSession;
  messages: GameHallMessage[];
  accounts: CharacterExternalAccount[];
  char: CharacterProfile;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  apiIdentity?: GameHallApiIdentity;
  memoryPalaceConfig?: MemoryConfigLike;
  onProgress?: (stage: ProgressStage, text: string) => void;
}): Promise<{
  messageId: number;
  meta: GameHallHandoffMeta;
  deletedMessageIds: string[];
  transferredImageMessageIds: number[];
  lastHandoffMessageAt: number;
}> {
  const { session, messages, accounts, char, userProfile, apiConfig, apiIdentity, memoryPalaceConfig, onProgress } = input;
  const source = sourceMessagesForHandoff(session, messages);
  if (!source.length) throw new Error('没有新的游戏厅原文需要交接。');

  onProgress?.('summarizing', `正在总结 ${source.length} 条游戏厅原文…`);
  const summary = await summarizeHandoff({
    source,
    char,
    userProfile,
    apiConfig,
    apiIdentity,
    accounts,
    gameName: session.gameName || 'Cedar Toy',
  });

  const transferredImageMessageIds: number[] = [];
  let cardMessageId: number | null = null;
  let sourceDeleted = false;
  try {
    const imageSources = source.filter(message => !!message.image);
    if (imageSources.length) onProgress?.('saving-images', `正在把 ${imageSources.length} 张图片带入主对话…`);
    for (const message of imageSources) {
      const image = message.image!;
      const id = await DB.saveMessage({
        charId: char.id,
        role: message.role === 'assistant' ? 'assistant' : 'user',
        type: 'image',
        content: image.displayDataUrl,
        metadata: {
          visionImageDataUrl: image.visionDataUrl,
          isAnimatedGif: image.isAnimatedGif,
          source: 'game_hall_handoff',
          gameHallSessionId: session.id,
          gameHallMessageId: message.id,
        },
      } as any);
      transferredImageMessageIds.push(id);
    }

    const meta = buildGameHallHandoffMeta({
      session,
      sourceMessages: source,
      accounts,
      summary,
      transferredImageCount: transferredImageMessageIds.length,
    });
    onProgress?.('saving-card', '正在把交接摘要写入主对话…');
    cardMessageId = await DB.saveMessage({
      charId: char.id,
      role: 'assistant',
      type: 'game_hall_card' as any,
      content: summary,
      metadata: meta,
    } as any);

    const latestMessageAt = source.reduce((max, message) => Math.max(max, message.createdAt), session.lastHandoffMessageAt || 0);
    const committedSession: GameHallSession = {
      ...session,
      status: 'active',
      lastHandoffAt: Date.now(),
      lastHandoffMessageAt: latestMessageAt,
      updatedAt: Date.now(),
    };

    // 最终关键步骤：会话确认与精确删除原文在同一个 IndexedDB 事务内提交。
    // 任一步失败都会整体回滚，随后 catch 再回滚本次写入主聊天的卡片和图片。
    onProgress?.('updating-session', '正在确认交接记录…');
    onProgress?.('deleting-source', `正在清理已交接的 ${source.length} 条游戏厅原文…`);
    await commitGameHallHandoff(committedSession, meta.sourceMessageIds);
    sourceDeleted = true;
    onProgress?.('done', '交接完成，已进入主对话。');

    try {
      const embedding = memoryPalaceConfig?.embedding;
      const configuredLightLLM = memoryPalaceConfig?.lightLLM;
      const lightLLM = configuredLightLLM?.baseUrl ? configuredLightLLM : {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
      };
      if (char.memoryPalaceEnabled && embedding?.baseUrl && embedding?.apiKey && lightLLM.baseUrl) {
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
      // 卡片已进入正常主聊天；记忆宫殿以后仍可按普通消息继续处理。
    }

    return {
      messageId: cardMessageId!,
      meta,
      deletedMessageIds: meta.sourceMessageIds,
      transferredImageMessageIds,
      lastHandoffMessageAt: latestMessageAt,
    };
  } catch (error) {
    // 删除原文前任何一步失败：回滚本次主聊天卡/图片，原文保持原样，可安全重试。
    if (!sourceDeleted) {
      const rollbackIds = [
        ...(cardMessageId == null ? [] : [cardMessageId]),
        ...transferredImageMessageIds,
      ];
      if (rollbackIds.length) await DB.deleteMessages(rollbackIds).catch(() => undefined);
    }
    throw error;
  }
}
