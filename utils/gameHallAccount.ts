import type { McpToolDef, McpToolResult } from './mcpClient';
import type { CedarToyConnection, CharacterExternalAccount, GameHallPendingAction } from './gameHallTypes';
import {
  getCharacterExternalAccount,
  listCharacterExternalAccountsForServer,
  saveCharacterExternalAccount,
  touchCharacterExternalAccount,
} from './characterExternalAccountStore';

const normalizeKey = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
const TOKEN_KEYS = ['token','authToken','accessToken','access_token','sessionToken','session_token'];
const ACCOUNT_ID_KEYS = ['accountId','account_id','userId','user_id','profileId','profile_id','id'];
const USERNAME_KEYS = ['username','userName','displayName','display_name','nickname','name'];
const PASSWORD_KEYS = ['password','passwd','passcode'];
const SESSION_KEYS = ['sessionId','session_id','session','cookie'];

export const isCredentialFieldName = (key: string): boolean => {
  const normalized = normalizeKey(key);
  return !!normalized && (
    normalized.includes('token') || normalized.includes('password') || normalized.includes('passwd') ||
    normalized.includes('passcode') || normalized.includes('cookie') || normalized.includes('authorization') ||
    normalized.includes('credential') || normalized.includes('secret') || normalized.includes('apikey') ||
    normalized === 'session' || normalized.endsWith('sessionid')
  );
};

const trimUrl = (url: string): string => url.trim().replace(/\/+$/, '');
const hashText = (value: string): string => {
  let hash = 2166136261;
  for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
};
const stableString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

export const getCedarServerId = (connection: CedarToyConnection): string =>
  `cedar_${hashText(trimUrl(connection.url).toLowerCase())}`;

export const getGameHallToolResultPayload = (result: McpToolResult): unknown => {
  if (result.rawResult !== undefined) return result.rawResult;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.data !== undefined) return result.data;
  if (result.rawText !== undefined) return result.rawText;
  return result;
};

/** 只序列化。绝不打码、删字段、替换、截断。 */
export const formatGameHallToolResult = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const parseEmbeddedJson = (value: string): unknown | undefined => {
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
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
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
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
    if (wanted.has(normalizeKey(key)) && child !== undefined && child !== null && child !== '') found = child;
  });
  return found;
};
const collectCredentials = (value: unknown): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  walkEntries(value, (key, child) => {
    if (!isCredentialFieldName(key) || child === undefined || child === null || child === '') return;
    if (!(key in output)) output[key] = child;
  });
  return output;
};
const asDisplayString = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? String(value) : undefined;

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

const primaryToken = (credentials: Record<string, unknown>): unknown =>
  credentials.token ?? credentials.authToken ?? credentials.accessToken ?? credentials.access_token ??
  credentials.sessionToken ?? credentials.session_token;

export const toolResultContainsAccountData = (result: McpToolResult): boolean => {
  const extracted = extractCharacterAccountFields(result);
  return Object.keys(extracted.credentials).length > 0 || (!!extracted.accountId && !!extracted.username);
};

const accountIdentitySeed = (input: {
  accountId?: string;
  username?: string;
  credentials: Record<string, unknown>;
  payload: unknown;
}): string => {
  const token = primaryToken(input.credentials);
  return [input.accountId, input.username, token == null ? '' : stableString(token)]
    .filter(Boolean)
    .join('|') || stableString(input.payload);
};

export const buildCharacterAccountRef = (input: {
  charId: string;
  provider: string;
  serverId: string;
  identitySeed: string;
}): string => `${input.provider}:${input.serverId}:${input.charId}:${hashText(input.identitySeed)}`;

/**
 * 任意成功工具结果只要真实包含账号/凭证就建档；不再依赖“账号工具”正则分类。
 * 没有账号材料时返回 undefined，不制造空账号。
 */
export async function persistCharacterAccountFromToolResultIfPresent(input: {
  charId: string;
  connection: CedarToyConnection;
  toolName: string;
  result: McpToolResult;
  provider?: string;
}): Promise<CharacterExternalAccount | undefined> {
  if (!toolResultContainsAccountData(input.result)) return undefined;
  const provider = input.provider || 'cedar_toy';
  const serverId = getCedarServerId(input.connection);
  const payload = getGameHallToolResultPayload(input.result);
  const extracted = extractCharacterAccountFields(input.result);
  const identitySeed = accountIdentitySeed({ ...extracted, payload });
  const accountRef = buildCharacterAccountRef({ charId: input.charId, provider, serverId, identitySeed });
  const serverAccounts = await listCharacterExternalAccountsForServer({ charId: input.charId, provider, serverId });
  const existing = serverAccounts.find(account => account.accountRef === accountRef);
  const now = Date.now();
  const tokenValue = primaryToken(extracted.credentials);
  const encodedToken = tokenValue == null ? '' : encodeURIComponent(String(tokenValue));
  const baseServerUrl = trimUrl(input.connection.url);
  const identityEndpoint = encodedToken
    ? (baseServerUrl.endsWith(`/${encodedToken}`) ? baseServerUrl : `${baseServerUrl}/${encodedToken}`)
    : existing?.identityEndpoint;
  const account: CharacterExternalAccount = {
    accountRef,
    charId: input.charId,
    provider,
    serverId,
    serverUrl: baseServerUrl,
    identityEndpoint,
    sourceToolName: input.toolName,
    accountId: extracted.accountId || existing?.accountId,
    username: extracted.username || existing?.username,
    credentials: { ...(existing?.credentials || {}), ...extracted.credentials },
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

/** 兼容旧调用名。 */
export const persistCharacterAccountFromToolResult = persistCharacterAccountFromToolResultIfPresent;

const aliasesForSchemaKey = (key: string): string[] => {
  const normalized = normalizeKey(key);
  for (const group of [TOKEN_KEYS, PASSWORD_KEYS, SESSION_KEYS, ACCOUNT_ID_KEYS, USERNAME_KEYS]) {
    if (group.some(candidate => normalizeKey(candidate) === normalized)) return group;
  }
  return [key];
};
const lookupAccountValue = (account: CharacterExternalAccount, schemaKey: string): unknown => {
  const aliases = aliasesForSchemaKey(schemaKey);
  const wanted = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(account.credentials || {})) {
    if (wanted.has(normalizeKey(key)) && value !== undefined && value !== '') return value;
  }
  if (ACCOUNT_ID_KEYS.some(key => wanted.has(normalizeKey(key))) && account.accountId) return account.accountId;
  if (USERNAME_KEYS.some(key => wanted.has(normalizeKey(key))) && account.username) return account.username;
  return findFirstByKeys(account.rawRegistrationResult, aliases);
};

/**
 * accountRef 只是便捷注入：只补缺失字段，绝不删除、改写或覆盖模型/用户已经给出的参数。
 */
export async function injectCharacterAccountIntoAction(input: {
  action: GameHallPendingAction;
  tool?: McpToolDef;
}): Promise<{ args: Record<string, unknown>; account?: CharacterExternalAccount }> {
  const { action, tool } = input;
  const args = { ...(action.args || {}) };
  if (!action.accountRef) return { args };
  const account = await getCharacterExternalAccount(action.accountRef);
  if (!account) throw new Error(`找不到角色账号档案：${action.accountRef}`);
  if (account.status !== 'active') throw new Error(`角色账号已停用：${action.accountRef}`);
  const properties = isRecord(tool?.inputSchema?.properties)
    ? tool!.inputSchema.properties as Record<string, unknown>
    : {};
  const required: string[] = Array.isArray(tool?.inputSchema?.required)
    ? tool!.inputSchema.required.filter((key: unknown): key is string => typeof key === 'string')
    : [];
  const candidateKeys = new Set([...Object.keys(properties), ...required]);
  for (const key of candidateKeys) {
    if (args[key] !== undefined && args[key] !== '') continue;
    const value = lookupAccountValue(account, key);
    if (value !== undefined && value !== '') args[key] = value;
  }
  await touchCharacterExternalAccount(account.accountRef);
  return { args, account };
}
