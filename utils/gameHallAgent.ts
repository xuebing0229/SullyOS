import type {
  APIConfig,
  CharacterProfile,
  Emoji,
  EmojiCategory,
  GroupProfile,
  Message,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { safeResponseJson } from './safeApi';
import type { GameHallApiIdentity } from './gameHallAiSettings';
import { buildChatRequestPayload, type ChatPayloadMessage } from './chatRequestPayload';
import { loadCharacterContextRange } from './chatContextRange';
import { DB } from './db';
import { toCedarMcpServer } from './cedarToyMcpAdapter';
import { callMcpTool, type McpServerConfig, type McpToolDef, type McpToolResult } from './mcpClient';
import type {
  CedarToyConnection,
  CharacterExternalAccount,
  GameHallCompanionMode,
  GameHallMessage,
  GameHallPendingAction,
  GameHallSchemaValidationMode,
  GameHallToolRequestSnapshot,
  NormalizedCedarGameState,
} from './gameHallTypes';
import { gameHallId } from './gameHallStore';
import {
  formatGameHallToolResult,
  getGameHallToolResultPayload,
  injectCharacterAccountIntoAction,
  isCredentialFieldName,
} from './gameHallAccount';
import { selectGameHallContext, type GameHallContextSelection } from './gameHallContext';
import { buildAssistantDisplayResult, splitAssistantDisplayParts, type AssistantDisplayPart } from './assistantDisplayPipeline';

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const hashGameHallState = (value: unknown): string => {
  let hash = 2166136261;
  for (const char of stableJson(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const stringifyFull = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

export const summarizeGameHallToolResult = (result: McpToolResult): string =>
  formatGameHallToolResult(getGameHallToolResultPayload(result));

const accountListForPrompt = (accounts: CharacterExternalAccount[] | undefined): string => {
  const active = (accounts || []).filter(account => account.status === 'active');
  if (!active.length) return '无已保存账号';
  return active.map(account => JSON.stringify({
    accountRef: account.accountRef,
    provider: account.provider,
    accountId: account.accountId,
    username: account.username,
    serverUrl: account.serverUrl,
    identityEndpoint: account.identityEndpoint,
    credentials: account.credentials,
  })).join('\n');
};

const messageText = (message: GameHallMessage): string => {
  const result = message.toolResult
    ? `\n完整工具返回：${formatGameHallToolResult(getGameHallToolResultPayload(message.toolResult))}`
    : message.toolResultSummary ? `\n工具返回：${message.toolResultSummary}` : '';
  const request = message.toolRequest ? `\n完整工具请求：${stringifyFull(message.toolRequest)}` : '';
  return `${message.content || ''}${request}${result}`.trim();
};

const toPayloadMessage = (message: GameHallMessage): ChatPayloadMessage => {
  const prefix = message.role === 'tool'
    ? `[游戏厅工具${message.toolName ? ` ${message.toolName}` : ''}] `
    : message.role === 'system' ? '[游戏厅系统记录] ' : '';
  const text = `${prefix}${messageText(message) || (message.image ? '[图片]' : '')}`;
  const role: ChatPayloadMessage['role'] = message.role === 'assistant' ? 'assistant' : 'user';
  if (!message.image) return { role, content: text };
  return {
    role,
    content: [
      { type: 'text', text: text || '[发送了一张图片]' },
      { type: 'image_url', image_url: { url: message.image.visionDataUrl } },
    ],
  };
};

const loadTranslationConfig = (charId: string) => {
  try {
    return {
      enabled: JSON.parse(localStorage.getItem(`chat_translate_enabled_${charId}`) || 'false'),
      sourceLang: localStorage.getItem(`chat_translate_source_lang_${charId}`)
        || localStorage.getItem('chat_translate_source_lang') || '日本語',
      targetLang: localStorage.getItem(`chat_translate_lang_${charId}`)
        || localStorage.getItem('chat_translate_lang') || '中文',
    };
  } catch {
    return { enabled: false, sourceLang: '日本語', targetLang: '中文' };
  }
};

interface FullContextInput {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
  gameHallMessages: GameHallMessage[];
  finalInstruction: string;
}

/** 游戏厅不再另写缩水人设；直接复用主聊天完整 payload 构造链。 */
const buildGameHallFullMessages = async (input: FullContextInput): Promise<ChatPayloadMessage[]> => {
  const [range, recent, emojis, categories] = await Promise.all([
    loadCharacterContextRange(input.char),
    DB.getRecentMessagesByCharId(input.char.id, 200, true),
    DB.getEmojis(),
    DB.getEmojiCategories(),
  ]);
  const historyMsgs = range.messages as Message[];
  const payload = await buildChatRequestPayload({
    char: input.char,
    userProfile: input.userProfile,
    groups: input.groups,
    emojis: emojis as Emoji[],
    categories: categories as EmojiCategory[],
    historyMsgs,
    recentMsgsHint: recent,
    contextLimit: Math.max(1, historyMsgs.length),
    realtimeConfig: input.realtimeConfig,
    innerState: (input.char as any).innerState,
    translationConfig: loadTranslationConfig(input.char.id),
    htmlMode: {
      enabled: !!(input.char as any).htmlModeEnabled,
      customPrompt: (input.char as any).htmlModeCustomPrompt,
    },
    thinkingChain: {
      enabled: !!(input.char as any).showThinkingChain,
      customPrompt: (input.char as any).thinkingChainCustomPrompt,
    },
    ephemeralMessages: input.gameHallMessages.map(toPayloadMessage),
    allowMcpChat: false,
    allowGameHallAutoplayControl: false,
  });
  return [
    ...payload.fullMessages,
    { role: 'system', content: input.finalInstruction },
  ];
};

const extractAssistantText = (data: any): string => {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => typeof part === 'string' ? part : part?.text || '').join('');
  }
  return '';
};

interface GameHallAgentResponse {
  data: any;
  content: string;
  reasoningContent?: string;
}

type GameHallRequestMeta = {
  appId: string;
  appName: string;
  charId: string;
  charName: string;
  purpose: string;
  apiPresetId?: string;
  apiPresetName?: string;
};

const requestAgent = async (
  apiConfig: APIConfig,
  messages: ChatPayloadMessage[],
  meta: GameHallRequestMeta,
): Promise<GameHallAgentResponse> => {
  const body: Record<string, unknown> = {
    model: apiConfig.model,
    messages,
    stream: apiConfig.stream === true,
  };
  if (typeof apiConfig.temperature === 'number' && Number.isFinite(apiConfig.temperature)) {
    body.temperature = apiConfig.temperature;
  }
  const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
    body: JSON.stringify(body),
    __sullyMeta: meta,
  } as RequestInit);
  if (!response.ok) throw new Error(`游戏厅 Agent HTTP ${response.status}`);
  const data = await safeResponseJson(response);
  const message = data?.choices?.[0]?.message || {};
  return {
    data,
    content: extractAssistantText(data),
    reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
  };
};

const gameHallApiMeta = (input: {
  char: CharacterProfile;
  purpose: string;
  apiIdentity?: GameHallApiIdentity;
}): GameHallRequestMeta => ({
  appId: 'game-hall',
  appName: '游戏厅',
  charId: input.char.id,
  charName: input.char.name,
  purpose: input.purpose,
  apiPresetId: input.apiIdentity?.presetId,
  apiPresetName: input.apiIdentity?.presetName,
});

const parseAgentJson = (text: string): any => {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
};

export const parseGameHallAgentDisplay = (input: {
  rawContent: string;
  reasoningContent?: string;
  showThinkingChain: boolean;
}): { parsed: any; replies: AssistantDisplayPart[]; thinkingChain?: string; cleanedContent: string } => {
  const display = buildAssistantDisplayResult(input);
  const parsed = parseAgentJson(display.cleanedContent);
  if (!parsed) throw new Error('游戏厅回复格式解析失败');
  const replySources = Array.isArray(parsed.replies)
    ? parsed.replies
    : parsed.reply != null ? [parsed.reply] : [];
  return {
    parsed,
    replies: replySources.flatMap((source: unknown) => splitAssistantDisplayParts(String(source || ''))),
    thinkingChain: display.thinkingChain,
    cleanedContent: display.cleanedContent,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const valueTypeMatches = (type: string, value: unknown): boolean => {
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
};

const validateSchemaValue = (
  schema: any,
  value: unknown,
  path: string,
  errors: string[],
  allowedMissing: Set<string>,
): void => {
  if (!schema || typeof schema !== 'object') return;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type: string) => valueTypeMatches(type, value))) {
    errors.push(`${path} 类型应为 ${types.join('|')}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => stableJson(item) === stableJson(value))) {
    errors.push(`${path} 只能是 ${schema.enum.map((item: unknown) => JSON.stringify(item)).join('、')}`);
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key: unknown): key is string => typeof key === 'string') : [];
    for (const key of required) {
      if ((value[key] === undefined || value[key] === '') && !allowedMissing.has(key)) errors.push(`${path}.${key} 为必填字段`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(`${path}.${key} 不是 schema 声明字段`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateSchemaValue(properties[key], child, `${path}.${key}`, errors, allowedMissing);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateSchemaValue(schema.items, item, `${path}[${index}]`, errors, allowedMissing));
  }
};

export const validateGameHallToolArgs = (
  tool: McpToolDef,
  args: Record<string, unknown>,
  accountRef?: string,
): string[] => {
  const errors: string[] = [];
  const allowedMissing = new Set<string>();
  if (accountRef && Array.isArray(tool.inputSchema?.required)) {
    tool.inputSchema.required
      .filter((key: unknown): key is string => typeof key === 'string' && isCredentialFieldName(key))
      .forEach((key: string) => allowedMissing.add(key));
  }
  validateSchemaValue(tool.inputSchema || { type: 'object' }, args, 'args', errors, allowedMissing);
  return errors;
};

const resolveTool = (
  tools: McpToolDef[],
  action: any,
): { tool?: McpToolDef; toolIndex?: number; warnings: string[] } => {
  const warnings: string[] = [];
  const requestedIndex = Number.isInteger(action?.toolIndex) ? Number(action.toolIndex) : undefined;
  if (requestedIndex !== undefined && requestedIndex >= 0 && requestedIndex < tools.length) {
    const tool = tools[requestedIndex];
    if (action?.toolName && action.toolName !== tool.name) warnings.push(`toolIndex ${requestedIndex} 对应 ${tool.name}，与 toolName ${action.toolName} 不同`);
    return { tool, toolIndex: requestedIndex, warnings };
  }
  const matches = tools.map((tool, index) => ({ tool, index })).filter(item => item.tool.name === action?.toolName);
  if (!matches.length) return { warnings: [`工具清单里不存在 ${String(action?.toolName || '')}`] };
  if (matches.length > 1) warnings.push(`存在 ${matches.length} 个同名工具 ${action.toolName}；本次按 tools/list 中第一个执行。模型可返回 toolIndex 精确选择。`);
  return { tool: matches[0].tool, toolIndex: matches[0].index, warnings };
};

export async function planGameHallTurn(input: {
  apiConfig: APIConfig;
  apiIdentity?: GameHallApiIdentity;
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
  mode: GameHallCompanionMode;
  userText: string;
  state?: NormalizedCedarGameState;
  availableTools: McpToolDef[];
  sessionId: string;
  history?: GameHallMessage[];
  accounts?: CharacterExternalAccount[];
  preferredAccountRef?: string;
  contextMessageLimit?: number | null;
  schemaValidationMode?: GameHallSchemaValidationMode;
  repairAttempts?: number;
  autonomousRun?: { runId: string; instruction: string; turnCount: number };
}): Promise<{
  replies: AssistantDisplayPart[];
  thinkingChain?: string;
  pending?: GameHallPendingAction;
  context: GameHallContextSelection;
  validationWarnings?: string[];
  modelRaw: string;
}> {
  if (!input.apiConfig.baseUrl || !input.apiConfig.model) throw new Error('请先配置聊天 API。');
  const context = selectGameHallContext(input.history, input.contextMessageLimit);
  const toolSchemas = input.availableTools.map((tool, index) => ({
    toolIndex: index,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const autonomousBlock = input.autonomousRun ? `
这是连续自主游玩第 ${input.autonomousRun.turnCount + 1} 步。
用户已经明确允许你自己玩，不需要等待用户逐回合确认。
总指令：${input.autonomousRun.instruction}
只要你还想继续，就必须在 action 中选择一个真实工具。
当游戏结束、你自己觉得告一段落、或确实无事可做时，action 返回 null。
不要因为用户没发新消息而停下。
` : '';
  const instruction = `你现在位于 SullyOS 游戏厅。你已经通过正常主聊天完整上下文链获得角色设定、用户档案、世界书、主聊天原文、记忆宫殿召回、日程与实时状态；下面是本轮游戏厅执行协议。
模式：${input.mode}。
游戏厅上下文：${context.limit == null ? '全部' : `最近 ${context.limit} 条`}，实际 ${context.includedCount}/${context.totalCount} 条。
最近已知工具结果状态（完整）：\n${input.state?.summary || '无'}
当前显式选择账号：${input.preferredAccountRef || '基础连接'}
所有已保存账号（完整字段，不打码）：\n${accountListForPrompt(input.accounts)}
MCP tools/list 原始工具数组如下。每项都可见，不筛选、不去重；toolIndex 就是原始数组下标：\n${JSON.stringify(toolSchemas, null, 2)}

请只输出一个 JSON 对象：
{"replies":["第一条自然回复","第二条自然回复"],"action":null 或 {"toolIndex":0,"toolName":"真实工具名","args":{},"accountRef":"可选，省略则使用当前显式选择账号","reason":"原因"}}
replies 是本轮依次发送的聊天消息数组，可返回 1～8 条，不要为了凑数强行拆句。一次 JSON 只能规划一个 action。不要在 replies 中输出 think/thought/analysis 标签。
observe 模式 action 必须为 null。不要编造工具名。参数是否严格阻断由用户设置决定；你应尽量遵守 schema，但客户端不会在用户未开启 strict 时替用户拒绝调用。${autonomousBlock}`;
  const gameHallMessages = [
    ...context.messages,
    ...(!context.messages.length || context.messages.at(-1)?.role !== 'user'
      ? [{
          id: gameHallId('ephemeral'), sessionId: input.sessionId, charId: input.char.id,
          role: 'user' as const, content: input.userText || '[用户发送了一条消息]', createdAt: Date.now(),
        }]
      : []),
  ];
  const baseMessages = await buildGameHallFullMessages({
    char: input.char,
    userProfile: input.userProfile,
    groups: input.groups,
    realtimeConfig: input.realtimeConfig,
    gameHallMessages,
    finalInstruction: instruction,
  });

  const validationMode = input.schemaValidationMode || 'off';
  const maxRepairs = Math.max(0, Math.min(5, Math.floor(input.repairAttempts || 0)));
  let response = await requestAgent(
    input.apiConfig,
    baseMessages,
    gameHallApiMeta({
      char: input.char,
      purpose: '角色规划',
      apiIdentity: input.apiIdentity,
    }),
  );
  let raw = response.content;
  let display = buildAssistantDisplayResult({
    rawContent: raw,
    reasoningContent: response.reasoningContent,
    showThinkingChain: !!(input.char as any).showThinkingChain,
  });
  let parsed = parseAgentJson(display.cleanedContent);
  let warnings: string[] = [];
  let resolved: ReturnType<typeof resolveTool> = { warnings: [] };
  let args: Record<string, unknown> | undefined;

  const inspect = () => {
    warnings = [];
    resolved = { warnings: [] };
    args = undefined;
    if (!parsed) { warnings.push('模型输出不是可解析 JSON'); return; }
    if (input.mode === 'observe' || !parsed.action) return;
    if (!isRecord(parsed.action.args)) warnings.push('action.args 不是对象');
    else args = { ...parsed.action.args };
    resolved = resolveTool(input.availableTools, parsed.action);
    warnings.push(...resolved.warnings);
    if (resolved.tool && args && validationMode !== 'off') {
      const plannedAccountRef = typeof parsed?.action?.accountRef === 'string' && parsed.action.accountRef.trim()
        ? parsed.action.accountRef.trim() : input.preferredAccountRef;
      warnings.push(...validateGameHallToolArgs(resolved.tool, args, plannedAccountRef));
    }
  };
  inspect();

  for (let attempt = 0; attempt < maxRepairs && (!parsed || (!!parsed.action && (!resolved.tool || (validationMode === 'strict' && warnings.length)))); attempt++) {
    response = await requestAgent(
      input.apiConfig,
      [
        ...baseMessages,
        { role: 'assistant', content: raw || '' },
        { role: 'system', content: `上一次规划存在这些问题：${warnings.join('；') || '无法解析'}。这是用户显式设置的第 ${attempt + 1} 次修正，请重新输出 JSON。` },
      ],
      gameHallApiMeta({
        char: input.char,
        purpose: `角色规划修正 ${attempt + 1}`,
        apiIdentity: input.apiIdentity,
      }),
    );
    raw = response.content;
    display = buildAssistantDisplayResult({
      rawContent: raw,
      reasoningContent: response.reasoningContent,
      showThinkingChain: !!(input.char as any).showThinkingChain,
    });
    parsed = parseAgentJson(display.cleanedContent);
    inspect();
  }

  if (!parsed) throw new Error('游戏厅回复格式解析失败');
  const parsedDisplay = parseGameHallAgentDisplay({
    rawContent: raw,
    reasoningContent: response.reasoningContent,
    showThinkingChain: !!(input.char as any).showThinkingChain,
  });
  const replies = parsedDisplay.replies;
  if (input.mode === 'observe' || !parsed.action || !resolved.tool || !args) {
    return { replies, thinkingChain: display.thinkingChain, context, validationWarnings: warnings.length ? warnings : undefined, modelRaw: raw };
  }
  if (validationMode === 'strict' && warnings.length) {
    return { replies, thinkingChain: display.thinkingChain, context, validationWarnings: warnings, modelRaw: raw };
  }
  const explicitAccount = typeof parsed.action.accountRef === 'string' && parsed.action.accountRef.trim()
    ? parsed.action.accountRef.trim() : undefined;
  const accountRef = explicitAccount || input.preferredAccountRef || undefined;
  return {
    replies,
    thinkingChain: display.thinkingChain,
    context,
    validationWarnings: warnings.length ? warnings : undefined,
    modelRaw: raw,
    pending: {
      id: gameHallId('ghaction'),
      sessionId: input.sessionId,
      charId: input.char.id,
      toolName: resolved.tool.name,
      toolIndex: resolved.toolIndex,
      args,
      accountRef,
      reason: String(parsed.action.reason || '角色建议执行此行动'),
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      validationWarnings: warnings.length ? warnings : undefined,
      modelRaw: raw,
    },
  };
}

export async function respondToGameHallToolResult(input: {
  apiConfig: APIConfig;
  apiIdentity?: GameHallApiIdentity;
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
  action: GameHallPendingAction;
  toolResult: McpToolResult;
  accountRef?: string;
  history?: GameHallMessage[];
  contextMessageLimit?: number | null;
}): Promise<{ replies: AssistantDisplayPart[]; thinkingChain?: string }> {
  const exactResult = formatGameHallToolResult(getGameHallToolResultPayload(input.toolResult));
  if (!input.apiConfig.baseUrl || !input.apiConfig.model) return { replies: splitAssistantDisplayParts(`拿到了，${input.action.toolName} 的完整返回是：${exactResult}`) };
  const context = selectGameHallContext(input.history, input.contextMessageLimit);
  const instruction = `你刚刚真实执行了游戏厅工具 ${input.action.toolName}（toolIndex=${input.action.toolIndex ?? '未指定'}）。
执行原因：${input.action.reason}
账号：${input.accountRef || '基础连接'}
工具完整原始返回如下，未打码、未删字段、未截断：\n${exactResult}
请用自然口吻准确告诉用户结果。不要输出 JSON，不要再次规划工具。`;
  const messages = await buildGameHallFullMessages({
    char: input.char,
    userProfile: input.userProfile,
    groups: input.groups,
    realtimeConfig: input.realtimeConfig,
    gameHallMessages: context.messages,
    finalInstruction: instruction,
  });
  try {
    const response = await requestAgent(
      input.apiConfig,
      messages,
      gameHallApiMeta({
        char: input.char,
        purpose: '工具结果回复',
        apiIdentity: input.apiIdentity,
      }),
    );
    const display = buildAssistantDisplayResult({
      rawContent: response.content,
      reasoningContent: response.reasoningContent,
      showThinkingChain: !!(input.char as any).showThinkingChain,
    });
    return {
      replies: display.parts.length
        ? display.parts
        : splitAssistantDisplayParts(`拿到了，${input.action.toolName} 的完整返回是：${exactResult}`),
      thinkingChain: display.thinkingChain,
    };
  } catch {
    return { replies: splitAssistantDisplayParts(`拿到了，${input.action.toolName} 的完整返回是：${exactResult}`) };
  }
}

const buildServerForAccount = (
  connection: CedarToyConnection,
  account?: CharacterExternalAccount,
): McpServerConfig => {
  const server = toCedarMcpServer(connection);
  if (account?.identityEndpoint) {
    server.url = account.identityEndpoint;
    server.token = undefined;
    server.id = `${server.id}_${hashGameHallState(account.identityEndpoint)}`;
  }
  return server;
};

export const stateFromGameHallToolResult = (result: McpToolResult): NormalizedCedarGameState => {
  const raw = getGameHallToolResultPayload(result);
  const currentTurn = (raw as any)?.currentTurn || (raw as any)?.turn || (raw as any)?.current_player;
  return {
    raw,
    summary: stringifyFull(raw),
    stateHash: hashGameHallState(raw),
    gameId: (raw as any)?.gameId || (raw as any)?.game_id,
    gameName: (raw as any)?.gameName || (raw as any)?.game_name,
    currentTurn: currentTurn ? String(currentTurn) : undefined,
    allowsAiAction: Boolean((raw as any)?.allowsAiAction || (raw as any)?.canAct || (raw as any)?.can_ai_act),
  };
};

export interface GameHallActionExecution {
  result: McpToolResult;
  request: GameHallToolRequestSnapshot;
}

export async function executePendingGameHallAction(
  connection: CedarToyConnection,
  action: GameHallPendingAction,
  validationMode: GameHallSchemaValidationMode = 'off',
): Promise<GameHallActionExecution> {
  const tools = connection.tools || [];
  const byIndex = action.toolIndex !== undefined ? tools[action.toolIndex] : undefined;
  const tool = byIndex && byIndex.name === action.toolName
    ? byIndex
    : tools.find(candidate => candidate.name === action.toolName);
  if (!tool) throw new Error(`连接工具清单里不存在 ${action.toolName}`);
  const validationWarnings = validationMode === 'off' ? [] : validateGameHallToolArgs(tool, action.args || {}, action.accountRef);
  if (validationMode === 'strict' && validationWarnings.length) {
    throw new Error(`严格 schema 校验阻止执行：${validationWarnings.join('；')}`);
  }
  const resolved = await injectCharacterAccountIntoAction({ action, tool });
  const server = buildServerForAccount(connection, resolved.account);
  const request: GameHallToolRequestSnapshot = {
    toolName: action.toolName,
    toolIndex: action.toolIndex,
    modelArgs: { ...(action.args || {}) },
    finalArgs: { ...resolved.args },
    serverUrl: server.url,
    accountRef: action.accountRef,
    usedIdentityEndpoint: !!resolved.account?.identityEndpoint,
    validationMode,
    validationWarnings,
  };
  const result = await callMcpTool(server, action.toolName, resolved.args);
  return { result, request };
}
