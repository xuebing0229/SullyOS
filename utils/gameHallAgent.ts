import type { APIConfig, CharacterProfile, UserProfile } from '../types';
import { safeResponseJson } from './safeApi';
import { buildCedarCapabilityMap, toCedarMcpServer } from './cedarToyMcpAdapter';
import {
  callMcpTool,
  type McpToolDef,
  type McpToolResult,
} from './mcpClient';
import type {
  CedarToyConnection,
  GameHallCompanionMode,
  GameHallMessage,
  GameHallPendingAction,
  NormalizedCedarGameState,
} from './gameHallTypes';
import type { GameHallMemorySignal } from './gameHallMemoryTypes';
import { stripGameHallMemorySignals } from './gameHallMemoryPolicy';
import { gameHallId } from './gameHallStore';

const TOOL_RESULT_LIMIT = 4_000;
const HISTORY_MESSAGE_LIMIT = 1_200;
const HISTORY_COUNT_LIMIT = 24;
const SECRET_FIELD_RE =
  /(^|[_-])(api[_-]?key|authorization|cookie|password|passwd|secret|token)([_-]|$)/i;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map(
        key =>
          `${JSON.stringify(key)}:${stableJson(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const hashGameHallState = (value: unknown): string => {
  let hash = 2166136261;
  for (const char of stableJson(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const requiredSchemaKeys = (tool: McpToolDef): string[] =>
  Array.isArray(tool.inputSchema?.required)
    ? tool.inputSchema.required.filter(
        (item: unknown): item is string => typeof item === 'string',
      )
    : [];

export const canCallWithoutGuessing = (
  tool: McpToolDef,
  args: Record<string, unknown>,
): boolean =>
  requiredSchemaKeys(tool).every(
    key => args[key] !== undefined && args[key] !== '',
  );

const extractSummary = (data: unknown): string => {
  try {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return String(text ?? '').slice(0, 1_600);
  } catch {
    return String(data).slice(0, 1_600);
  }
};

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const sanitizeToolResultValue = (
  value: unknown,
  depth = 0,
): unknown => {
  if (depth > 8) return '[内容过深，已省略]';

  if (typeof value === 'string') {
    if (/^data:image\/[^;]+;base64,/i.test(value)) {
      return '[图片数据已省略]';
    }
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map(item => sanitizeToolResultValue(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      output[key] = SECRET_FIELD_RE.test(key)
        ? '[已隐藏]'
        : sanitizeToolResultValue(child, depth + 1);
    }
    return output;
  }

  return String(value ?? '');
};

/**
 * 给用户与模型看的 MCP 工具结果。
 * 保留绑定码、账号 ID、URL 等业务结果，但隐藏 Token、密码、Cookie、API Key 和图片 base64。
 */
export const summarizeGameHallToolResult = (
  result: McpToolResult,
): string => {
  let payload: unknown = result.data;

  if (payload === undefined) payload = result.structuredContent;
  if (payload === undefined || payload === null) payload = result.rawText;
  if (payload === undefined || payload === null) payload = result.rawResult;

  payload = parseMaybeJson(payload);
  const sanitized = sanitizeToolResultValue(payload);

  if (typeof sanitized === 'string') {
    return sanitized.trim().slice(0, TOOL_RESULT_LIMIT);
  }

  try {
    return JSON.stringify(sanitized, null, 2).slice(0, TOOL_RESULT_LIMIT);
  } catch {
    return String(sanitized ?? '').slice(0, TOOL_RESULT_LIMIT);
  }
};

const formatGameHallHistory = (
  history: GameHallMessage[] | undefined,
): string => {
  if (!history?.length) return '无';

  return history
    .slice(-HISTORY_COUNT_LIMIT)
    .map(message => {
      const cleaned = stripGameHallMemorySignals(message.content).visibleText
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, HISTORY_MESSAGE_LIMIT);
      const role =
        message.role === 'user'
          ? '用户'
          : message.role === 'assistant'
            ? '角色'
            : message.role === 'tool'
              ? `工具${message.toolName ? `(${message.toolName})` : ''}`
              : '系统';
      return cleaned ? `${role}：${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n');
};

export async function readCedarGameState(
  connection: CedarToyConnection,
  preferredTool?: string,
  args: Record<string, unknown> = {},
): Promise<{ state: NormalizedCedarGameState; toolName: string }> {
  const tools = connection.tools || [];
  const map = buildCedarCapabilityMap(tools);
  const tool =
    (preferredTool &&
      map.state.find(candidate => candidate.name === preferredTool)) ||
    map.state.find(candidate => canCallWithoutGuessing(candidate, args));

  if (!tool) {
    throw new Error(
      '连接成功，但没有可在不猜参数的前提下调用的状态工具。',
    );
  }
  if (!canCallWithoutGuessing(tool, args)) {
    throw new Error(
      `状态工具 ${tool.name} 缺少必填参数：${requiredSchemaKeys(tool).join('、')}`,
    );
  }

  const result = await callMcpTool(
    toCedarMcpServer(connection),
    tool.name,
    args,
  );
  if (!result.success) {
    throw new Error(result.error || '状态工具调用失败');
  }

  const raw = result.data;
  const text = extractSummary(raw);
  const currentTurn =
    (raw as any)?.currentTurn ||
    (raw as any)?.turn ||
    (raw as any)?.current_player;
  const allows = Boolean(
    (raw as any)?.allowsAiAction ||
      (raw as any)?.canAct ||
      (raw as any)?.can_ai_act,
  );

  return {
    toolName: tool.name,
    state: {
      raw,
      summary: text,
      stateHash: hashGameHallState(raw),
      gameId: (raw as any)?.gameId || (raw as any)?.game_id,
      gameName: (raw as any)?.gameName || (raw as any)?.game_name,
      currentTurn: currentTurn ? String(currentTurn) : undefined,
      allowsAiAction: allows,
    },
  };
}

const parseAgentJson = (text: string): any => {
  const cleaned = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

export async function planGameHallTurn(input: {
  apiConfig: APIConfig;
  char: CharacterProfile;
  userProfile: UserProfile;
  mode: GameHallCompanionMode;
  userText: string;
  state?: NormalizedCedarGameState;
  actionTools: McpToolDef[];
  sessionId: string;
  history?: GameHallMessage[];
}): Promise<{
  reply: string;
  pending?: GameHallPendingAction;
  memorySignal?: GameHallMemorySignal;
}> {
  const {
    apiConfig,
    char,
    userProfile,
    mode,
    userText,
    state,
    actionTools,
    sessionId,
    history,
  } = input;

  if (!apiConfig.baseUrl || !apiConfig.model) {
    throw new Error('请先配置聊天 API。');
  }

  const toolSchemas = actionTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const recentHistory = formatGameHallHistory(history);

  const prompt = `你是 ${char.name}，正在 SullyOS 游戏厅陪 ${
    userProfile?.name || '用户'
  } 玩 Cedar Toy。保持角色人设：${
    char.systemPrompt || char.description || ''
  }
模式：${mode}。
最近的游戏厅对话：
${recentHistory}
当前游戏状态摘要：${state?.summary || '尚未读取'}
用户这轮说：${userText}
行动工具真实 schema：${JSON.stringify(toolSchemas)}
只输出 JSON：{"reply":"给用户的自然回复","action":null 或 {"toolName":"必须来自工具清单","args":{},"reason":"原因"},"memorySignal":null 或 {"category":"分类","summary":"不含密钥或原始 MCP JSON 的摘要","signals":[],"level":0到3}}。
你必须承接最近对话，不能因为用户退出又重新进入游戏厅就失忆。只有边界、承诺、偏好、关系变化、强情绪、共同命名/里程碑、持续目标等才给 memorySignal，普通流水为 null。observe 模式 action 必须 null。不得猜测 schema 中缺失的信息；不能填满全部 required 时 action 必须 null。`;

  const response = await fetch(
    `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`游戏厅 Agent HTTP ${response.status}`);
  }

  const data = await safeResponseJson(response);
  const parsed = parseAgentJson(
    data?.choices?.[0]?.message?.content || '',
  );
  const stripped = stripGameHallMemorySignals(
    String(parsed?.reply || '我在看着这局，先别急着动。').slice(
      0,
      2_400,
    ),
  );
  const reply = stripped.visibleText.slice(0, 2_000);
  const memorySignal = (
    parsed?.memorySignal &&
    typeof parsed.memorySignal === 'object' &&
    !('secret' in parsed.memorySignal)
      ? parsed.memorySignal
      : stripped.signals[0]
  ) as GameHallMemorySignal | undefined;

  if (mode === 'observe' || !parsed?.action) {
    return { reply, memorySignal };
  }

  const tool = actionTools.find(
    candidate => candidate.name === parsed.action.toolName,
  );
  const args = parsed.action.args;
  if (
    !tool ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    !canCallWithoutGuessing(tool, args)
  ) {
    return { reply, memorySignal };
  }

  return {
    reply,
    memorySignal,
    pending: {
      id: gameHallId('ghaction'),
      sessionId,
      charId: char.id,
      toolName: tool.name,
      args,
      reason: String(
        parsed.action.reason || '角色建议执行此行动',
      ).slice(0, 500),
      stateHash: state?.stateHash,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

/**
 * 工具已经成功后，再把真实结果交给角色生成一句自然回应。
 * 这一步失败不会改变工具成功状态；UI 仍会直接展示脱敏后的真实返回。
 */
export async function respondToGameHallToolResult(input: {
  apiConfig: APIConfig;
  char: CharacterProfile;
  userProfile: UserProfile;
  action: GameHallPendingAction;
  toolResultSummary: string;
  history?: GameHallMessage[];
}): Promise<string> {
  const {
    apiConfig,
    char,
    userProfile,
    action,
    toolResultSummary,
    history,
  } = input;

  if (!toolResultSummary.trim()) {
    return `${action.toolName} 已经执行成功。`;
  }
  if (!apiConfig.baseUrl || !apiConfig.model) {
    return `拿到了，${action.toolName} 的真实返回是：${toolResultSummary}`;
  }

  const prompt = `你是 ${char.name}，正在游戏厅陪 ${
    userProfile?.name || '用户'
  }。保持人设：${char.systemPrompt || char.description || ''}
最近对话：
${formatGameHallHistory(history)}
你刚刚真实执行了工具 ${action.toolName}。
执行原因：${action.reason}
工具真实返回（客户端已隐藏 Token、密码、Cookie、API Key 和图片 base64）：
${toolResultSummary}

现在直接用自然口吻告诉用户结果。绑定码、账号 ID、房间号、URL 等必须原样准确保留，不能只说“成功了”却不把关键结果告诉用户。不要再请求调用工具，不要声称状态读取失败，不要输出 JSON 或记忆信号。`;

  const response = await fetch(
    `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.55,
      }),
    },
  );

  if (!response.ok) {
    return `拿到了，${action.toolName} 的真实返回是：${toolResultSummary}`;
  }

  const data = await safeResponseJson(response);
  const raw = String(data?.choices?.[0]?.message?.content || '').slice(
    0,
    2_400,
  );
  const visible = stripGameHallMemorySignals(raw).visibleText.trim();
  return visible || `拿到了，${action.toolName} 的真实返回是：${toolResultSummary}`;
}

export async function executePendingGameHallAction(
  connection: CedarToyConnection,
  action: GameHallPendingAction,
): Promise<McpToolResult> {
  return callMcpTool(
    toCedarMcpServer(connection),
    action.toolName,
    action.args,
  );
}
