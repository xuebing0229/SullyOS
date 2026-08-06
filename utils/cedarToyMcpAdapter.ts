import { createMcpServer, testMcpConnection, type McpServerConfig, type McpToolDef } from './mcpClient';
import type { CedarCapabilityMap, CedarToyConnection } from './gameHallTypes';
import {
  loadGameHallAiSettings,
  normalizeGameHallAiSettings,
  saveGameHallAiSettings,
  type GameHallAiSettings,
} from './gameHallAiSettings';

export const CEDAR_CONNECTION_KEY = 'sullyos.gameHall.cedar.connection.v1';

const NAME_MATCHERS = {
  account: /^(?:account|login|identity|profile|user)(?:_|$)|账号|登录|身份/i,
  catalog: /^(?:list_?games?|games?_?list|catalog|library)(?:_|$)|游戏列表|目录/i,
  guide: /^(?:get_?guide|guide|help|rules?|manual)(?:_|$)|攻略|规则|说明/i,
  state: /^(?:get_|read_|fetch_)?(?:game_)?(?:state|status|snapshot|board|session|turn)(?:_|$)|局面|状态|存档|回合/i,
  action: /^(?:play|action|act|move|choose|submit|command)(?:_|$)|操作|行动|出牌|选择/i,
} as const;

const DESCRIPTION_MATCHERS = {
  account: /account|identity|login|账号|身份|登录/i,
  catalog: /list games?|game catalog|game library|游戏列表|游戏目录/i,
  guide: /guide|rules?|manual|攻略|规则|说明/i,
  state: /read (?:the )?(?:game )?state|snapshot|current turn|读取状态|当前局面/i,
  action: /perform|take action|play game|submit move|执行行动|进行游戏/i,
} as const;

/**
 * 分类只用于 UI 诊断、账号落库和寻找专用状态工具。
 * 角色可见工具永远直接使用原始 tools/list，绝不经过这里筛选。
 */
export const buildCedarCapabilityMap = (tools: McpToolDef[]): CedarCapabilityMap => {
  const map: CedarCapabilityMap = { account: [], catalog: [], guide: [], state: [], action: [], unknown: [] };
  for (const tool of tools) {
    const name = String(tool.name || '');
    const description = String(tool.description || '');
    const byName = (Object.keys(NAME_MATCHERS) as Array<keyof typeof NAME_MATCHERS>)
      .find(key => NAME_MATCHERS[key].test(name));
    const byDescription = byName ? undefined : (Object.keys(DESCRIPTION_MATCHERS) as Array<keyof typeof DESCRIPTION_MATCHERS>)
      .find(key => DESCRIPTION_MATCHERS[key].test(description));
    const category = byName || byDescription;
    if (category) map[category].push(tool);
    else map.unknown.push(tool);
  }
  return map;
};

export const describeCedarCapabilities = (map: CedarCapabilityMap): string[] => [
  `账号工具：${map.account.length ? map.account.map(t => t.name).join('、') : '未识别'}`,
  `目录工具：${map.catalog.length ? map.catalog.map(t => t.name).join('、') : '未识别'}`,
  `攻略工具：${map.guide.length ? map.guide.map(t => t.name).join('、') : '未识别'}`,
  `状态工具：${map.state.length ? map.state.map(t => t.name).join('、') : '未识别'}`,
  `行动工具：${map.action.length ? map.action.map(t => t.name).join('、') : '未识别'}`,
  `未分类工具：${map.unknown.length ? map.unknown.map(t => t.name).join('、') : '无'}`,
];

const normalizeCedarConnection = (value: unknown): CedarToyConnection => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((tool): tool is McpToolDef => !!tool && typeof tool === 'object' && typeof (tool as McpToolDef).name === 'string')
    : undefined;
  return {
    url: typeof raw.url === 'string' ? raw.url : '',
    token: typeof raw.token === 'string' ? raw.token : '',
    proxyUrl: typeof raw.proxyUrl === 'string' ? raw.proxyUrl : '',
    proxyKey: typeof raw.proxyKey === 'string' ? raw.proxyKey : '',
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    tools: tools?.map(tool => ({ ...tool })),
  };
};

export const loadCedarConnection = (): CedarToyConnection => {
  try { return normalizeCedarConnection(JSON.parse(localStorage.getItem(CEDAR_CONNECTION_KEY) || '{}')); }
  catch { return normalizeCedarConnection({}); }
};

export const saveCedarConnection = (connection: CedarToyConnection): void => {
  localStorage.setItem(CEDAR_CONNECTION_KEY, JSON.stringify(connection));
};

export const clearCedarConnection = (): void => localStorage.removeItem(CEDAR_CONNECTION_KEY);

export interface CedarToyConnectionBackup {
  version: 2;
  connection: CedarToyConnection;
  /** 游戏厅自己的可切换 AI 预设选择。 */
  aiSettings: GameHallAiSettings;
}

export const exportCedarToyConnectionForBackup = (): CedarToyConnectionBackup => ({
  version: 2,
  connection: normalizeCedarConnection(loadCedarConnection()),
  aiSettings: normalizeGameHallAiSettings(loadGameHallAiSettings()),
});

export const importCedarToyConnectionFromBackup = (data: unknown): boolean => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const version = Number((data as any).version);
  if (version !== 1 && version !== 2) return false;

  const connection = (data as any).connection;
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return false;
  saveCedarConnection(normalizeCedarConnection(connection));

  // v1 备份没有游戏厅 AI 设置：只恢复旧连接，不覆盖用户当前选择。
  if (version === 2 && (data as any).aiSettings) {
    saveGameHallAiSettings(
      normalizeGameHallAiSettings((data as any).aiSettings),
    );
  }
  return true;
};

export const toCedarMcpServer = (connection: CedarToyConnection): McpServerConfig => ({
  ...createMcpServer('Cedar Toy', connection.url.trim()),
  id: 'game_hall_cedar_toy',
  token: connection.token?.trim() || undefined,
  proxyUrl: connection.proxyUrl?.trim() || undefined,
  proxyKey: connection.proxyKey?.trim() || undefined,
  enabled: true,
  tools: connection.tools,
  updatedAt: connection.updatedAt || Date.now(),
});

export const diagnoseCedarConnection = async (connection: CedarToyConnection) => {
  if (!/^https?:\/\//i.test(connection.url.trim())) return { ok: false as const, message: '请填写完整的 HTTP(S) MCP URL。' };
  const result = await testMcpConnection(toCedarMcpServer(connection));
  if (!result.ok) return result;
  const tools = result.tools || [];
  return { ...result, tools, capabilities: buildCedarCapabilityMap(tools) };
};
