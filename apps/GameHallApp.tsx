import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CaretDown,
  CaretUp,
  ChatCircleDots,
  Copy,
  FloppyDisk,
  GameController,
  GearSix,
  LinkSimple,
  PaperPlaneRight,
  ShieldCheck,
  Trash,
  X,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
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
} from '../utils/gameHallAgent';
import {
  formatGameHallToolResult,
  getGameHallToolResultPayload,
  isAccountTool,
  persistCharacterAccountFromToolResult,
} from '../utils/gameHallAccount';
import {
  deleteCharacterExternalAccount,
  listCharacterExternalAccounts,
  saveCharacterExternalAccount,
} from '../utils/characterExternalAccountStore';
import { createGameHallMainChatHandoff } from '../utils/gameHallHandoff';
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
  CharacterExternalAccount,
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

const uniqueTools = <T extends { name: string }>(tools: T[]): T[] => {
  const seen = new Set<string>();
  return tools.filter(tool => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
};

const GameHallApp: React.FC = () => {
  const {
    closeApp,
    openApp,
    setActiveCharacterId,
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
  const [accounts, setAccounts] = useState<CharacterExternalAccount[]>([]);
  const [gameState, setGameState] = useState<NormalizedCedarGameState>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [accountEditorRef, setAccountEditorRef] = useState<string | null>(null);
  const [accountEditorText, setAccountEditorText] = useState('');
  const [accountEditorError, setAccountEditorError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => characters.find(character => character.id === charId) || characters[0],
    [characters, charId],
  );
  const sheetOpen = sheetSnap !== 'collapsed';
  const agentTools = useMemo(
    () => uniqueTools([...(capabilities?.account || []), ...(capabilities?.action || [])]),
    [capabilities],
  );

  const handleWebState = useCallback((state: GameHallWebState) => setWebState(state), []);

  const reloadAccounts = useCallback(async () => {
    if (!selected) {
      setAccounts([]);
      return [];
    }
    const next = await listCharacterExternalAccounts(selected.id);
    setAccounts(next);
    return next;
  }, [selected?.id]);

  const append = async (
    role: GameHallMessage['role'],
    content: string,
    extra: Partial<Omit<GameHallMessage, 'id' | 'sessionId' | 'charId' | 'role' | 'content' | 'createdAt'>> = {},
  ) => {
    if (!session || !selected) return undefined;
    const message: GameHallMessage = {
      id: gameHallId('ghmsg'),
      sessionId: session.id,
      charId: selected.id,
      role,
      content,
      createdAt: Date.now(),
      ...extra,
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
      const [nextMessages, nextPending, nextAccounts] = await Promise.all([
        getGameHallMessages(current.id),
        getPendingGameHallActions(current.id),
        listCharacterExternalAccounts(selected.id),
      ]);
      if (!alive) return;
      setSession(current);
      setMode(current.mode);
      setMessages(nextMessages);
      setPending(nextPending);
      setAccounts(nextAccounts);
      setAccountEditorRef(null);
      setAccountEditorText('');
      setAccountEditorError('');
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
      await append('tool', `已通过 ${read.toolName} 读取同一存档状态。`, {
        toolName: read.toolName,
      });
      return read.state;
    } catch (error: any) {
      await append('system', error?.message || String(error));
      throw error;
    } finally {
      if (manageBusy) setBusy(false);
    }
  };

  const executeAction = async (action: GameHallPendingAction, automatic = false) => {
    if (!selected) return;
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

    let savedAccount: CharacterExternalAccount | undefined;
    try {
      // 账号档案必须是工具成功后的第一项副作用。后续角色回复/状态刷新失败都不影响它。
      if (isAccountTool(action.toolName, capabilities?.account || [])) {
        savedAccount = await persistCharacterAccountFromToolResult({
          charId: selected.id,
          connection,
          toolName: action.toolName,
          result,
        });
        const bindingKey = `${savedAccount.provider}:${savedAccount.serverId}`;
        if (session) {
          const updatedSession: GameHallSession = {
            ...session,
            accountBinding: {
              ...(session.accountBinding || {}),
              [bindingKey]: savedAccount.accountRef,
            },
            updatedAt: Date.now(),
          };
          setSession(updatedSession);
          await saveGameHallSession(updatedSession);
        }
        await reloadAccounts();
      }

      const executionLabel = automatic ? '自动回合' : '已确认';
      const toolMessage = await append(
        'tool',
        `${executionLabel}执行 ${action.toolName} 成功。${
          savedAccount ? `\n角色账号资料已完整保存：${savedAccount.accountRef}` : ''
        }`,
        {
          toolName: action.toolName,
          toolResult: result,
          accountRef: savedAccount?.accountRef,
        },
      );

      try {
        const reply = await respondToGameHallToolResult({
          apiConfig,
          char: selected,
          userProfile,
          action,
          toolResult: result,
          accountRef: savedAccount?.accountRef,
          history: [...messages, ...(toolMessage ? [toolMessage] : [])],
        });
        if (reply) await append('assistant', reply);
      } catch {
        // 工具完整结果与账号档案已经落库；角色化复述失败不能推翻工具成功。
      }

      const hasCallableStateTool = (capabilities?.state || []).some(tool =>
        canCallWithoutGuessing(tool, {}),
      );
      if (hasCallableStateTool) {
        try {
          await refreshState(false);
        } catch {
          // 状态刷新只是后处理，失败不能推翻已成功工具或已保存账号。
        }
      }
    } catch (error: any) {
      // result 仍完整存在，尽最大努力把它落成工具消息，不能改判工具失败。
      await append('tool', `工具 ${action.toolName} 已执行成功。`, {
        toolName: action.toolName,
        toolResult: result,
        accountRef: savedAccount?.accountRef,
      }).catch(() => undefined);
      await append(
        'system',
        `工具已经执行成功，但本地后处理失败：${error?.message || String(error)}`,
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

      let state = gameState;
      try {
        state = await readCedarGameState(connection).then(result => result.state);
        setGameState(state);
      } catch {
        // 状态工具不可用时仍允许正常聊天和账号操作。
      }

      const plan = await planGameHallTurn({
        apiConfig,
        char: selected,
        userProfile,
        mode,
        userText: text,
        state,
        actionTools: agentTools,
        sessionId: session.id,
        history: [...messages, ...(userMessage ? [userMessage] : [])],
        accounts,
      });

      await append('assistant', plan.reply);

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

  const handoffToMainChat = async () => {
    if (!session || !selected || handoffBusy) return;
    setHandoffBusy(true);
    try {
      await createGameHallMainChatHandoff({
        session,
        messages,
        accounts,
        char: selected,
        userProfile,
        apiConfig,
        memoryPalaceConfig,
      });
      const latestMessageAt = messages.reduce(
        (max, message) => Math.max(max, message.createdAt),
        session.lastHandoffMessageAt || 0,
      );
      setSession({
        ...session,
        lastHandoffAt: Date.now(),
        lastHandoffMessageAt: latestMessageAt,
        updatedAt: Date.now(),
      });
      // 真正切进该角色的主聊天。交接卡已经先写入 messages 主表，Chat 挂载后直接可见。
      setActiveCharacterId(selected.id);
      openApp('chat');
    } catch (error: any) {
      await append('system', `回主对话交接失败：${error?.message || String(error)}`);
    } finally {
      setHandoffBusy(false);
    }
  };

  const closeGameHall = async () => {
    if (session) {
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
          : !map.action.length && !map.account.length
            ? '已识别状态工具，但暂未识别行动/账号工具。'
            : '已识别状态、行动或账号能力。'
      }`,
    );
  };

  const openAccountEditor = (account: CharacterExternalAccount) => {
    setAccountEditorRef(account.accountRef);
    setAccountEditorText(JSON.stringify(account, null, 2));
    setAccountEditorError('');
  };

  const saveAccountEditor = async () => {
    if (!selected || !accountEditorRef) return;
    try {
      const parsed = JSON.parse(accountEditorText) as CharacterExternalAccount;
      if (parsed.accountRef !== accountEditorRef) {
        throw new Error('accountRef 不可在编辑器中改名；需要新账号请重新注册。');
      }
      if (parsed.charId !== selected.id) {
        throw new Error('charId 必须保持为当前角色。');
      }
      await saveCharacterExternalAccount({ ...parsed, updatedAt: Date.now() });
      await reloadAccounts();
      setAccountEditorError('已保存。');
    } catch (error: any) {
      setAccountEditorError(error?.message || String(error));
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
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
        <button
          disabled={!selected || handoffBusy}
          onClick={() => void handoffToMainChat()}
          className="flex items-center gap-1 rounded-xl bg-violet-500/20 px-2 py-1.5 text-[11px] text-violet-100 disabled:opacity-40"
          title="把刚才的游戏厅对话写进主聊天并继续"
        >
          <ChatCircleDots size={18} />
          {handoffBusy ? '交接中' : '回主对话'}
        </button>
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
                <img src={selected.avatar} className="h-9 w-9 rounded-full object-cover" alt="" />
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

              {accounts.length > 0 && (
                <span className="whitespace-nowrap rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-200">
                  已存 {accounts.length} 个账号
                </span>
              )}

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
                            : 'bg-black/25 text-slate-300'
                      }`}
                    >
                      <div>{message.content}</div>
                      {message.accountRef && (
                        <div className="mt-2 rounded-lg bg-emerald-950/50 px-2 py-1 font-mono text-[10px] text-emerald-200">
                          accountRef: {message.accountRef}
                        </div>
                      )}
                      {message.toolResult && (
                        <details className="mt-2 rounded-lg bg-black/30 p-2" open>
                          <summary className="cursor-pointer font-semibold text-violet-200">
                            完整工具返回（未打码、未截断）
                          </summary>
                          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-slate-200">
                            {formatGameHallToolResult(getGameHallToolResultPayload(message.toolResult))}
                          </pre>
                        </details>
                      )}
                      {!message.toolResult && message.toolResultSummary && (
                        <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">
                          {message.toolResultSummary}
                        </pre>
                      )}
                    </div>
                  ))}

                  {pending.map(action => (
                    <div key={action.id} className="rounded-xl border border-amber-400/30 bg-amber-950/40 p-3">
                      <b>建议行动：{action.toolName}</b>
                      <p className="my-1 text-slate-300">{action.reason}</p>
                      {action.accountRef && (
                        <p className="mb-2 break-all font-mono text-[10px] text-emerald-200">
                          使用账号档案：{action.accountRef}
                        </p>
                      )}
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
        <div className="absolute inset-0 z-50 flex items-end bg-black/60" onClick={() => setSettingsOpen(false)}>
          <div
            className="max-h-[92%] w-full overflow-y-auto rounded-t-3xl bg-slate-950 p-5"
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center">
              <div className="flex-1">
                <h2 className="font-bold">Cedar Toy MCP</h2>
                <p className="text-xs text-slate-400">所有配置与工具返回均完整显示，不自动打码</p>
              </div>
              <button onClick={() => setSettingsOpen(false)}>
                <X size={22} />
              </button>
            </div>

            <label className="mb-3 block text-xs">
              MCP URL
              <input
                value={connection.url}
                onChange={event => setConnection(value => ({ ...value, url: event.target.value }))}
                className="mt-1 w-full rounded-xl bg-slate-900 p-3"
                inputMode="url"
              />
            </label>

            <label className="mb-3 block text-xs">
              Bearer Token（完整可见）
              <input
                value={connection.token || ''}
                onChange={event => setConnection(value => ({ ...value, token: event.target.value }))}
                className="mt-1 w-full rounded-xl bg-slate-900 p-3 font-mono"
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
                保存连接
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

            <section className="mt-4 rounded-2xl border border-violet-400/20 bg-slate-900 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold">{selected?.name || '角色'}的外部账号档案</h3>
                  <p className="mt-1 text-[10px] text-slate-400">
                    注册成功即自动保存。模型只引用 accountRef，登录凭证由客户端逐字注入。
                  </p>
                </div>
                <button onClick={() => void reloadAccounts()} className="rounded-lg bg-slate-800 px-2 py-1 text-[10px]">
                  刷新
                </button>
              </div>

              {!accounts.length && <p className="text-xs text-slate-500">当前角色还没有保存账号。</p>}
              <div className="space-y-3">
                {accounts.map(account => {
                  const full = JSON.stringify(account, null, 2);
                  return (
                    <div key={account.accountRef} className="rounded-xl bg-black/25 p-3">
                      <div className="break-all font-mono text-[10px] text-emerald-200">{account.accountRef}</div>
                      <div className="mt-1 text-[11px] text-slate-300">
                        {account.username || account.accountId || '未识别显示名'} · {account.status}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button onClick={() => void copyText(full)} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2 py-1 text-[10px]">
                          <Copy size={13} />复制完整资料
                        </button>
                        <button onClick={() => openAccountEditor(account)} className="rounded-lg bg-violet-600/40 px-2 py-1 text-[10px]">
                          查看 / 编辑
                        </button>
                        <button
                          onClick={async () => {
                            await deleteCharacterExternalAccount(account.accountRef);
                            if (accountEditorRef === account.accountRef) {
                              setAccountEditorRef(null);
                              setAccountEditorText('');
                            }
                            await reloadAccounts();
                          }}
                          className="flex items-center gap-1 rounded-lg bg-red-950/60 px-2 py-1 text-[10px] text-red-200"
                        >
                          <Trash size={13} />删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {accountEditorRef && (
                <div className="mt-4 rounded-xl border border-violet-400/20 bg-black/30 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold">完整账号 JSON</span>
                    <button onClick={() => setAccountEditorRef(null)}><X size={16} /></button>
                  </div>
                  <textarea
                    value={accountEditorText}
                    onChange={event => setAccountEditorText(event.target.value)}
                    className="h-64 w-full resize-y rounded-lg bg-slate-950 p-3 font-mono text-[10px] leading-relaxed text-slate-100"
                    spellCheck={false}
                  />
                  {accountEditorError && <p className="mt-2 text-[10px] text-amber-200">{accountEditorError}</p>}
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => void copyText(accountEditorText)} className="flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-2 text-[11px]">
                      <Copy size={14} />复制
                    </button>
                    <button onClick={() => void saveAccountEditor()} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-[11px]">
                      <FloppyDisk size={14} />保存修改
                    </button>
                  </div>
                </div>
              )}
            </section>

            <button
              onClick={() => {
                clearCedarConnection();
                setConnection({ url: '', updatedAt: 0 });
                setCapabilities(null);
              }}
              className="mt-4 w-full rounded-xl border border-red-400/30 p-3 text-red-300"
            >
              清除连接（不删除角色账号档案）
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GameHallApp;
