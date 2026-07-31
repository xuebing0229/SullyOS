import { createMcpServer, testMcpConnection, type McpServerConfig, type McpToolDef } from './mcpClient';
import type { CedarCapabilityMap, CedarToyConnection } from './gameHallTypes';

export const CEDAR_CONNECTION_KEY = 'sullyos.gameHall.cedar.connection.v1';
const MATCHERS = {
  account: /account|identity|profile|user|login|绑定|账号|身份/i,
  catalog: /catalog|list games?|game list|library|目录|游戏列表/i,
  guide: /guide|help|rules?|manual|攻略|规则|说明/i,
  state: /state|status|snapshot|board|save|session|turn|局面|状态|存档|回合/i,
  action: /action|act|move|play|choose|submit|command|操作|行动|出牌|选择/i,
} as const;

const searchableToolText = (tool: McpToolDef): string => {
  let schema = '';
  try { schema = JSON.stringify(tool.inputSchema || {}); } catch { /* ignore */ }
  return `${tool.name} ${tool.description || ''} ${schema}`;
};

export const buildCedarCapabilityMap = (tools: McpToolDef[]): CedarCapabilityMap => {
  const map: CedarCapabilityMap = { account: [], catalog: [], guide: [], state: [], action: [], unknown: [] };
  for (const tool of tools) {
    const text = searchableToolText(tool);
    let matched = false;
    for (const key of ['account', 'catalog', 'guide', 'state', 'action'] as const) {
      if (MATCHERS[key].test(text)) { map[key].push(tool); matched = true; }
    }
    if (!matched) map.unknown.push(tool);
  }
  return map;
};

export const describeCedarCapabilities = (map: CedarCapabilityMap): string[] => [
  `账号工具：${map.account.length ? map.account.map(t => t.name).join('、') : '未识别'}`,
  `目录工具：${map.catalog.length ? map.catalog.map(t => t.name).join('、') : '未识别'}`,
  `攻略工具：${map.guide.length ? map.guide.map(t => t.name).join('、') : '未识别'}`,
  `状态工具：${map.state.length ? map.state.map(t => t.name).join('、') : '未识别'}`,
  `行动工具：${map.action.length ? map.action.map(t => t.name).join('、') : '未识别'}`,
];

export const loadCedarConnection = (): CedarToyConnection => {
  try {
    const value = JSON.parse(localStorage.getItem(CEDAR_CONNECTION_KEY) || '{}');
    return { url: typeof value.url === 'string' ? value.url : '', token: value.token || '', proxyUrl: value.proxyUrl || '', proxyKey: value.proxyKey || '', updatedAt: Number(value.updatedAt) || 0, tools: Array.isArray(value.tools) ? value.tools : undefined };
  } catch { return { url: '', token: '', proxyUrl: '', proxyKey: '', updatedAt: 0 }; }
};

export const saveCedarConnection = (connection: CedarToyConnection): void => {
  localStorage.setItem(CEDAR_CONNECTION_KEY, JSON.stringify(connection));
};

export const clearCedarConnection = (): void => localStorage.removeItem(CEDAR_CONNECTION_KEY);

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
