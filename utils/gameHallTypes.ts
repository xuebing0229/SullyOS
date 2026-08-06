import type { McpToolDef, McpToolResult } from './mcpClient';

export type GameHallCompanionMode = 'observe' | 'ask-before-action' | 'auto-turn';
export type GameHallSchemaValidationMode = 'off' | 'warn' | 'strict';
export type CedarCapability = 'account' | 'catalog' | 'guide' | 'state' | 'action';
export type GameHallMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type GameHallSessionStatus = 'active' | 'ended';

export interface CedarToyConnection {
  url: string;
  token?: string;
  proxyUrl?: string;
  proxyKey?: string;
  updatedAt: number;
  /** tools/list 的原始顺序与全部 schema。禁止筛选、去重或重写。 */
  tools?: McpToolDef[];
}

/** 仅用于设置页的辅助说明。不能控制工具可见性、执行、账号保存或状态读取。 */
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

export interface CharacterExternalAccount {
  accountRef: string;
  charId: string;
  provider: string;
  serverId: string;
  serverUrl: string;
  identityEndpoint?: string;
  sourceToolName: string;
  accountId?: string;
  username?: string;
  credentials: Record<string, unknown>;
  rawRegistrationResult: unknown;
  lastToolResult?: unknown;
  rawToolResults?: Array<{ toolName: string; result: unknown; createdAt: number }>;
  status: 'active' | 'disabled';
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}


export type GameHallAutoplayStatus =
  | 'queued' | 'running' | 'paused' | 'stopping'
  | 'completed' | 'cancelled' | 'failed';

export type GameHallAutoplayStopReason =
  | 'character-finished' | 'user-paused' | 'user-stopped'
  | 'visible-turn-limit' | 'api-error' | 'mcp-error'
  | 'handoff-error' | 'session-replaced' | 'restored-from-backup';

export interface GameHallAutoplayState {
  version: 1;
  runId: string;
  status: GameHallAutoplayStatus;
  requestedFrom: 'main-chat' | 'game-hall';
  instruction: string;
  gameHint?: string;
  goal?: string;
  returnToMainChat: boolean;
  turnCount: number;
  maxTurns: number | null;
  stepDelayMs: number;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  lastPlannedAt?: number;
  lastActionAt?: number;
  lastActionId?: string;
  latestState?: NormalizedCedarGameState;
  stopReason?: GameHallAutoplayStopReason;
  restoredFromBackupAt?: number;
  lastError?: string;
  handoffMessageId?: number;
  handoffCompletedAt?: number;
  handoffError?: string;
}

export type GameHallDisplayMessageType = 'text' | 'emoji';

export interface GameHallActiveReplyTurn {
  turnId: string;
  userMessageIds: string[];
  status: 'running' | 'failed';
  requestedAt: number;
  updatedAt: number;
  error?: string;
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
  /** 用户正在连续发送、尚未封口的回合。 */
  openTurnId?: string;
  /** 当前正在请求或请求失败、可手动重试的已封口回合。 */
  activeReplyTurn?: GameHallActiveReplyTurn;
  lastCompletedTurnId?: string;
  /** 当前显式选择的角色身份；空值表示使用基础 MCP 连接。 */
  activeAccountRef?: string;
  accountBinding?: Record<string, string>;
  lastHandoffAt?: number;
  lastHandoffMessageAt?: number;
  /** null/0 = 全部；正整数 = 最近 N 条。只影响模型上下文，绝不触发删除。 */
  contextMessageLimit?: number | null;
  /** 默认 off。warn 只提示不拦截；strict 才会阻止不符合 schema 的行动。 */
  schemaValidationMode?: GameHallSchemaValidationMode;
  /** 模型规划无法解析/校验失败后自动修正次数。默认 0，不偷偷增加调用。 */
  planRepairAttempts?: number;
  /** 成功结果里检测到账号/凭证时是否自动建档。默认 true，设置页可见。 */
  autoArchiveAccounts?: boolean;
  autoplay?: GameHallAutoplayState;
}

export type GameHallToolResultSnapshot = McpToolResult;

export interface GameHallImageAttachment {
  displayDataUrl: string;
  visionDataUrl: string;
  fileName?: string;
  mimeType?: string;
  isAnimatedGif?: boolean;
}

export interface GameHallToolRequestSnapshot {
  toolName: string;
  /** tools/list 原始数组下标；用于同名工具，不会丢掉重复项。 */
  toolIndex?: number;
  modelArgs: Record<string, unknown>;
  finalArgs: Record<string, unknown>;
  serverUrl: string;
  accountRef?: string;
  usedIdentityEndpoint?: boolean;
  validationMode?: GameHallSchemaValidationMode;
  validationWarnings?: string[];
}

export interface GameHallMessage {
  id: string;
  sessionId: string;
  charId: string;
  role: GameHallMessageRole;
  content: string;
  createdAt: number;
  turnId?: string;
  batchIndex?: number;
  displayType?: GameHallDisplayMessageType;
  emojiUrl?: string;
  emojiName?: string;
  thinkingChain?: string;
  replyRequestedAt?: number;
  image?: GameHallImageAttachment;
  toolName?: string;
  toolRequest?: GameHallToolRequestSnapshot;
  toolResult?: GameHallToolResultSnapshot;
  toolResultSummary?: string;
  accountRef?: string;
}

export interface GameHallPendingAction {
  id: string;
  sessionId: string;
  charId: string;
  turnId?: string;
  toolName: string;
  toolIndex?: number;
  args: Record<string, unknown>;
  accountRef?: string;
  reason: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed';
  createdAt: number;
  updatedAt: number;
  error?: string;
  validationWarnings?: string[];
  modelRaw?: string;
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
  handoffId: string;
  sessionId: string;
  charId: string;
  provider: string;
  gameId?: string;
  gameName?: string;
  title: string;
  summary: string;
  transcript: GameHallHandoffLine[];
  accountRefs: string[];
  sourceMessageIds: string[];
  sourceMessageCount: number;
  transferredImageCount: number;
  createdAt: number;
}
