import type { McpToolDef, McpToolResult } from './mcpClient';
import type {
  CedarToyConnection,
  CharacterExternalAccount,
  GameHallPendingAction,
} from './gameHallTypes';
import {
  findCharacterExternalAccount,
  getCharacterExternalAccount,
  saveCharacterExternalAccount,
  touchCharacterExternalAccount,
} from './characterExternalAccountStore';

const normalizeKey = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();

const TOKEN_KEYS = [
  'token',
  'authToken',
  'accessToken',
  'access_token',
  'sessionToken',
  'session_token',
  'credential',
  'credentials',
  'authorization',
];
const ACCOUNT_ID_KEYS = [
  'accountId',
  'account_id',
  'userId',
  'user_id',
  'profileId',
  'profile_id',
  'id',
];
const USERNAME_KEYS = [
  'username',
  'userName',
  'displayName',
  'display_name',
  'nickname',
  'name',
];
const PASSWORD_KEYS = ['password', 'passwd', 'passcode'];
const SESSION_KEYS = ['sessionId', 'session_id', 'session', 'cookie'];

export const isCredentialFieldName = (key: string): boolean => {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  return (
    normalized.includes('token') ||
    normalized.includes('password') ||
    normalized.includes('passwd') ||
    normalized.includes('passcode') ||
    normalized.includes('cookie') ||
    normalized.includes('authorization') ||
    normalized.includes('credential') ||
    normalized.includes('secret') ||
    normalized.includes('apikey') ||
    normalized === 'session' ||
    normalized.endsWith('sessionid')
  );
};

const safeUrl = (url: string): string => url.trim().replace(/\/+$/, '');

const hashText = (value: string): string => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const getCedarServerId = (connection: CedarToyConnection): string =>
  `cedar_${hashText(safeUrl(connection.url).toLowerCase())}`;

export const buildCharacterAccountRef = (input: {
  charId: string;
  provider: string;
  serverId: string;
}): string => `${input.provider}:${input.serverId}:${input.charId}`;

/** 优先取真正的 JSON-RPC tools/call result；其余字段作为兼容兜底。 */
export const getGameHallToolResultPayload = (result: McpToolResult): unknown => {
  if (result.rawResult !== undefined) return result.rawResult;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.data !== undefined) return result.data;
  if (result.rawText !== undefined) return result.rawText;
  return result;
};

/** UI 展示用。只做序列化，不打码、不删字段、不截断。 */
export const formatGameHallToolResult = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseEmbeddedJson = (value: string): unknown | undefined => {
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const walkEntries = (
  value: unknown,
  visit: (key: string, child: unknown, path: string[]) => void,
  path: string[] = [],
  seen = new WeakSet<object>(),
): void => {
  if (typeof value === 'string') {
    const parsed = parseEmbeddedJson(value);
    if (parsed !== undefined) walkEntries(parsed, visit, [...path, '$json'], seen);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkEntries(child, visit, [...path, String(index)], seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key, child, [...path, key]);
    walkEntries(child, visit, [...path, key], seen);
  }
};

const findFirstByKeys = (value: unknown, keys: string[]): unknown => {
  const wanted = new Set(keys.map(normalizeKey));
  let found: unknown;
  walkEntries(value, (key, child) => {
    if (found !== undefined) return;
    if (wanted.has(normalizeKey(key)) && child !== undefined && child !== null && child !== '') {
      found = child;
    }
  });
  return found;
};

const collectCredentials = (value: unknown): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  walkEntries(value, (key, child) => {
    if (!isCredentialFieldName(key)) return;
    if (child === undefined || child === null || child === '') return;
    if (!(key in output)) output[key] = child;
  });
  return output;
};

const asDisplayString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
};

export const extractCharacterAccountFields = (result: McpToolResult): {
  accountId?: string;
  username?: string;
  credentials: Record<string, unknown>;
} => {
  const source = {
    rawResult: result.rawResult,
    structuredContent: result.structuredContent,
    data: result.data,
    rawText: result.rawText,
  };
  return {
    accountId: asDisplayString(findFirstByKeys(source, ACCOUNT_ID_KEYS)),
    username: asDisplayString(findFirstByKeys(source, USERNAME_KEYS)),
    credentials: collectCredentials(source),
  };
};

export const isAccountTool = (toolName: string, accountTools: McpToolDef[]): boolean =>
  accountTools.some(tool => tool.name === toolName);

/**
 * 账号工具成功后立即落库。必须在角色复述和状态刷新之前调用。
 * 相同 char/provider/server 会更新同一条账号档案，保留最初 createdAt。
 */
export async function persistCharacterAccountFromToolResult(input: {
  charId: string;
  connection: CedarToyConnection;
  toolName: string;
  result: McpToolResult;
  provider?: string;
}): Promise<CharacterExternalAccount> {
  const provider = input.provider || 'cedar_toy';
  const serverId = getCedarServerId(input.connection);
  const accountRef = buildCharacterAccountRef({
    charId: input.charId,
    provider,
    serverId,
  });
  const payload = getGameHallToolResultPayload(input.result);
  // rawResult 保真存档；解析同时覆盖 content.text JSON / structuredContent / data。
  const extracted = extractCharacterAccountFields(input.result);
  const existing = await findCharacterExternalAccount({
    charId: input.charId,
    provider,
    serverId,
  });
  const now = Date.now();
  const account: CharacterExternalAccount = {
    accountRef,
    charId: input.charId,
    provider,
    serverId,
    serverUrl: safeUrl(input.connection.url),
    sourceToolName: input.toolName,
    accountId: extracted.accountId || existing?.accountId,
    username: extracted.username || existing?.username,
    credentials: {
      ...(existing?.credentials || {}),
      ...extracted.credentials,
    },
    rawRegistrationResult: existing?.rawRegistrationResult ?? payload,
    lastToolResult: payload,
    rawToolResults: [
      ...(existing?.rawToolResults || []),
      { toolName: input.toolName, result: payload, createdAt: now },
    ],
    status: 'active',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
  };
  await saveCharacterExternalAccount(account);
  return account;
}

const aliasesForSchemaKey = (key: string): string[] => {
  const normalized = normalizeKey(key);
  for (const group of [TOKEN_KEYS, PASSWORD_KEYS, SESSION_KEYS, ACCOUNT_ID_KEYS, USERNAME_KEYS]) {
    if (group.some(candidate => normalizeKey(candidate) === normalized)) return group;
  }
  return [key];
};

const lookupAccountValue = (
  account: CharacterExternalAccount,
  schemaKey: string,
): unknown => {
  const aliases = aliasesForSchemaKey(schemaKey);
  const wanted = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(account.credentials || {})) {
    if (wanted.has(normalizeKey(key)) && value !== undefined && value !== '') return value;
  }
  if (ACCOUNT_ID_KEYS.some(key => wanted.has(normalizeKey(key))) && account.accountId) {
    return account.accountId;
  }
  if (USERNAME_KEYS.some(key => wanted.has(normalizeKey(key))) && account.username) {
    return account.username;
  }
  return findFirstByKeys(account.rawRegistrationResult, aliases);
};

/**
 * 模型只给 accountRef。客户端按真实 schema，把账号档案中的精确值填进缺失字段。
 * 明确写在 action.args 里的值优先，不覆盖用户/模型已指定的参数。
 */
export async function injectCharacterAccountIntoAction(input: {
  action: GameHallPendingAction;
  tool?: McpToolDef;
}): Promise<{ args: Record<string, unknown>; account?: CharacterExternalAccount }> {
  const { action, tool } = input;
  const args = { ...(action.args || {}) };
  delete (args as any).accountRef;
  if (!action.accountRef) return { args };

  const account = await getCharacterExternalAccount(action.accountRef);
  if (!account) throw new Error(`找不到角色账号档案：${action.accountRef}`);
  if (account.status !== 'active') throw new Error(`角色账号已停用：${action.accountRef}`);

  const properties = isRecord(tool?.inputSchema?.properties)
    ? tool!.inputSchema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(tool?.inputSchema?.required)
    ? tool!.inputSchema.required.filter((key: unknown): key is string => typeof key === 'string')
    : [];
  const candidateKeys = new Set([...Object.keys(properties), ...required]);

  for (const key of candidateKeys) {
    if (args[key] !== undefined && args[key] !== '') continue;
    const value = lookupAccountValue(account, key);
    if (value !== undefined && value !== '') args[key] = value;
  }

  const missing = required.filter(key => args[key] === undefined || args[key] === '');
  if (missing.length) {
    throw new Error(
      `账号档案 ${action.accountRef} 无法补齐 ${action.toolName} 的必填参数：${missing.join('、')}`,
    );
  }
  await touchCharacterExternalAccount(account.accountRef);
  return { args, account };
}
