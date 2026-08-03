import type { McpToolDef, McpToolResult } from './mcpClient';

export type GameHallCompanionMode = 'observe' | 'ask-before-action' | 'auto-turn';
export type CedarCapability = 'account' | 'catalog' | 'guide' | 'state' | 'action';
export type GameHallMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type GameHallSessionStatus = 'active' | 'ended';

export interface CedarToyConnection {
  url: string;
  token?: string;
  proxyUrl?: string;
  proxyKey?: string;
  updatedAt: number;
  tools?: McpToolDef[];
}

export interface CedarCapabilityMap {
  account: McpToolDef[];
  catalog: McpToolDef[];
  guide: McpToolDef[];
  state: McpToolDef[];
  action: McpToolDef[];
  unknown: McpToolDef[];
}

export interface GameHallWebState {
  url: string;
  title?: string;
  loading: boolean;
  canGoBack?: boolean;
}

/**
 * 角色在外部游戏平台的结构化账号档案。
 *
 * 这是登录资料的唯一真实来源：模型只选择 accountRef，不抄写 Token。
 * credentials 与 rawRegistrationResult 都按 MCP 原始返回保存，不脱敏、不截断。
 */
export interface CharacterExternalAccount {
  accountRef: string;
  charId: string;
  provider: string;
  serverId: string;
  serverUrl: string;
  sourceToolName: string;
  accountId?: string;
  username?: string;
  credentials: Record<string, unknown>;
  /** 首次创建账号时的完整返回，后续账号工具调用不会覆盖。 */
  rawRegistrationResult: unknown;
  /** 最近一次账号相关工具的完整返回。 */
  lastToolResult?: unknown;
  /** 账号相关工具历史，按调用顺序完整保存。 */
  rawToolResults?: Array<{ toolName: string; result: unknown; createdAt: number }>;
  status: 'active' | 'disabled';
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface GameHallSession {
  id: string;
  charId: string;
  mode: GameHallCompanionMode;
  status: GameHallSessionStatus;
  createdAt: number;
  updatedAt: number;
  gameId?: string;
  gameName?: string;
  /** provider/server key -> accountRef。仅保存引用，不复制凭证。 */
  accountBinding?: Record<string, string>;
  lastStateHash?: string;
  lastAutoActionStateHash?: string;
  /** 上一次写入主对话交接卡的时间。 */
  lastHandoffAt?: number;
  /** 上一次写入主对话交接卡时覆盖到的游戏厅消息时间。 */
  lastHandoffMessageAt?: number;
}

/**
 * 可被 IndexedDB structured clone 的 MCP 完整结果快照。
 * 这里保留全部字段，不用摘要替代原始返回。
 */
export type GameHallToolResultSnapshot = McpToolResult;

export interface GameHallMessage {
  id: string;
  sessionId: string;
  charId: string;
  role: GameHallMessageRole;
  content: string;
  createdAt: number;
  toolName?: string;
  /** 完整 MCP 返回。旧字段 toolResultSummary 只为读取旧存档兼容。 */
  toolResult?: GameHallToolResultSnapshot;
  toolResultSummary?: string;
  /** 注册/登录工具成功后落库的账号引用。 */
  accountRef?: string;
}

export interface GameHallPendingAction {
  id: string;
  sessionId: string;
  charId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** 模型只传账号引用；客户端调用前从账号档案注入精确凭证。 */
  accountRef?: string;
  reason: string;
  stateHash?: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed';
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface GameHallBridgeSnapshot {
  id: string;
  sessionId: string;
  charId: string;
  summary: string;
  eventIds: string[];
  createdAt: number;
  expiresAt?: number;
}

export interface NormalizedCedarGameState {
  raw: unknown;
  summary: string;
  stateHash: string;
  gameId?: string;
  gameName?: string;
  currentTurn?: string;
  allowsAiAction?: boolean;
}

export interface GameHallHandoffLine {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
  accountRef?: string;
  createdAt: number;
}

export interface GameHallHandoffMeta {
  gameHallCard: true;
  sessionId: string;
  charId: string;
  provider: string;
  gameId?: string;
  gameName?: string;
  title: string;
  summary: string;
  transcript: GameHallHandoffLine[];
  accountRefs: string[];
  createdAt: number;
}
