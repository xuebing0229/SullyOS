import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  GameController,
  Pause,
  Play,
  Stop,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import {
  acknowledgeGameHallAutoplayCommand,
  GAME_HALL_AUTOPLAY_COMMAND_EVENT,
  GAME_HALL_AUTOPLAY_STATE_EVENT,
  peekGameHallAutoplayCommands,
} from '../utils/gameHallAutoplayIntent';
import {
  loadGameHallApiSettings,
  resolveGameHallApiConfig,
} from '../utils/gameHallApiPreset';
import {
  getActiveGameHallSession,
  saveGameHallSession,
  gameHallId,
} from '../utils/gameHallStore';
import {
  pauseGameHallAutoplay,
  requestStopGameHallAutoplay,
  resumeGameHallAutoplay,
  runGameHallAutoplay,
  startGameHallAutoplay,
  type GameHallAutoplayProgress,
} from '../utils/gameHallAutoplayRunner';
import {
  loadCedarConnection,
} from '../utils/cedarToyMcpAdapter';
import type {
  GameHallSession,
} from '../utils/gameHallTypes';

interface BannerState extends GameHallAutoplayProgress {
  updatedAt: number;
}

const GameHallAutoplayHost: React.FC = () => {
  const {
    characters,
    apiConfig,
    apiPresets,
    userProfile,
    groups,
    realtimeConfig,
    memoryPalaceConfig,
    addToast,
    setActiveCharacterId,
    openApp,
  } = useOS();

  const [banner, setBanner] =
    useState<BannerState | null>(null);
  const processingCommandsRef = useRef(false);
  const wakeRef = useRef(0);

  const charMap = useMemo(
    () => new Map(characters.map(char => [char.id, char])),
    [characters],
  );

  const progress = useCallback(
    (detail: GameHallAutoplayProgress) => {
      setBanner({ ...detail, updatedAt: Date.now() });
    },
    [],
  );

  const ensureSession = useCallback(
    async (charId: string): Promise<GameHallSession> => {
      const current = await getActiveGameHallSession(charId);
      if (current) {
        if (current.status === 'active') return current;
        const reopened = {
          ...current,
          status: 'active' as const,
          updatedAt: Date.now(),
        };
        await saveGameHallSession(reopened);
        return reopened;
      }
      const now = Date.now();
      const created: GameHallSession = {
        id: gameHallId('ghsession'),
        charId,
        mode: 'auto-turn',
        status: 'active',
        contextMessageLimit: null,
        schemaValidationMode: 'off',
        planRepairAttempts: 0,
        autoArchiveAccounts: true,
        createdAt: now,
        updatedAt: now,
      };
      await saveGameHallSession(created);
      return created;
    },
    [],
  );

  const startRunnerForSession = useCallback(
    async (session: GameHallSession) => {
      const char = charMap.get(session.charId);
      if (!char || !session.autoplay) return;
      if (
        !['queued', 'running', 'paused', 'stopping']
          .includes(session.autoplay.status)
      ) {
        return;
      }

      const settings = loadGameHallApiSettings();
      const resolved = resolveGameHallApiConfig(
        apiConfig,
        apiPresets,
        settings,
      );
      const connection = loadCedarConnection();
      if (!connection.url) {
        const failed = {
          ...session,
          autoplay: {
            ...session.autoplay,
            status: 'failed' as const,
            stopReason: 'mcp-error' as const,
            lastError: '尚未配置游戏厅 MCP 连接',
            updatedAt: Date.now(),
            completedAt: Date.now(),
          },
          updatedAt: Date.now(),
        };
        await saveGameHallSession(failed);
        addToast(
          `${char.name}没能去玩：尚未配置游戏厅 MCP`,
          'error',
        );
        return;
      }

      void runGameHallAutoplay({
        sessionId: session.id,
        connection,
        apiConfig: resolved.config,
        char,
        userProfile,
        groups,
        realtimeConfig,
        memoryPalaceConfig,
        onProgress: progress,
      }).catch(error => {
        console.error('[GameHallAutoplayHost]', error);
      });
    },
    [
      addToast,
      apiConfig,
      apiPresets,
      charMap,
      groups,
      memoryPalaceConfig,
      progress,
      realtimeConfig,
      userProfile,
    ],
  );

  const processCommands = useCallback(async () => {
    if (processingCommandsRef.current) return;
    processingCommandsRef.current = true;
    try {
      const commands = peekGameHallAutoplayCommands();
      for (const command of commands) {
        const char = charMap.get(command.charId);
        if (!char) {
          acknowledgeGameHallAutoplayCommand(command.id);
          continue;
        }
        try {
          let session = await ensureSession(char.id);
          const settings = loadGameHallApiSettings();

          if (command.type === 'start') {
            session = await startGameHallAutoplay({
              session,
              requestedFrom:
                command.source === 'assistant-output'
                  ? 'main-chat'
                  : 'game-hall',
              instruction: command.payload?.instruction,
              gameHint: command.payload?.gameHint,
              goal: command.payload?.goal,
              returnToMainChat:
                command.payload?.returnToMainChat
                ?? settings.autoHandoffOnFinish,
              maxTurns: settings.maxTurns,
              stepDelayMs: settings.stepDelayMs,
            });
            addToast(
              `${char.name}去游戏厅自己玩了`,
              'success',
            );
          } else if (command.type === 'pause') {
            session = await pauseGameHallAutoplay(session);
            addToast(`${char.name}已暂停游玩`, 'info');
          } else if (command.type === 'resume') {
            session = await resumeGameHallAutoplay(session);
            addToast(`${char.name}继续玩了`, 'info');
          } else {
            session = await requestStopGameHallAutoplay(session);
            addToast(
              `${char.name}会在当前这一步结束后停下来`,
              'info',
            );
          }

          acknowledgeGameHallAutoplayCommand(command.id);
          await startRunnerForSession(session);
        } catch (error: any) {
          console.error(
            '[GameHallAutoplayHost] command failed',
            command,
            error,
          );
          // 命令保留在队列，下一次唤醒可重试。
          break;
        }
      }
    } finally {
      processingCommandsRef.current = false;
    }
  }, [addToast, charMap, ensureSession, startRunnerForSession]);

  const wakeAll = useCallback(async () => {
    wakeRef.current += 1;
    await processCommands();
    for (const char of characters) {
      const session =
        await getActiveGameHallSession(char.id);
      if (session) {
        await startRunnerForSession(session);
      }
    }
  }, [characters, processCommands, startRunnerForSession]);

  useEffect(() => {
    void wakeAll();

    const wake = () => void wakeAll();
    const visible = () => {
      if (document.visibilityState === 'visible') wake();
    };

    window.addEventListener(
      GAME_HALL_AUTOPLAY_COMMAND_EVENT,
      wake,
    );
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', visible);

    return () => {
      window.removeEventListener(
        GAME_HALL_AUTOPLAY_COMMAND_EVENT,
        wake,
      );
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener(
        'visibilitychange',
        visible,
      );
    };
  }, [wakeAll]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail =
        (event as CustomEvent<GameHallAutoplayProgress>).detail;
      if (detail) {
        setBanner({ ...detail, updatedAt: Date.now() });
      }
    };
    window.addEventListener(
      GAME_HALL_AUTOPLAY_STATE_EVENT,
      listener,
    );
    return () => window.removeEventListener(
      GAME_HALL_AUTOPLAY_STATE_EVENT,
      listener,
    );
  }, []);

  const sendControl = async (
    action: 'pause' | 'resume' | 'stop',
  ) => {
    if (!banner) return;
    const session =
      await getActiveGameHallSession(banner.charId);
    if (!session) return;
    const next =
      action === 'pause'
        ? await pauseGameHallAutoplay(session)
        : action === 'resume'
          ? await resumeGameHallAutoplay(session)
          : await requestStopGameHallAutoplay(session);
    await startRunnerForSession(next);
  };

  if (!banner) return null;
  const visible =
    banner.status === 'queued'
    || banner.status === 'running'
    || banner.status === 'paused'
    || banner.status === 'stopping';
  if (!visible) return null;

  return (
    <div
      className="fixed left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-violet-300/20 bg-slate-950/92 px-3 py-2 text-white shadow-2xl backdrop-blur"
      style={{ top: 'calc(var(--safe-top) + 10px)' }}
    >
      <button
        className="flex min-w-0 items-center gap-2"
        onClick={() => {
          setActiveCharacterId(banner.charId);
          openApp('game_hall' as any);
        }}
      >
        <GameController
          size={19}
          className="shrink-0 text-violet-300"
          weight="fill"
        />
        <span className="max-w-[190px] truncate text-xs">
          {banner.text}
        </span>
      </button>

      {banner.status === 'paused' ? (
        <button
          onClick={() => void sendControl('resume')}
          aria-label="继续自主游玩"
        >
          <Play size={17} />
        </button>
      ) : (
        <button
          onClick={() => void sendControl('pause')}
          aria-label="暂停自主游玩"
        >
          <Pause size={17} />
        </button>
      )}
      <button
        onClick={() => void sendControl('stop')}
        aria-label="停止自主游玩"
      >
        <Stop size={17} />
      </button>
    </div>
  );
};

export default GameHallAutoplayHost;
