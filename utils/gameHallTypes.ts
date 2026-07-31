import type { McpToolDef } from './mcpClient';

export type GameHallCompanionMode = 'observe' | 'ask-before-action' | 'auto-turn';
export type CedarCapability = 'account' | 'catalog' | 'guide' | 'state' | 'action';
export type GameHallMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type GameHallSessionStatus = 'active' | 'ended';

export interface CedarToyConnection {
  url: string; token?: string; proxyUrl?: string; proxyKey?: string; updatedAt: number; tools?: McpToolDef[];
}
export interface CedarCapabilityMap {
  account: McpToolDef[]; catalog: McpToolDef[]; guide: McpToolDef[]; state: McpToolDef[]; action: McpToolDef[]; unknown: McpToolDef[];
}
export interface GameHallWebState { url: string; title?: string; loading: boolean; canGoBack?: boolean; }
export interface GameHallSession {
  id: string; charId: string; mode: GameHallCompanionMode; status: GameHallSessionStatus; createdAt: number; updatedAt: number;
  gameId?: string; gameName?: string; accountBinding?: Record<string, string>; lastStateHash?: string; lastAutoActionStateHash?: string;
}
export interface GameHallMessage {
  id: string; sessionId: string; charId: string; role: GameHallMessageRole; content: string; createdAt: number;
  toolName?: string; toolResultSummary?: string;
}
export interface GameHallPendingAction {
  id: string; sessionId: string; charId: string; toolName: string; args: Record<string, unknown>; reason: string; stateHash?: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed'; createdAt: number; updatedAt: number; error?: string;
}
export interface GameHallBridgeSnapshot {
  id: string; sessionId: string; charId: string; summary: string; eventIds: string[]; createdAt: number; expiresAt?: number;
}
export interface NormalizedCedarGameState {
  raw: unknown; summary: string; stateHash: string; gameId?: string; gameName?: string; currentTurn?: string; allowsAiAction?: boolean;
}
