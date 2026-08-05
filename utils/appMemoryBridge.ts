import type {
  APIConfig,
  AppMemoryCandidate,
  AppMemorySource,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { DB } from './db';
import {
  MemoryNodeDB,
  vectorizeAndStore,
  type MemoryNode,
  type MemoryRoom,
} from './memoryPalace';
import { callAppModel, parseFirstJsonObject } from './appContext';

const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const ROOM_SET = new Set<MemoryRoom>([
  'living_room',
  'bedroom',
  'study',
  'user_room',
  'self_room',
  'attic',
  'windowsill',
]);

const clamp = (n: unknown, min: number, max: number, fallback: number): number => {
  const value = Number(n);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
};

const normalizeRoom = (room: unknown, source: AppMemorySource): MemoryRoom => {
  const value = String(room || '') as MemoryRoom;
  if (ROOM_SET.has(value)) return value;
  return source === 'reading_together' ? 'study' : 'living_room';
};

const sanitizeTags = (tags: unknown, source: AppMemorySource): string[] => {
  const arr = Array.isArray(tags) ? tags : [];
  const cleaned = arr
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const sourceTag = source === 'simulator' ? '万象匣' : '素页同栖';
  return Array.from(new Set([sourceTag, ...cleaned]));
};

export interface GenerateCandidateInput {
  sourceApp: AppMemorySource;
  sourceRecordId: string;
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  apiConfig: APIConfig;
  realtimeConfig?: RealtimeConfig;
  transcript: string;
  sceneHint: string;
  signal?: AbortSignal;
}

/**
 * 一次调用生成候选卡。这里只落 `app_memory_candidates`，绝不写主聊天和主记忆。
 */
export async function generateAppMemoryCandidates(
  input: GenerateCandidateInput,
): Promise<AppMemoryCandidate[]> {
  const sourceName = input.sourceApp === 'simulator' ? '万象匣' : '素页同栖';
  const raw = await callAppModel({
    sourceApp: input.sourceApp,
    purpose: '整理候选记忆卡',
    char: input.char,
    userProfile: input.userProfile,
    groups: input.groups,
    apiConfig: input.apiConfig,
    realtimeConfig: input.realtimeConfig,
    sceneHint: input.sceneHint,
    signal: input.signal,
    temperature: 0.35,
    appSystemPrompt: `
你正在为“${sourceName}”的一段经历整理候选记忆卡。
这些卡片不会自动进入长期记忆，用户稍后会亲自勾选和编辑。

只保留未来真的值得角色记住的内容：
- 双方共同经历的重要事件；
- 明确的承诺、关系变化、情绪转折；
- 用户稳定的偏好、观点或雷区；
- 角色在互动中明确形成的新认识；
- 素页同栖中有长期意义的阅读观点或共同创作设定。

不要保存普通操作、游戏数值、无意义寒暄、每条批注、临时 UI 状态。
没有值得保存的内容时 cards 返回空数组。

严格只输出 JSON：
{
  "cards": [
    {
      "title": "12字以内",
      "summary": "完整、具体、可独立理解的记忆，使用角色可理解的自然叙述",
      "room": "living_room|bedroom|study|user_room|self_room|attic|windowsill",
      "tags": ["2到6个标签"],
      "importance": 1,
      "mood": "neutral",
      "valence": 0,
      "arousal": 0
    }
  ]
}
cards 最多 5 张。不要输出 Markdown。
`,
    localMessages: [
      {
        role: 'user',
        content: `[待整理的${sourceName}记录]\n${input.transcript.slice(0, 24000)}`,
      },
    ],
  });

  const parsed = parseFirstJsonObject(raw);
  const rows = Array.isArray(parsed?.cards) ? parsed.cards.slice(0, 5) : [];
  const now = Date.now();
  const candidates: AppMemoryCandidate[] = rows
    .map((row: any): AppMemoryCandidate | null => {
      const summary = String(row?.summary || '').trim();
      if (!summary) return null;
      return {
        id: id('appmem'),
        charId: input.char.id,
        sourceApp: input.sourceApp,
        sourceRecordId: input.sourceRecordId,
        title: String(row?.title || '一段共同经历').trim().slice(0, 40),
        summary: summary.slice(0, 1800),
        room: normalizeRoom(row?.room, input.sourceApp),
        tags: sanitizeTags(row?.tags, input.sourceApp),
        importance: Math.round(clamp(row?.importance, 1, 10, 5)),
        mood: String(row?.mood || 'neutral').trim().slice(0, 40),
        valence: clamp(row?.valence, -1, 1, 0),
        arousal: clamp(row?.arousal, -1, 1, 0),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
    })
    .filter((v: AppMemoryCandidate | null): v is AppMemoryCandidate => !!v);

  if (candidates.length > 0) {
    await DB.saveAppMemoryCandidates(candidates);
  }
  return candidates;
}

export interface CommitCandidateDeps {
  candidate: AppMemoryCandidate;
  char: CharacterProfile;
  userProfile: UserProfile;
  memoryPalaceConfig: {
    embedding?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      dimensions?: number;
    };
  };
  remoteVectorConfig?: any;
  updateCharacter: (
    id: string,
    updates:
      | Partial<CharacterProfile>
      | ((prev: CharacterProfile) => Partial<CharacterProfile>),
  ) => void | Promise<void>;
}

/**
 * 用户确认后，卡片进入主聊天 + 主记忆。
 * 直接向量化时不再触发 processNewMessages，避免同一件事被提取两遍。
 */
export async function commitAppMemoryCandidate(
  deps: CommitCandidateDeps,
): Promise<AppMemoryCandidate> {
  const { candidate, char, memoryPalaceConfig, remoteVectorConfig } = deps;
  if (candidate.status === 'committed') return candidate;

  const sourceLabel =
    candidate.sourceApp === 'simulator' ? '万象匣' : '素页同栖';
  const cardContent =
    `「${sourceLabel} · 记忆卡」\n` +
    `${candidate.title}\n` +
    `${candidate.summary}`;

  // 提交可重试：先按 candidateId 查重，避免“聊天已写入、记忆写入失败”后重试产生重复卡片。
  const existingMessage = (await DB.getMessagesByCharId(char.id, true)).find(
    message => message.type === 'app_memory_card' && message.metadata?.candidateId === candidate.id,
  );
  const chatMessageId = existingMessage?.id ?? await DB.saveMessage({
    charId: char.id,
    role: 'assistant',
    type: 'app_memory_card',
    content: cardContent,
    metadata: {
      appMemoryCard: true,
      sourceApp: candidate.sourceApp,
      sourceRecordId: candidate.sourceRecordId,
      candidateId: candidate.id,
      title: candidate.title,
      room: candidate.room,
      tags: candidate.tags,
      importance: candidate.importance,
      skipMemoryExtraction: true,
      memoryCommitted: true,
    },
    timestamp: Date.now(),
  } as any);

  // 确定性 ID 让失败重试覆盖同一节点，而不是继续制造副本。
  const memoryNodeId = `appnode_${candidate.id}`;
  const node: MemoryNode & {
    appSource?: AppMemorySource;
    appSourceRecordId?: string;
    appCandidateId?: string;
  } = {
    id: memoryNodeId,
    charId: char.id,
    content: candidate.summary,
    room: candidate.room,
    tags: candidate.tags,
    importance: candidate.importance,
    mood: candidate.mood,
    valence: candidate.valence,
    arousal: candidate.arousal,
    embedded: false,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    origin: 'system',
    appSource: candidate.sourceApp,
    appSourceRecordId: candidate.sourceRecordId,
    appCandidateId: candidate.id,
  };

  let wrotePalace = false;
  const emb = memoryPalaceConfig?.embedding;
  if (
    char.memoryPalaceEnabled &&
    emb?.baseUrl &&
    emb?.apiKey &&
    emb?.model &&
    emb?.dimensions
  ) {
    try {
      const result = await vectorizeAndStore(
        [node],
        {
          baseUrl: emb.baseUrl,
          apiKey: emb.apiKey,
          model: emb.model,
          dimensions: emb.dimensions,
        },
        remoteVectorConfig,
        { skipDedup: true },
      );
      wrotePalace = result.stored > 0 || result.skipped > 0;
    } catch (error) {
      console.error('[AppMemory] 向量写入失败，回落旧式记忆：', error);
    }
  }

  if (!wrotePalace) {
    // 没启用 Memory Palace 或 embedding 暂不可用：
    // 写入旧式 MemoryFragment，保证 ContextBuilder.buildCoreContext 能读到。
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
      2,
      '0',
    )}-${String(today.getDate()).padStart(2, '0')}`;
    const fragment = {
      id: `appfrag_${candidate.id}`,
      date,
      summary: `- [${sourceLabel}] ${candidate.summary}`,
      mood: 'app_card',
    };
    await deps.updateCharacter(char.id, (prev) => ({
      memories: (prev.memories || []).some(memory => memory.id === fragment.id)
        ? (prev.memories || [])
        : [...(prev.memories || []), fragment],
    }));
    // 仍保存未向量化节点，用户以后开启/重建向量时可被纳入。
    await MemoryNodeDB.save(node);
  }

  const committed: AppMemoryCandidate = {
    ...candidate,
    status: 'committed',
    committedAt: Date.now(),
    updatedAt: Date.now(),
    memoryNodeId,
    chatMessageId: typeof chatMessageId === 'number' ? chatMessageId : (chatMessageId as any)?.id,
  };
  await DB.saveAppMemoryCandidate(committed);
  return committed;
}

export async function dismissAppMemoryCandidate(
  candidate: AppMemoryCandidate,
): Promise<AppMemoryCandidate> {
  const next = {
    ...candidate,
    status: 'dismissed' as const,
    updatedAt: Date.now(),
  };
  await DB.saveAppMemoryCandidate(next);
  return next;
}

export async function updateAppMemoryCandidate(
  candidate: AppMemoryCandidate,
  patch: Partial<AppMemoryCandidate>,
): Promise<AppMemoryCandidate> {
  const next: AppMemoryCandidate = {
    ...candidate,
    ...patch,
    id: candidate.id,
    charId: candidate.charId,
    sourceApp: candidate.sourceApp,
    sourceRecordId: candidate.sourceRecordId,
    updatedAt: Date.now(),
  };
  await DB.saveAppMemoryCandidate(next);
  return next;
}

/** 前端合并，不额外调用 API。 */
export async function mergeAppMemoryCandidates(
  selected: AppMemoryCandidate[],
): Promise<AppMemoryCandidate> {
  if (selected.length < 2) throw new Error('至少选择两张卡片才能合并');
  const first = selected[0];
  const merged: AppMemoryCandidate = {
    ...first,
    id: id('appmem'),
    title: selected.map((v) => v.title).join(' / ').slice(0, 40),
    summary: selected.map((v) => v.summary).join('\n\n'),
    tags: Array.from(new Set(selected.flatMap((v) => v.tags))).slice(0, 8),
    importance: Math.max(...selected.map((v) => v.importance)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'pending',
  };
  await DB.saveAppMemoryCandidate(merged);
  await Promise.all(selected.map(dismissAppMemoryCandidate));
  return merged;
}
