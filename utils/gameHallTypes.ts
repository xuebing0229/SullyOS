import type { McpToolDef } from './mcpClient';

export type GameHallCompanionMode = 'observe' | 'ask-before-action' | 'auto-turn';
export type CedarCapability = 'account' | 'catalog' | 'guide' | 'state' | 'action';

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
