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
  CharacterExternalAccount,
  GameHallCompanionMode,
  GameHallMessage,
  GameHallPendingAction,
  NormalizedCedarGameState,
} from './gameHallTypes';
import { stripGameHallMemorySignals } from './gameHallMemoryPolicy';
import { gameHallId } from './gameHallStore';
import {
  formatGameHallToolResult,
  getGameHallToolResultPayload,
  injectCharacterAccountIntoAction,
  isCredentialFieldName,
} from './gameHallAccount';

const HISTORY_COUNT_LIMIT = 24;

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

const canPlanWithStoredAccount = (
  tool: McpToolDef,
  args: Record<string, unknown>,
  accountRef?: string,
): boolean => {
  const missing = requiredSchemaKeys(tool).filter(
    key => args[key] === undefined || args[key] === '',
  );
  if (!missing.length) return true;
  return !!accountRef && missing.every(isCredentialFieldName);
};

const extractStateSummary = (data: unknown): string => {
  try {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return String(text ?? '').slice(0, 1_600);
  } catch {
    return String(data).slice(0, 1_600);
  }
};

/**
 * 兼容旧调用名。现在只做无损序列化，不再脱敏、删字段或截断。
 */
export const summarizeGameHallToolResult = (result: McpToolResult): string =>
  formatGameHallToolResult(getGameHallToolResultPayload(result));

const formatGameHallHistory = (
  history: GameHallMessage[] | undefined,
): string => {
  if (!history?.length) return '无';

  return history
    .slice(-HISTORY_COUNT_LIMIT)
    .map(message => {
      const visible = stripGameHallMemorySignals(message.content).visibleText.trim();
      const role =
        message.role === 'user'
          ? '用户'
          : message.role === 'assistant'
            ? '角色'
            : message.role === 'tool'
              ? `工具${message.toolName ? `(${message.toolName})` : ''}`
              : '系统';
      const result = message.toolResult
        ? `\n工具完整返回：${formatGameHallToolResult(getGameHallToolResultPayload(message.toolResult))}`
        : message.toolResultSummary
          ? `\n工具返回：${message.toolResultSummary}`
          : '';
      return visible || result
        ? `${role}：${visible}${result}`
        : '';
    })
    .filter(Boolean)
    .join('\n');
};

const accountListForPrompt = (
  accounts: CharacterExternalAccount[] | undefined,
): string => {
  if (!accounts?.length) return '无已保存账号';
  return accounts
    .filter(account => account.status === 'active')
    .map(account =>
      JSON.stringify({
        accountRef: account.accountRef,
        provider: account.provider,
        accountId: account.accountId,
        username: account.username,
        serverUrl: account.serverUrl,
      }),
    )
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
    throw new Error('连接成功，但没有可在不猜参数的前提下调用的状态工具。');
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
      summary: extractStateSummary(raw),
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
  accounts?: CharacterExternalAccount[];
}): Promise<{
  reply: string;
  pending?: GameHallPendingAction;
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
    accounts,
  } = input;

  if (!apiConfig.baseUrl || !apiConfig.model) {
    throw new Error('请先配置聊天 API。');
  }

  const toolSchemas = actionTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  const prompt = `你是 ${char.name}，正在 SullyOS 游戏厅陪 ${
    userProfile?.name || '用户'
  } 玩 Cedar Toy。保持角色人设：${
    char.systemPrompt || char.description || ''
  }
模式：${mode}。
最近的游戏厅对话：
${formatGameHallHistory(history)}
当前游戏状态摘要：${state?.summary || '尚未读取'}
角色已经保存的外部账号（只能引用 accountRef，绝不能重写或猜 Token）：
${accountListForPrompt(accounts)}
用户这轮说：${userText}
可调用工具真实 schema：${JSON.stringify(toolSchemas)}

只输出 JSON：
{"reply":"给用户的自然回复","action":null 或 {"toolName":"必须来自工具清单","args":{},"accountRef":"需要登录时从上面的已保存账号中选择，否则省略","reason":"原因"}}。

规则：
1. 必须承接最近对话，不能因退出重进失忆。
2. observe 模式 action 必须为 null。
3. 注册新账号时调用真实账号工具；注册成功后的凭证由客户端自动保存。
4. 使用已保存账号时只输出 accountRef，不得把 Token、密码、Cookie、Authorization 或其它凭证重新抄进 args。
5. 除账号档案可自动补齐的凭证字段外，不得猜测缺失参数。`;

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
  const parsed = parseAgentJson(data?.choices?.[0]?.message?.content || '');
  const visible = stripGameHallMemorySignals(
    String(parsed?.reply || '我在看着这局，先别急着动。'),
  ).visibleText.trim();
  const reply = visible || '我在看着这局，先别急着动。';

  if (mode === 'observe' || !parsed?.action) return { reply };

  const tool = actionTools.find(
    candidate => candidate.name === parsed.action.toolName,
  );
  const parsedArgs = parsed.action.args;
  if (!tool || !parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    return { reply };
  }
  const args: Record<string, unknown> = { ...parsedArgs };
  let accountRef =
    typeof parsed.action.accountRef === 'string' && parsed.action.accountRef.trim()
      ? parsed.action.accountRef.trim()
      : undefined;

  // 只有一个已启用账号时，客户端可直接选中它；模型无需、也不允许重抄凭证。
  const activeAccounts = (accounts || []).filter(account => account.status === 'active');
  const requiredCredentials = requiredSchemaKeys(tool).filter(isCredentialFieldName);
  if (!accountRef && activeAccounts.length === 1 && requiredCredentials.length) {
    accountRef = activeAccounts[0].accountRef;
  }
  if (accountRef) {
    for (const key of Object.keys(args)) {
      if (isCredentialFieldName(key)) delete args[key];
    }
  }
  if (!canPlanWithStoredAccount(tool, args, accountRef)) return { reply };

  return {
    reply,
    pending: {
      id: gameHallId('ghaction'),
      sessionId,
      charId: char.id,
      toolName: tool.name,
      args,
      accountRef,
      reason: String(parsed.action.reason || '角色建议执行此行动'),
      stateHash: state?.stateHash,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

/**
 * 工具成功后，把完整原始 MCP 结果交给角色。这里没有任何脱敏/截断。
 * 这一步失败不改变工具的成功状态，也不影响已经落库的账号档案。
 */
export async function respondToGameHallToolResult(input: {
  apiConfig: APIConfig;
  char: CharacterProfile;
  userProfile: UserProfile;
  action: GameHallPendingAction;
  toolResult: McpToolResult;
  accountRef?: string;
  history?: GameHallMessage[];
}): Promise<string> {
  const {
    apiConfig,
    char,
    userProfile,
    action,
    toolResult,
    accountRef,
    history,
  } = input;
  const exactResult = formatGameHallToolResult(getGameHallToolResultPayload(toolResult));

  if (!apiConfig.baseUrl || !apiConfig.model) {
    return `拿到了，${action.toolName} 的完整返回是：${exactResult}`;
  }

  const prompt = `你是 ${char.name}，正在游戏厅陪 ${
    userProfile?.name || '用户'
  }。保持人设：${char.systemPrompt || char.description || ''}
最近对话：
${formatGameHallHistory(history)}
你刚刚真实执行了工具 ${action.toolName}。
执行原因：${action.reason}
${accountRef ? `客户端已把这次得到的账号资料逐字保存为 accountRef：${accountRef}。以后登录只引用这个 accountRef，不要手抄凭证。` : ''}
工具完整原始返回如下，未打码、未删字段、未截断：
${exactResult}

现在用自然口吻告诉用户实际结果。关键结果应准确表达。不要再请求调用工具，不要声称状态读取失败，不要输出 JSON。`;

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
    return `拿到了，${action.toolName} 的完整返回是：${exactResult}`;
  }

  const data = await safeResponseJson(response);
  const raw = String(data?.choices?.[0]?.message?.content || '');
  const visible = stripGameHallMemorySignals(raw).visibleText.trim();
  return visible || `拿到了，${action.toolName} 的完整返回是：${exactResult}`;
}

export async function executePendingGameHallAction(
  connection: CedarToyConnection,
  action: GameHallPendingAction,
): Promise<McpToolResult> {
  const tool = connection.tools?.find(candidate => candidate.name === action.toolName);
  const resolved = await injectCharacterAccountIntoAction({ action, tool });
  return callMcpTool(
    toCedarMcpServer(connection),
    action.toolName,
    resolved.args,
  );
}
