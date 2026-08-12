import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { buildChatRequestPayload, type ChatPayloadMessage } from './chatRequestPayload';
import { loadCharacterContextRange } from './chatContextRange';
import { DB } from './db';
import { executeOpenAiChatPlan, resolveApiExecutionPlan } from './apiFailover';
import { liveId, type LiveEvent, type LiveRoom, type LiveSettings } from './liveTypes';

export interface LiveAiRuntime {
  apiConfig: APIConfig;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
}

const extractText = (value: any): string => {
  const content = value?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || '').join('');
  return '';
};

const parseJson = <T,>(text: string): T => {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  const objectEnd = cleaned.lastIndexOf('}');
  const arrayEnd = cleaned.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  if (start < 0 || end < start) throw new Error('直播 AI 没有返回可解析的 JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
};

const requestLiveAi = async (input: {
  runtime: LiveAiRuntime;
  purpose: string;
  instruction: string;
  character?: CharacterProfile;
  ephemeral?: ChatPayloadMessage[];
}): Promise<string> => {
  if (!input.runtime.apiConfig.baseUrl || !input.runtime.apiConfig.model) throw new Error('请先在设置中配置主聊天 API。');
  let messages: ChatPayloadMessage[];
  if (input.character) {
    const [range, recent, emojis, categories] = await Promise.all([
      loadCharacterContextRange(input.character),
      DB.getRecentMessagesByCharId(input.character.id, 200, true),
      DB.getEmojis(),
      DB.getEmojiCategories(),
    ]);
    const payload = await buildChatRequestPayload({
      char: input.character,
      userProfile: input.runtime.userProfile,
      groups: input.runtime.groups,
      emojis,
      categories,
      historyMsgs: range.messages,
      recentMsgsHint: recent,
      contextLimit: Math.max(1, range.messages.length),
      realtimeConfig: input.runtime.realtimeConfig,
      innerState: (input.character as any).innerState,
      translationConfig: { enabled: false, sourceLang: '中文', targetLang: '中文' },
      htmlMode: { enabled: false },
      thinkingChain: { enabled: false },
      ephemeralMessages: input.ephemeral || [],
      allowMcpChat: false,
      allowGameHallAutoplayControl: false,
    });
    messages = [...payload.fullMessages, { role: 'system', content: input.instruction }];
  } else {
    messages = [
      { role: 'system', content: '你是 SullyOS 直播内容引擎。只输出请求指定的 JSON，不要输出 markdown。' },
      ...(input.ephemeral || []),
      { role: 'user', content: input.instruction },
    ];
  }
  const plan = resolveApiExecutionPlan('chat', input.runtime.apiConfig, true);
  const result = await executeOpenAiChatPlan({
    plan,
    body: { model: input.runtime.apiConfig.model, messages, stream: false, temperature: input.runtime.apiConfig.temperature ?? 0.9 },
    meta: {
      appId: 'live', appName: '直播', purpose: input.purpose,
      charId: input.character?.id, charName: input.character?.name,
    },
    directMaxRetries: 2,
  });
  const text = extractText(result.value);
  if (!text.trim()) throw new Error('直播 AI 返回了空内容');
  return text;
};

const normalizeEvents = (roomId: string, source: any[], startAt = 0): LiveEvent[] => source
  .map((item, index) => ({
    id: liveId('event'), roomId,
    time: Math.max(startAt, Number(item?.time) || startAt + index),
    type: ['visual', 'danmu', 'gift', 'mic', 'system'].includes(item?.type) ? item.type : 'danmu',
    content: String(item?.content || '').trim(),
    user: item?.user ? String(item.user) : undefined,
    origin: 'ai' as const,
    createdAt: Date.now() + index,
  }))
  .filter(event => event.content);

export async function generateLiveRooms(input: {
  runtime: LiveAiRuntime;
  settings: LiveSettings;
  kind: 'recommend' | 'following';
  characters: CharacterProfile[];
}): Promise<LiveRoom[]> {
  const selected = input.kind === 'following'
    ? input.characters.filter(char => input.settings.followingCharacterIds.includes(char.id))
    : [];
  if (input.kind === 'following' && !selected.length) return [];
  const worldview = input.kind === 'following' ? input.settings.followingWorldview : input.settings.recommendWorldview;
  if (input.kind === 'following') {
    const rooms: LiveRoom[] = [];
    for (const character of selected) {
      const text = await requestLiveAi({
        runtime: input.runtime,
        purpose: '关注直播列表生成',
        character,
        instruction: `根据你的完整人设、世界书、记忆宫殿召回和近期聊天，决定你此刻最可能在播什么。
直播世界观：${worldview || '现代日常世界'}
额外要求：${input.settings.globalPrompt || '自然、有生活感'}
只输出 JSON 对象：{"title":"","category":"","coverText":"","viewerCount":123}。`,
      });
      const row = parseJson<any>(text);
      const now = Date.now();
      rooms.push({
        id: liveId('room'), kind: 'following', characterId: character.id,
        streamerName: character.name, streamerAvatar: character.avatar,
        title: String(row.title || '随便聊聊'), category: String(row.category || '聊天'),
        coverText: String(row.coverText || '直播进行中'), viewerCount: Math.max(1, Number(row.viewerCount) || 100),
        followed: true, status: 'preview', rank: [], currentTime: 0,
        duration: input.settings.duration, createdAt: now, updatedAt: now,
      });
    }
    return rooms;
  }
  const instruction = `生成 12 个正在直播的房间。
世界观：${worldview || '现代日常世界'}
额外要求：${input.settings.globalPrompt || '自然、有生活感，不要全部围绕用户'}
主播是各有生活的虚构路人。
只输出 JSON 数组，每项字段：characterId(路人可省略)、streamerName、title、category、coverText、viewerCount。`;
  const text = await requestLiveAi({ runtime: input.runtime, purpose: '推荐直播列表生成', instruction });
  const rows = parseJson<any[]>(text);
  return rows.slice(0, 20).map((row, index) => {
    const char = selected.find(item => item.id === row.characterId);
    const now = Date.now();
    return {
      id: liveId('room'), kind: 'recommend', characterId: char?.id,
      streamerName: char?.name || String(row.streamerName || `主播${index + 1}`),
      streamerAvatar: char?.avatar,
      title: String(row.title || '随便聊聊'), category: String(row.category || '聊天'),
      coverText: String(row.coverText || '直播进行中'), viewerCount: Math.max(1, Number(row.viewerCount) || Math.floor(Math.random() * 9000 + 100)),
      followed: false, status: 'preview' as const, rank: [], currentTime: 0,
      duration: input.settings.duration, createdAt: now, updatedAt: now,
    };
  });
}

export async function generateLiveTimeline(input: {
  runtime: LiveAiRuntime;
  settings: LiveSettings;
  room: LiveRoom;
  character?: CharacterProfile;
  startAt?: number;
  trigger?: string;
  history?: LiveEvent[];
}): Promise<LiveEvent[]> {
  const startAt = input.startAt || 0;
  const duration = input.trigger ? 45 : input.settings.duration;
  const recent = (input.history || []).slice(-25).map(e => `${e.time}s ${e.type} ${e.user || ''}: ${e.content}`).join('\n');
  const instruction = `你正在生成文字直播时间轴。主播：${input.room.streamerName}；标题：${input.room.title}；分类：${input.room.category}。
直播世界观：${(input.room.kind === 'following' ? input.settings.followingWorldview : input.settings.recommendWorldview) || '现代日常'}
额外要求：${input.settings.globalPrompt || '自然推进，画面与弹幕互相呼应'}
${recent ? `已经发生：\n${recent}` : ''}
${input.trigger ? `刚刚发生的用户互动：${input.trigger}。从 ${startAt + 1} 秒开始重写未来，主播与观众要对此作出自然反应。` : ''}
生成约 ${duration} 秒内容。每 4～8 秒至少一个 visual，每 1～4 秒若干 danmu；不要替用户本人发言。
只输出 JSON 数组：[{'time':${startAt},'type':'visual|danmu','user':'弹幕昵称(visual省略)','content':'内容'}]。`;
  const text = await requestLiveAi({
    runtime: input.runtime,
    purpose: input.trigger ? '直播互动改写未来' : input.character ? '好友直播脚本生成' : '直播脚本生成',
    instruction,
    character: input.character,
  });
  return normalizeEvents(input.room.id, parseJson<any[]>(text), startAt);
}

export async function generateMyLiveReactions(input: {
  runtime: LiveAiRuntime;
  room: LiveRoom;
  characters: CharacterProfile[];
  action: string;
  currentTime: number;
  history: LiveEvent[];
}): Promise<LiveEvent[]> {
  const history = input.history.slice(-20).map(e => `${e.user || e.type}:${e.content}`).join('；');
  const instruction = `用户正在自己的直播间担任主播。直播标题：${input.room.title}。
主播刚刚说/做：${input.action}
结合此前直播：${history}
生成 8～14 条路人观众反应，允许少量 gift 事件。绝对不要替主播继续说话或行动。
只输出 JSON 数组，字段 time、type(danmu|gift)、user、content，从 ${input.currentTime + 1} 秒开始。`;
  const text = await requestLiveAi({ runtime: input.runtime, purpose: '我开直播观众反应', instruction });
  const reactions = normalizeEvents(input.room.id, parseJson<any[]>(text), input.currentTime + 1);
  for (const character of input.characters) {
    const characterText = await requestLiveAi({
      runtime: input.runtime,
      character,
      purpose: '我开直播角色观众反应',
      instruction: `你正在看用户的直播。标题：${input.room.title}。用户刚刚说/做：${input.action}。
结合你的完整人设、世界书、记忆宫殿召回和近期聊天，用你自己的口吻发 2～5 条弹幕，偶尔可送一个礼物。不要替主播行动。
只输出 JSON 数组，字段 time、type(danmu|gift)、user（必须是 ${character.name}）、content，从 ${input.currentTime + 1} 秒开始。`,
    });
    reactions.push(...normalizeEvents(input.room.id, parseJson<any[]>(characterText), input.currentTime + 1));
  }
  return reactions.sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
}
