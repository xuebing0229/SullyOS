import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CaretDown,
  CaretUp,
  GameController,
  GearSix,
  LinkSimple,
  PaperPlaneRight,
  ShieldCheck,
  X,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import SensitiveTextInput from '../components/SensitiveTextInput';
import CedarToySurface from '../components/gameHall/CedarToySurface';
import GameHallBottomSheet from '../components/gameHall/GameHallBottomSheet';
import {
  buildCedarCapabilityMap,
  clearCedarConnection,
  describeCedarCapabilities,
  diagnoseCedarConnection,
  loadCedarConnection,
  saveCedarConnection,
} from '../utils/cedarToyMcpAdapter';
import {
  canCallWithoutGuessing,
  executePendingGameHallAction,
  planGameHallTurn,
  readCedarGameState,
  respondToGameHallToolResult,
  summarizeGameHallToolResult,
} from '../utils/gameHallAgent';
import { writeGameHallBridgeSnapshot } from '../utils/gameHallMemoryBridge';
import {
  buildGameHallSessionSummary,
  flushGameHallMemoryCandidates,
  recordGameHallMemoryEvent,
} from '../utils/gameHallMemoryCoordinator';
import {
  gameHallId,
  getActiveGameHallSession,
  getGameHallMessages,
  getPendingGameHallActions,
  saveGameHallMessage,
  saveGameHallSession,
  savePendingGameHallAction,
} from '../utils/gameHallStore';
import type { GameHallSheetSnap } from '../utils/gameHallPanelLayout';
import type {
  CedarCapabilityMap,
  CedarToyConnection,
  GameHallCompanionMode,
  GameHallMessage,
  GameHallPendingAction,
  GameHallSession,
  GameHallWebState,
  NormalizedCedarGameState,
} from '../utils/gameHallTypes';

const MODES: Array<{ id: GameHallCompanionMode; label: string }> = [
  { id: 'observe', label: '只观察' },
  { id: 'ask-before-action', label: '行动前询问' },
  { id: 'auto-turn', label: '自动回合' },
];

const GameHallApp: React.FC = () => {
  const {
    closeApp,
    characters,
    activeCharacterId,
    isLocked,
    apiConfig,
    userProfile,
    memoryPalaceConfig,
  } = useOS();

  const [charId, setCharId] = useState(activeCharacterId || characters[0]?.id || '');
  const [mode, setMode] = useState<GameHallCompanionMode>('ask-before-action');
  const [sheetSnap, setSheetSnap] = useState<GameHallSheetSnap>('collapsed');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connection, setConnection] = useState<CedarToyConnection>(() => loadCedarConnection());
  const [capabilities, setCapabilities] = useState<CedarCapabilityMap | null>(() =>
    connection.tools ? buildCedarCapabilityMap(connection.tools) : null,
  );
  const [testing, setTesting] = useState(false);
  const [diagnostic, setDiagnostic] = useState('尚未测试连接');
  const [webState, setWebState] = useState<GameHallWebState>({
    url: 'https://toy.cedarstar.org/',
    loading: true,
  });
  const [session, setSession] = useState<GameHallSession | null>(null);
  const [messages, setMessages] = useState<GameHallMessage[]>([]);
  const [pending, setPending] = useState<GameHallPendingAction[]>([]);
  const [gameState, setGameState] = useState<NormalizedCedarGameState>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => characters.find(character => character.id === charId) || characters[0],
    [characters, charId],
  );
  const sheetOpen = sheetSnap !== 'collapsed';

  const handleWebState = useCallback((state: GameHallWebState) => setWebState(state), []);

  const append = async (
    role: GameHallMessage['role'],
    content: string,
    toolName?: string,
    toolResultSummary?: string,
  ) => {
    if (!session || !selected) return;
    const message = {
      id: gameHallId('ghmsg'),
      sessionId: session.id,
      charId: selected.id,
      role,
      content,
      toolName,
      toolResultSummary,
      createdAt: Date.now(),
    };
    await saveGameHallMessage(message);
    setMessages(value => [...value, message]);
    return message;
  };

  useEffect(() => {
    if (!selected) return;
    let alive = true;

    void (async () => {
      let current = await getActiveGameHallSession(selected.id);
      if (!current) {
        const now = Date.now();
        current = {
          id: gameHallId('ghsession'),
          charId: selected.id,
          mode,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        await saveGameHallSession(current);
      } else if (current.status !== 'active') {
        current = {
          ...current,
          status: 'active',
          updatedAt: Date.now(),
        };
        await saveGameHallSession(current);
      }
      if (!alive) return;
      setSession(current);
      setMode(current.mode);
      setMessages(await getGameHallMessages(current.id));
      setPending(await getPendingGameHallActions(current.id));
    })();

    return () => {
      alive = false;
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!sheetOpen) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pending, sheetOpen]);

  const changeMode = async (next: GameHallCompanionMode) => {
    setMode(next);
    if (!session) return;
    const updated = { ...session, mode: next, updatedAt: Date.now() };
    setSession(updated);
    await saveGameHallSession(updated);
  };

  const refreshState = async (manageBusy = true) => {
    if (manageBusy) setBusy(true);
    try {
      const read = await readCedarGameState(connection);
      setGameState(read.state);
      if (session) {
        const updated = {
          ...session,
          lastStateHash: read.state.stateHash,
          gameId: read.state.gameId,
          gameName: read.state.gameName,
          updatedAt: Date.now(),
        };
        setSession(updated);
        await saveGameHallSession(updated);
      }
      await append('tool', `已通过 ${read.toolName} 读取同一存档状态。`, read.toolName);
      return read.state;
    } catch (error: any) {
      await append('system', error?.message || String(error));
      throw error;
    } finally {
      if (manageBusy) setBusy(false);
    }
  };

  const executeAction = async (action: GameHallPendingAction, automatic = false) => {
    setBusy(true);
    const running = { ...action, status: 'confirmed' as const, updatedAt: Date.now() };
    await savePendingGameHallAction(running);

    let result;
    try {
      result = await executePendingGameHallAction(connection, running);
      if (!result.success) throw new Error(result.error || '行动失败');
    } catch (error: any) {
      const failed = {
        ...running,
        status: 'failed' as const,
        error: error?.message || String(error),
        updatedAt: Date.now(),
      };
      await savePendingGameHallAction(failed);
      await append('system', `行动失败：${failed.error}`);
      setBusy(false);
      return;
    }

    const done = { ...running, status: 'executed' as const, updatedAt: Date.now() };
    await savePendingGameHallAction(done);
    setPending(value => value.filter(item => item.id !== action.id));

    try {
      const toolResultSummary = summarizeGameHallToolResult(result);
      const executionLabel = automatic ? '自动回合' : '已确认';
      await append(
        'tool',
        `${executionLabel}执行 ${action.toolName} 成功。${
          toolResultSummary ? `\n\n工具返回：\n${toolResultSummary}` : ''
        }`,
        action.toolName,
        toolResultSummary,
      );

      const actionSummary = `我和${selected?.name || '角色'}刚刚在 Cedar Toy 共同游戏；${selected?.name || '角色'}${automatic ? '按自动回合规则' : '经我确认'}执行了 ${action.toolName}，原因：${action.reason}。`;
      await writeGameHallBridgeSnapshot({
        sessionId: action.sessionId,
        charId: action.charId,
        summary: actionSummary,
      });
      await recordGameHallMemoryEvent({
        sessionId: action.sessionId,
        charId: action.charId,
        kind: 'action',
        text: actionSummary,
        gameId: session?.gameId,
        gameName: session?.gameName,
      });

      try {
        const reply = await respondToGameHallToolResult({
          apiConfig,
          char: selected!,
          userProfile,
          action,
          toolResultSummary,
          history: messages,
        });
        if (reply) {
          const assistantMessage = await append('assistant', reply);
          await recordGameHallMemoryEvent({
            sessionId: action.sessionId,
            charId: action.charId,
            kind: 'assistant_message',
            text: reply,
            sourceMessageIds: assistantMessage ? [assistantMessage.id] : [],
            gameId: session?.gameId,
            gameName: session?.gameName,
          });
        }
      } catch {
        // 工具结果已经真实显示并落库；角色化复述失败不能把已成功的工具改判为失败。
      }

      const hasCallableStateTool = (capabilities?.state || []).some(tool =>
        canCallWithoutGuessing(tool, {}),
      );
      if (hasCallableStateTool) {
        try {
          await refreshState(false);
        } catch {
          // 状态刷新是后处理，失败不能推翻已经成功的账号/行动工具。
        }
      }
    } catch (error: any) {
      await append(
        'system',
        `工具已经执行成功，但结果整理或保存失败：${error?.message || String(error)}`,
      ).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const cancelAction = async (action: GameHallPendingAction) => {
    await savePendingGameHallAction({
      ...action,
      status: 'cancelled',
      updatedAt: Date.now(),
    });
    setPending(value => value.filter(item => item.id !== action.id));
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !session || !selected || busy) return;

    setInput('');
    setBusy(true);
    try {
      const userMessage = await append('user', text);
      await recordGameHallMemoryEvent({
        sessionId: session.id,
        charId: selected.id,
        kind: 'user_message',
        text,
        sourceMessageIds: userMessage ? [userMessage.id] : [],
        gameId: session.gameId,
        gameName: session.gameName,
      });

      let state = gameState;
      try {
        state = await readCedarGameState(connection).then(result => result.state);
        setGameState(state);
      } catch {
        // The companion can still chat when the state tool is unavailable.
      }

      const plan = await planGameHallTurn({
        apiConfig,
        char: selected,
        userProfile,
        mode,
        userText: text,
        state,
        actionTools: capabilities?.action || [],
        sessionId: session.id,
        history: [...messages, ...(userMessage ? [userMessage] : [])],
      });

      const assistantMessage = await append('assistant', plan.reply);
      await recordGameHallMemoryEvent({
        sessionId: session.id,
        charId: selected.id,
        kind: 'assistant_message',
        text: plan.reply,
        signal: plan.memorySignal,
        sourceMessageIds: assistantMessage ? [assistantMessage.id] : [],
        gameId: state?.gameId || session.gameId,
        gameName: state?.gameName || session.gameName,
      });
      await buildGameHallSessionSummary({
        sessionId: session.id,
        charId: selected.id,
        gameId: state?.gameId || session.gameId,
        gameName: state?.gameName || session.gameName,
      });
      await flushGameHallMemoryCandidates({
        charId: selected.id,
        embedding: memoryPalaceConfig.embedding,
      });

      if (plan.pending) {
        if (
          mode === 'auto-turn' &&
          state?.allowsAiAction &&
          session.lastAutoActionStateHash !== state.stateHash
        ) {
          const updated = {
            ...session,
            lastAutoActionStateHash: state.stateHash,
            updatedAt: Date.now(),
          };
          setSession(updated);
          await saveGameHallSession(updated);
          await executeAction(plan.pending, true);
        } else {
          await savePendingGameHallAction(plan.pending);
          setPending(value => [...value, plan.pending!]);
        }
      }
    } catch (error: any) {
      await append('system', error?.message || String(error));
    } finally {
      setBusy(false);
    }
  };

  const closeGameHall = async () => {
    if (session && selected) {
      await buildGameHallSessionSummary({
        sessionId: session.id,
        charId: selected.id,
        gameId: session.gameId,
        gameName: session.gameName,
        force: true,
      });
      await flushGameHallMemoryCandidates({
        charId: selected.id,
        embedding: memoryPalaceConfig.embedding,
      });
      await saveGameHallSession({ ...session, status: 'active', updatedAt: Date.now() });
    }
    closeApp();
  };

  const testConnection = async () => {
    setTesting(true);
    setDiagnostic('正在执行 initialize 与 tools/list…');
    const result = await diagnoseCedarConnection(connection);
    setTesting(false);

    if (!result.ok) {
      setDiagnostic(`连接失败：${result.message}`);
      return;
    }

    const next = { ...connection, tools: result.tools || [], updatedAt: Date.now() };
    setConnection(next);
    saveCedarConnection(next);
    const map = result.capabilities || buildCedarCapabilityMap(result.tools || []);
    setCapabilities(map);
    setDiagnostic(
      `${result.message}。${
        !map.state.length
          ? '连接成功，但暂未识别出游戏状态工具。'
          : !map.action.length
            ? '已识别状态工具，但暂未识别行动工具。'
            : '已识别状态与行动能力。'
      }`,
    );
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,#312e81,#0f172a_48%,#020617)] text-white"
      style={{ paddingTop: 'var(--chrome-top)', paddingBottom: 'var(--safe-bottom)' }}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 px-3">
        <button onClick={() => void closeGameHall()} className="rounded-xl p-2">
          <ArrowLeft size={22} />
        </button>
        <GameController size={25} weight="fill" className="text-violet-300" />
        <div className="min-w-0 flex-1">
          <h1 className="font-bold">游戏厅</h1>
          <p className="truncate text-[10px] text-slate-400">
            Cedar Toy · {webState.loading ? '加载中' : webState.title || '已打开'}
          </p>
        </div>
        <button onClick={() => setSettingsOpen(true)} className="p-2">
          <GearSix size={22} />
        </button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 pb-2">
        <CedarToySurface suspended={settingsOpen || isLocked} onState={handleWebState} />

        <GameHallBottomSheet snap={sheetSnap} onSnapChange={setSheetSnap}>
          <div className="flex min-h-0 flex-1 flex-col px-3 pb-2">
            <div className="flex h-11 shrink-0 items-center gap-2">
              {selected?.avatar ? (
                <img
                  src={selected.avatar}
                  className="h-9 w-9 rounded-full object-cover"
                  alt=""
                />
              ) : (
                <span aria-hidden="true">🎮</span>
              )}

              <select
                value={charId}
                onChange={event => setCharId(event.target.value)}
                className="min-w-0 flex-1 rounded-xl bg-slate-800 p-2 text-sm"
                aria-label="共玩角色"
              >
                {characters.map(character => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>

              {pending.length > 0 && (
                <span className="whitespace-nowrap rounded-full bg-amber-500/20 px-2 py-1 text-[10px] text-amber-200">
                  {pending.length} 个待确认
                </span>
              )}

              {sheetOpen && (
                <button
                  disabled={busy || !capabilities?.state.length}
                  onClick={() => void refreshState()}
                  className="rounded-lg bg-slate-800 px-2 py-2 text-[11px] disabled:opacity-40"
                >
                  读状态
                </button>
              )}

              <button
                type="button"
                onClick={() => setSheetSnap(sheetOpen ? 'collapsed' : 'half')}
                className="rounded-lg bg-slate-800 p-2 text-slate-200"
                aria-label={sheetOpen ? '收起讨论' : '展开讨论'}
              >
                {sheetOpen ? <CaretDown size={18} /> : <CaretUp size={18} />}
              </button>
            </div>

            {sheetOpen && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="mt-2 grid shrink-0 grid-cols-3 gap-1 rounded-xl bg-black/20 p-1">
                  {MODES.map(item => (
                    <button
                      key={item.id}
                      onClick={() => void changeMode(item.id)}
                      className={`rounded-lg py-1.5 text-[11px] ${
                        mode === item.id ? 'bg-violet-500' : 'text-slate-400'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div
                  ref={listRef}
                  className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain text-xs"
                >
                  {messages.slice(-30).map(message => (
                    <div
                      key={message.id}
                      className={`whitespace-pre-wrap break-words rounded-xl px-3 py-2 ${
                        message.role === 'user'
                          ? 'ml-8 bg-violet-600'
                          : message.role === 'assistant'
                            ? 'mr-8 bg-slate-800'
                            : 'bg-black/25 text-slate-400'
                      }`}
                    >
                      {message.content}
                    </div>
                  ))}

                  {pending.map(action => (
                    <div
                      key={action.id}
                      className="rounded-xl border border-amber-400/30 bg-amber-950/40 p-3"
                    >
                      <b>建议行动：{action.toolName}</b>
                      <p className="my-1 text-slate-300">{action.reason}</p>
                      <div className="flex gap-2">
                        <button
                          disabled={busy}
                          onClick={() => void executeAction(action)}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 disabled:opacity-40"
                        >
                          确认执行
                        </button>
                        <button
                          onClick={() => void cancelAction(action)}
                          className="rounded-lg bg-slate-700 px-3 py-1.5"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-2 flex shrink-0 gap-2">
                  <input
                    value={input}
                    onChange={event => setInput(event.target.value)}
                    onFocus={() => {
                      if (sheetSnap === 'collapsed') setSheetSnap('half');
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') void send();
                    }}
                    placeholder="和角色讨论这一局…"
                    className="min-w-0 flex-1 rounded-xl bg-slate-800 px-3 py-2 text-sm"
                  />
                  <button
                    disabled={busy || !input.trim()}
                    onClick={() => void send()}
                    className="rounded-xl bg-violet-600 p-2 disabled:opacity-40"
                    aria-label="发送"
                  >
                    <PaperPlaneRight size={20} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </GameHallBottomSheet>
      </main>

      {settingsOpen && (
        <div
          className="absolute inset-0 z-50 flex items-end bg-black/60"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="max-h-[88%] w-full overflow-y-auto rounded-t-3xl bg-slate-950 p-5"
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center">
              <div className="flex-1">
                <h2 className="font-bold">Cedar Toy MCP</h2>
                <p className="text-xs text-slate-400">只依据真实 tools/list 与 schema</p>
              </div>
              <button onClick={() => setSettingsOpen(false)}>
                <X size={22} />
              </button>
            </div>

            <label className="mb-3 block text-xs">
              MCP URL
              <input
                value={connection.url}
                onChange={event =>
                  setConnection(value => ({ ...value, url: event.target.value }))
                }
                className="mt-1 w-full rounded-xl bg-slate-900 p-3"
                inputMode="url"
              />
            </label>

            <label className="mb-3 block text-xs">
              Bearer Token
              <SensitiveTextInput
                value={connection.token || ''}
                onChange={event =>
                  setConnection(value => ({ ...value, token: event.target.value }))
                }
                className="mt-1 w-full rounded-xl bg-slate-900 p-3"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={testing}
                onClick={() => void testConnection()}
                className="flex items-center justify-center gap-2 rounded-xl bg-violet-600 p-3 text-sm disabled:opacity-40"
              >
                <LinkSimple />
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button
                onClick={() => saveCedarConnection({ ...connection, updatedAt: Date.now() })}
                className="rounded-xl bg-slate-800 p-3 text-sm"
              >
                保存
              </button>
            </div>

            <div className="mt-4 rounded-2xl bg-slate-900 p-4 text-xs">
              <div className="mb-2 flex gap-2 font-semibold">
                <ShieldCheck />协议诊断
              </div>
              <p>{diagnostic}</p>
              {capabilities && (
                <ul className="mt-2 text-slate-400">
                  {describeCedarCapabilities(capabilities).map(item => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>
              )}
            </div>

            <button
              onClick={() => {
                clearCedarConnection();
                setConnection({ url: '', updatedAt: 0 });
                setCapabilities(null);
              }}
              className="mt-4 w-full rounded-xl border border-red-400/30 p-3 text-red-300"
            >
              清除连接
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GameHallApp;
