import type {
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import type { GameHallApiIdentity } from './gameHallAiSettings';
import {
  executePendingGameHallAction,
  planGameHallTurn,
  stateFromGameHallToolResult,
} from './gameHallAgent';
import {
  persistCharacterAccountFromToolResultIfPresent,
} from './gameHallAccount';
import {
  listCharacterExternalAccounts,
} from './characterExternalAccountStore';
import {
  createGameHallMainChatHandoff,
} from './gameHallHandoff';
import {
  gameHallId,
  getGameHallMessages,
  getGameHallSession,
  saveGameHallMessage,
  saveGameHallSession,
  savePendingGameHallAction,
} from './gameHallStore';
import type {
  CedarToyConnection,
  GameHallAutoplayState,
  GameHallAutoplayStatus,
  GameHallAutoplayStopReason,
  GameHallMessage,
  GameHallPendingAction,
  GameHallSession,
} from './gameHallTypes';
import {
  GAME_HALL_AUTOPLAY_STATE_EVENT,
} from './gameHallAutoplayIntent';
import {
  announceChatGen,
  CHAT_GEN_EVENTS,
} from './chatGenEvents';
import { isCorrectableGameHallToolFailure } from './gameHallToolCorrection';
import { DB } from './db';

interface MemoryConfigLike {
  embedding?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
  };
  lightLLM?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}

export interface GameHallAutoplayRunnerDeps {
  sessionId: string;
  connection: CedarToyConnection;
  resolveApi: () => { apiConfig: APIConfig; apiIdentity: GameHallApiIdentity };
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
  memoryPalaceConfig?: MemoryConfigLike;
  onProgress?: (detail: GameHallAutoplayProgress) => void;
}

export interface GameHallAutoplayProgress {
  sessionId: string;
  charId: string;
  charName: string;
  status: GameHallAutoplayStatus;
  turnCount: number;
  text: string;
}

export interface StartGameHallAutoplayInput {
  session: GameHallSession;
  requestedFrom: 'main-chat' | 'game-hall';
  instruction?: string;
  gameHint?: string;
  goal?: string;
  returnToMainChat?: boolean;
  maxTurns: number | null;
  stepDelayMs: number;
}

const running = new Map<string, Promise<void>>();

const sleep = (ms: number) =>
  ms <= 0
    ? Promise.resolve()
    : new Promise<void>(resolve => setTimeout(resolve, ms));

const emitState = (
  session: GameHallSession,
  charName: string,
  text: string,
  onProgress?: GameHallAutoplayRunnerDeps['onProgress'],
) => {
  const autoplay = session.autoplay;
  if (!autoplay) return;
  const detail: GameHallAutoplayProgress = {
    sessionId: session.id,
    charId: session.charId,
    charName,
    status: autoplay.status,
    turnCount: autoplay.turnCount,
    text,
  };
  onProgress?.(detail);
  try {
    window.dispatchEvent(
      new CustomEvent(GAME_HALL_AUTOPLAY_STATE_EVENT, { detail }),
    );
  } catch {
    // SSR / test
  }
};

const saveSessionState = async (
  session: GameHallSession,
  patch: Partial<GameHallAutoplayState>,
): Promise<GameHallSession> => {
  const latest = await getGameHallSession(session.id) || session;
  if (!latest.autoplay) return latest;
  const next: GameHallSession = {
    ...latest,
    mode: 'auto-turn',
    autoplay: {
      ...latest.autoplay,
      ...patch,
      updatedAt: Date.now(),
    },
    updatedAt: Date.now(),
  };
  await saveGameHallSession(next);
  return next;
};

const append = async (
  session: GameHallSession,
  role: GameHallMessage['role'],
  content: string,
  extra: Partial<Omit<
    GameHallMessage,
    'id' | 'sessionId' | 'charId' | 'role' | 'content' | 'createdAt'
  >> = {},
): Promise<GameHallMessage> => {
  const message: GameHallMessage = {
    id: gameHallId('ghmsg'),
    sessionId: session.id,
    charId: session.charId,
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  };
  await saveGameHallMessage(message);
  return message;
};

export async function startGameHallAutoplay(
  input: StartGameHallAutoplayInput,
): Promise<GameHallSession> {
  const now = Date.now();
  const state: GameHallAutoplayState = {
    version: 1,
    runId: gameHallId('ghrun'),
    status: 'queued',
    requestedFrom: input.requestedFrom,
    instruction:
      input.instruction?.trim()
      || '自己选择一个想玩的游戏，自主玩到你觉得告一段落。',
    gameHint: input.gameHint?.trim() || undefined,
    goal: input.goal?.trim() || undefined,
    returnToMainChat: input.returnToMainChat !== false,
    turnCount: 0,
    maxTurns: input.maxTurns,
    stepDelayMs: Math.max(0, input.stepDelayMs),
    createdAt: now,
    updatedAt: now,
  };
  const session: GameHallSession = {
    ...input.session,
    mode: 'auto-turn',
    status: 'active',
    autoplay: state,
    updatedAt: now,
  };
  await saveGameHallSession(session);
  return session;
}

export async function pauseGameHallAutoplay(
  session: GameHallSession,
): Promise<GameHallSession> {
  if (!session.autoplay) return session;
  return saveSessionState(session, {
    status: 'paused',
    stopReason: 'user-paused',
  });
}

export async function resumeGameHallAutoplay(
  session: GameHallSession,
): Promise<GameHallSession> {
  if (!session.autoplay) return session;
  return saveSessionState(session, {
    status: 'queued',
    stopReason: undefined,
    restoredFromBackupAt: undefined,
    lastError: undefined,
  });
}

export async function requestStopGameHallAutoplay(
  session: GameHallSession,
): Promise<GameHallSession> {
  if (!session.autoplay) return session;
  return saveSessionState(session, {
    status: 'stopping',
    stopReason: 'user-stopped',
  });
}

const syntheticTurnText = (
  session: GameHallSession,
): string => {
  const autoplay = session.autoplay!;
  return `[游戏厅自主游玩 · 第 ${autoplay.turnCount + 1} 步]
用户已经允许你自己连续游玩，不需要等用户逐回合回复。
总指令：${autoplay.instruction}
${autoplay.gameHint ? `游戏线索：${autoplay.gameHint}` : ''}
${autoplay.goal ? `目标：${autoplay.goal}` : ''}

现在查看完整游戏厅历史、最新工具返回和全部真实工具，决定下一步。
想继续就选择一个真实 MCP 行动；认为已经玩够、游戏结束或自然告一段落时 action 返回 null。
不要为了等待用户而停下。`;
};

async function finalizeRun(
  deps: GameHallAutoplayRunnerDeps,
  session: GameHallSession,
  status: 'completed' | 'cancelled' | 'failed',
  reason: GameHallAutoplayStopReason,
  error?: string,
): Promise<void> {
  let next = await saveSessionState(session, {
    status,
    stopReason: reason,
    lastError: error,
    completedAt: Date.now(),
  });
  emitState(
    next,
    deps.char.name,
    status === 'completed'
      ? `${deps.char.name}已经玩完了`
      : status === 'cancelled'
        ? `${deps.char.name}已停止自主游玩`
        : `${deps.char.name}自主游玩中断：${error || reason}`,
    deps.onProgress,
  );

  const autoplay = next.autoplay;
  if (
    !autoplay
    || !autoplay.returnToMainChat
    || (status === 'failed' && reason !== 'handoff-error')
  ) {
    return;
  }

  try {
    emitState(
      next,
      deps.char.name,
      '正在把这次游戏经历带回主聊天…',
      deps.onProgress,
    );
    const [messages, accounts] = await Promise.all([
      getGameHallMessages(next.id),
      listCharacterExternalAccounts(next.charId),
    ]);
    const requestAi = deps.resolveApi();
    const handoff = await createGameHallMainChatHandoff({
      session: next,
      messages,
      accounts,
      char: deps.char,
      userProfile: deps.userProfile,
      apiConfig: requestAi.apiConfig,
      apiIdentity: requestAi.apiIdentity,
      memoryPalaceConfig: deps.memoryPalaceConfig,
    });
    const committed =
      await getGameHallSession(next.id)
      || next;
    next = await saveSessionState(committed, {
      handoffMessageId: handoff.messageId,
      handoffCompletedAt: Date.now(),
      handoffError: undefined,
    });
    announceChatGen(CHAT_GEN_EVENTS.replyArrived, {
      charId: deps.char.id,
      charName: deps.char.name,
    });
    emitState(
      next,
      deps.char.name,
      `${deps.char.name}从游戏厅回来了`,
      deps.onProgress,
    );
  } catch (handoffError: any) {
    // 现有 handoff 自带事务回滚。这里不删游戏厅原文。
    next = await saveSessionState(next, {
      handoffError:
        handoffError?.message || String(handoffError),
    });
    emitState(
      next,
      deps.char.name,
      `游玩已结束，但回主聊天交接失败；游戏厅原文仍保留`,
      deps.onProgress,
    );
  }
}

async function runUnlocked(
  deps: GameHallAutoplayRunnerDeps,
): Promise<void> {
  for (;;) {
    const loaded = await getGameHallSession(deps.sessionId);
    if (!loaded?.autoplay) return;
    let session = loaded;
    const autoplay = loaded.autoplay;

    if (autoplay.status === 'paused') {
      const restored =
        autoplay.stopReason === 'restored-from-backup';
      emitState(
        session,
        deps.char.name,
        restored
          ? `${deps.char.name}有一场从备份恢复的游玩，已暂停`
          : `${deps.char.name}已暂停自主游玩`,
        deps.onProgress,
      );
      return;
    }

    if (autoplay.status === 'stopping') {
      await finalizeRun(
        deps,
        session,
        'cancelled',
        'user-stopped',
      );
      return;
    }

    if (
      autoplay.status === 'completed'
      || autoplay.status === 'cancelled'
      || autoplay.status === 'failed'
    ) {
      return;
    }

    if (
      autoplay.maxTurns != null
      && autoplay.turnCount >= autoplay.maxTurns
    ) {
      await finalizeRun(
        deps,
        session,
        'completed',
        'visible-turn-limit',
      );
      return;
    }

    if (autoplay.status === 'queued') {
      session = await saveSessionState(session, {
        status: 'running',
        startedAt: autoplay.startedAt || Date.now(),
      });
    }

    // 每一步都重新读取完整游戏厅历史与账号，用户中途插话或切账号，
    // 下一步立刻可见。绝不拿启动时快照一路跑到底。
    const [history, accounts] = await Promise.all([
      getGameHallMessages(session.id),
      listCharacterExternalAccounts(session.charId),
    ]);

    emitState(
      session,
      deps.char.name,
      `${deps.char.name}正在想下一步…`,
      deps.onProgress,
    );

    let plan;
    try {
      const requestAi = deps.resolveApi();
      plan = await planGameHallTurn({
        apiConfig: requestAi.apiConfig,
        apiIdentity: requestAi.apiIdentity,
        char: deps.char,
        userProfile: deps.userProfile,
        groups: deps.groups,
        realtimeConfig: deps.realtimeConfig,
        mode: 'auto-turn',
        userText: syntheticTurnText(session),
        state: autoplay.latestState,
        availableTools: deps.connection.tools || [],
        sessionId: session.id,
        history,
        accounts,
        preferredAccountRef: session.activeAccountRef,
        contextMessageLimit: session.contextMessageLimit,
        schemaValidationMode:
          session.schemaValidationMode || 'off',
        repairAttempts: session.planRepairAttempts || 0,
        autonomousRun: {
          runId: autoplay.runId,
          instruction: autoplay.instruction,
          turnCount: autoplay.turnCount,
        },
      });
    } catch (error: any) {
      await append(
        session,
        'system',
        `自主游玩规划失败：${error?.message || String(error)}`,
      );
      await finalizeRun(
        deps,
        session,
        'failed',
        'api-error',
        error?.message || String(error),
      );
      return;
    }

    const latestAfterPlan = await getGameHallSession(session.id) || session;
    if (latestAfterPlan.autoplay?.status === 'paused') {
      emitState(latestAfterPlan, deps.char.name, `${deps.char.name}已暂停自主游玩`, deps.onProgress);
      return;
    }
    if (latestAfterPlan.autoplay?.status === 'stopping') {
      await finalizeRun(deps, latestAfterPlan, 'cancelled', 'user-stopped');
      return;
    }
    session = latestAfterPlan;

    const emojis = plan.replies.some(part => part.type === 'emoji')
      ? await DB.getEmojis()
      : [];
    let firstVisibleReply = true;
    for (let index = 0; index < plan.replies.length; index += 1) {
      const part = plan.replies[index];
      if (part.type === 'emoji') {
        const emoji = emojis.find(item => item.name === part.name);
        if (!emoji) continue;
        await append(session, 'assistant', '[表情包]', {
          batchIndex: index,
          displayType: 'emoji',
          emojiName: part.name,
          emojiUrl: emoji.url,
          thinkingChain: firstVisibleReply ? plan.thinkingChain : undefined,
        });
      } else if (part.content.trim()) {
        await append(session, 'assistant', part.content.trim(), {
          batchIndex: index,
          displayType: 'text',
          thinkingChain: firstVisibleReply ? plan.thinkingChain : undefined,
        });
      } else {
        continue;
      }
      firstVisibleReply = false;
    }
    if (plan.validationWarnings?.length) {
      await append(
        session,
        'system',
        `自主游玩工具规划提示：${plan.validationWarnings.join('；')}`,
      );
    }

    if (!plan.pending) {
      await finalizeRun(
        deps,
        session,
        'completed',
        'character-finished',
      );
      return;
    }

    let action: GameHallPendingAction = {
      ...plan.pending,
      status: 'confirmed',
      updatedAt: Date.now(),
    };
    await savePendingGameHallAction(action);
    session = await saveSessionState(session, {
      lastPlannedAt: Date.now(),
      lastActionId: action.id,
    });

    emitState(
      session,
      deps.char.name,
      `${deps.char.name}正在执行 ${action.toolName}…`,
      deps.onProgress,
    );

    try {
      let correctionAttempted = false;
      let execution;
      let result;

      for (;;) {
        execution = await executePendingGameHallAction(
          deps.connection,
          action,
          session.schemaValidationMode || 'off',
        );
        result = execution.result;
        if (result.success) break;

        const failedAction: GameHallPendingAction = {
          ...action,
          status: 'failed',
          error: result.error || '工具返回失败',
          updatedAt: Date.now(),
        };
        await savePendingGameHallAction(failedAction);
        await append(
          session,
          'tool',
          `自主游玩执行 ${action.toolName} 失败。`,
          {
            toolName: action.toolName,
            toolRequest: execution.request,
            toolResult: result,
            accountRef: action.accountRef,
          },
        );

        if (
          correctionAttempted
          || !isCorrectableGameHallToolFailure(result)
        ) {
          await finalizeRun(
            deps,
            session,
            'failed',
            'mcp-error',
            failedAction.error,
          );
          return;
        }

        correctionAttempted = true;
        emitState(
          session,
          deps.char.name,
          `${deps.char.name}正在根据真实工具说明修正行动…`,
          deps.onProgress,
        );

        let correctionPlan;
        try {
          const [correctionHistory, correctionAccounts] = await Promise.all([
            getGameHallMessages(session.id),
            listCharacterExternalAccounts(session.charId),
          ]);
          const requestAi = deps.resolveApi();
          correctionPlan = await planGameHallTurn({
            apiConfig: requestAi.apiConfig,
            apiIdentity: requestAi.apiIdentity,
            char: deps.char,
            userProfile: deps.userProfile,
            groups: deps.groups,
            realtimeConfig: deps.realtimeConfig,
            mode: 'auto-turn',
            userText: syntheticTurnText(session),
            state: session.autoplay?.latestState,
            availableTools: deps.connection.tools || [],
            sessionId: session.id,
            history: correctionHistory,
            accounts: correctionAccounts,
            preferredAccountRef: session.activeAccountRef,
            contextMessageLimit: session.contextMessageLimit,
            schemaValidationMode: session.schemaValidationMode || 'off',
            // 工具失败纠错固定只调用模型一次，不叠加用户设置的规划修正次数。
            repairAttempts: 0,
            autonomousRun: {
              runId: session.autoplay!.runId,
              instruction: session.autoplay!.instruction,
              turnCount: session.autoplay!.turnCount,
            },
            toolCorrection: {
              failedAction,
              failedRequest: execution.request,
              failedResult: result,
            },
          });
        } catch (error: any) {
          await append(
            session,
            'system',
            `自主游玩工具纠错规划失败：${error?.message || String(error)}`,
          );
          await finalizeRun(
            deps,
            session,
            'failed',
            'api-error',
            error?.message || String(error),
          );
          return;
        }

        const latestAfterCorrection = await getGameHallSession(session.id) || session;
        if (latestAfterCorrection.autoplay?.status === 'paused') {
          emitState(latestAfterCorrection, deps.char.name, `${deps.char.name}已暂停自主游玩`, deps.onProgress);
          return;
        }
        if (latestAfterCorrection.autoplay?.status === 'stopping') {
          await finalizeRun(deps, latestAfterCorrection, 'cancelled', 'user-stopped');
          return;
        }
        session = latestAfterCorrection;

        if (correctionPlan.validationWarnings?.length) {
          await append(
            session,
            'system',
            `自主游玩工具纠错提示：${correctionPlan.validationWarnings.join('；')}`,
          );
        }
        if (!correctionPlan.pending) {
          await finalizeRun(
            deps,
            session,
            'failed',
            'mcp-error',
            failedAction.error,
          );
          return;
        }

        // 原失败请求和完整返回仍保留在历史；行动卡由新行动取代，不再占“待确认”。
        await savePendingGameHallAction({
          ...failedAction,
          status: 'superseded',
          updatedAt: Date.now(),
        });
        action = {
          ...correctionPlan.pending,
          status: 'confirmed',
          updatedAt: Date.now(),
        };
        await savePendingGameHallAction(action);
        session = await saveSessionState(session, {
          lastPlannedAt: Date.now(),
          lastActionId: action.id,
        });
        emitState(
          session,
          deps.char.name,
          `${deps.char.name}正在执行修正后的 ${action.toolName}…`,
          deps.onProgress,
        );
      }

      const executed: GameHallPendingAction = {
        ...action,
        status: 'executed',
        updatedAt: Date.now(),
      };
      await savePendingGameHallAction(executed);

      let savedAccount;
      if (session.autoArchiveAccounts !== false) {
        savedAccount =
          await persistCharacterAccountFromToolResultIfPresent({
            charId: deps.char.id,
            connection: deps.connection,
            toolName: action.toolName,
            result,
          });
      }

      await append(
        session,
        'tool',
        `自主游玩执行 ${action.toolName} 成功。${
          savedAccount
            ? `\n角色账号资料已完整保存：${savedAccount.accountRef}`
            : ''
        }`,
        {
          toolName: action.toolName,
          toolRequest: execution.request,
          toolResult: result,
          accountRef:
            savedAccount?.accountRef || action.accountRef,
        },
      );

      const nextState = stateFromGameHallToolResult(result);
      const latestSession =
        await getGameHallSession(session.id)
        || session;
      session = {
        ...latestSession,
        activeAccountRef:
          savedAccount?.accountRef
          || latestSession.activeAccountRef,
        gameId: nextState.gameId || latestSession.gameId,
        gameName:
          nextState.gameName || latestSession.gameName,
      };
      session = await saveSessionState(session, {
        turnCount: session.autoplay!.turnCount + 1,
        lastActionAt: Date.now(),
        latestState: nextState,
      });

      emitState(
        session,
        deps.char.name,
        `${deps.char.name}已完成第 ${session.autoplay!.turnCount} 步`,
        deps.onProgress,
      );
      await sleep(session.autoplay!.stepDelayMs);
    } catch (error: any) {
      const failedAction: GameHallPendingAction = {
        ...action,
        status: 'failed',
        error: error?.message || String(error),
        updatedAt: Date.now(),
      };
      await savePendingGameHallAction(failedAction)
        .catch(() => undefined);
      await append(
        session,
        'system',
        `自主游玩行动中断：${failedAction.error}`,
      ).catch(() => undefined);
      await finalizeRun(
        deps,
        session,
        'failed',
        'mcp-error',
        failedAction.error,
      );
      return;
    }
  }
}

export function runGameHallAutoplay(
  deps: GameHallAutoplayRunnerDeps,
): Promise<void> {
  const existing = running.get(deps.sessionId);
  if (existing) return existing;

  const task = (async () => {
    const locks = typeof navigator !== 'undefined'
      ? (navigator as any).locks
      : undefined;
    if (locks?.request) {
      await locks.request(
        `sullyos-gamehall-autoplay:${deps.sessionId}`,
        () => runUnlocked(deps),
      );
    } else {
      await runUnlocked(deps);
    }
  })().finally(() => {
    if (running.get(deps.sessionId) === task) {
      running.delete(deps.sessionId);
    }
  });

  running.set(deps.sessionId, task);
  return task;
}

export function isGameHallAutoplayRunning(
  sessionId: string,
): boolean {
  return running.has(sessionId);
}
