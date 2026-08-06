import type { CharacterProfile } from '../types';

export const GAME_HALL_AUTOPLAY_COMMAND_EVENT =
  'sullyos:game-hall-autoplay-command';
export const GAME_HALL_AUTOPLAY_STATE_EVENT =
  'sullyos:game-hall-autoplay-state';

export const GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY =
  'sullyos_game_hall_autoplay_commands_v1';

export type GameHallAutoplayCommandType =
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop';

export interface GameHallAutoplayStartPayload {
  instruction?: string;
  gameHint?: string;
  goal?: string;
  returnToMainChat?: boolean;
}

export interface GameHallAutoplayCommand {
  id: string;
  charId: string;
  type: GameHallAutoplayCommandType;
  payload?: GameHallAutoplayStartPayload;
  createdAt: number;
  source: 'assistant-output' | 'game-hall-ui';
}

const id = () =>
  `ghcmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const safeObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const stringOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
};

const parseStartPayload = (raw: string | undefined): GameHallAutoplayStartPayload => {
  if (!raw?.trim()) return {};
  try {
    const source = safeObject(JSON.parse(raw));
    return {
      instruction: stringOrUndefined(source.instruction),
      gameHint: stringOrUndefined(source.gameHint),
      goal: stringOrUndefined(source.goal),
      returnToMainChat:
        typeof source.returnToMainChat === 'boolean'
          ? source.returnToMainChat
          : undefined,
    };
  } catch {
    // JSON 损坏不能让隐藏标记泄漏进聊天；仍启动，原文当作自然语言指令。
    return { instruction: raw.trim() };
  }
};

const COMMAND_RE =
  /\[\[GAME_HALL_AUTOPLAY_(START|PAUSE|RESUME|STOP)(?:\s+([\s\S]*?))?\]\]/gi;

export function stripAndParseGameHallAutoplayCommands(
  raw: string,
  charId: string,
): {
  displayText: string;
  commands: GameHallAutoplayCommand[];
} {
  const commands: GameHallAutoplayCommand[] = [];
  const displayText = String(raw || '').replace(
    COMMAND_RE,
    (_full, verbRaw: string, payloadRaw?: string) => {
      const verb = verbRaw.toLowerCase() as
        | 'start'
        | 'pause'
        | 'resume'
        | 'stop';
      commands.push({
        id: id(),
        charId,
        type: verb,
        payload: verb === 'start'
          ? parseStartPayload(payloadRaw)
          : undefined,
        createdAt: Date.now(),
        source: 'assistant-output',
      });
      return '';
    },
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { displayText, commands };
}

function readQueue(): GameHallAutoplayCommand[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(value: GameHallAutoplayCommand[]): void {
  localStorage.setItem(
    GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY,
    JSON.stringify(value),
  );
}

export function enqueueGameHallAutoplayCommands(
  commands: GameHallAutoplayCommand[],
): void {
  if (!commands.length) return;
  const current = readQueue();
  const seen = new Set(current.map(command => command.id));
  const next = [
    ...current,
    ...commands.filter(command => !seen.has(command.id)),
  ];
  writeQueue(next);
  try {
    window.dispatchEvent(
      new CustomEvent(GAME_HALL_AUTOPLAY_COMMAND_EVENT),
    );
  } catch {
    // SSR / test
  }
}

export function peekGameHallAutoplayCommands(): GameHallAutoplayCommand[] {
  return readQueue().sort((a, b) => a.createdAt - b.createdAt);
}

export function clearGameHallAutoplayCommandQueue(): void {
  localStorage.removeItem(
    GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY,
  );
  try {
    window.dispatchEvent(
      new CustomEvent(GAME_HALL_AUTOPLAY_COMMAND_EVENT),
    );
  } catch {
    // SSR / test
  }
}

export function acknowledgeGameHallAutoplayCommand(commandId: string): void {
  writeQueue(readQueue().filter(command => command.id !== commandId));
}

export function createGameHallAutoplayUiCommand(
  charId: string,
  type: GameHallAutoplayCommandType,
  payload?: GameHallAutoplayStartPayload,
): GameHallAutoplayCommand {
  return {
    id: id(),
    charId,
    type,
    payload,
    createdAt: Date.now(),
    source: 'game-hall-ui',
  };
}

/**
 * 只给正常主聊天注入。
 * GameHall Agent 必须传 allowGameHallAutoplayControl=false，避免自主 runner
 * 在自己的输出里再次发 START，形成递归启动。
 */
export function buildGameHallAutoplayControlPrompt(
  char: Pick<CharacterProfile, 'name'>,
): string {
  return `
## 游戏厅自主游玩控制

你可以在用户明确允许、邀请或要求你独自去游戏厅玩时，自主决定是否接受。
例如“你可以去玩”“自己挑个游戏玩会儿”“去把那局继续玩完”。

当你确实决定现在就去时：
1. 先像平时一样自然回复用户；
2. 在回复末尾附加一条客户端控制标记：

[[GAME_HALL_AUTOPLAY_START {"instruction":"你准备怎么去玩","gameHint":"可选游戏线索","goal":"可选目标","returnToMainChat":true}]]

规则：
- 只有用户当前真的在授权或要求你去玩时才发 START；
- 讨论功能、假设句、回忆过去时不要发；
- 不要要求用户每回合确认，启动后客户端会让你连续自主行动；
- 想暂停时可发 [[GAME_HALL_AUTOPLAY_PAUSE]]；
- 想继续时可发 [[GAME_HALL_AUTOPLAY_RESUME]]；
- 用户要求停止时发 [[GAME_HALL_AUTOPLAY_STOP]]；
- 标记是客户端指令，不要解释标记本身；
- 不要伪造已经玩过的结果。真正游戏过程由游戏厅 MCP 完成。

角色名：${char.name}
`;
}
