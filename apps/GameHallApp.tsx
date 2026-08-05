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
  ImageSquare,
  LinkSimple,
  PaperPlaneRight,
  ShieldCheck,
  SpinnerGap,
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
  executePendingGameHallAction,
  planGameHallTurn,
  respondToGameHallToolResult,
  stateFromGameHallToolResult,
} from '../utils/gameHallAgent';
import {
  formatGameHallToolResult,
  getGameHallToolResultPayload,
  persistCharacterAccountFromToolResultIfPresent,
} from '../utils/gameHallAccount';
import {
  deleteCharacterExternalAccount,
  listCharacterExternalAccounts,
  saveCharacterExternalAccount,
} from '../utils/characterExternalAccountStore';
import { createGameHallMainChatHandoff } from '../utils/gameHallHandoff';
import {
  createGameHallAutoplayUiCommand,
  enqueueGameHallAutoplayCommands,
  GAME_HALL_AUTOPLAY_STATE_EVENT,
} from '../utils/gameHallAutoplayIntent';
import {
  loadGameHallApiSettings,
  saveGameHallApiSettings,
  resolveGameHallApiConfig,
} from '../utils/gameHallApiPreset';
import { gameHallContextLabel, selectGameHallContext } from '../utils/gameHallContext';
import { prepareChatImageForSend } from '../utils/chatImage';
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

const GameHallApp: React.FC = () => {
  const {
    closeApp,
    openApp,
    setActiveCharacterId,
    characters,
    activeCharacterId,
    isLocked,
    apiConfig,
    apiPresets,
    userProfile,
    memoryPalaceConfig,
    groups,
    realtimeConfig,
  } = useOS();

  const [charId, setCharId] = useState(activeCharacterId || characters[0]?.id || '');
  const [mode, setMode] = useState<GameHallCompanionMode>('ask-before-action');
  const [sheetSnap, setSheetSnap] = useState<GameHallSheetSnap>('collapsed');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connection, setConnection] = useState<CedarToyConnection>(() => loadCedarConnection());
  const [gameHallApiSettings, setGameHallApiSettings] = useState(loadGameHallApiSettings);
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
  const [gameState, setGameState] = useState<NormalizedCedarGameState | undefined>(undefined);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [accountEditorRef, setAccountEditorRef] = useState<string | null>(null);
  const [accountEditorText, setAccountEditorText] = useState('');
  const [accountEditorError, setAccountEditorError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const executingActionIdsRef = useRef<Set<string>>(new Set());

  const selected = useMemo(
    () => characters.find(character => character.id === charId) || characters[0],
    [characters, charId],
  );
  const resolvedGameHallApi = useMemo(
    () => resolveGameHallApiConfig(apiConfig, apiPresets, gameHallApiSettings),
    [apiConfig, apiPresets, gameHallApiSettings],
  );
  const sheetOpen = sheetSnap !== 'collapsed';
  // 原始 tools/list：保留顺序、重复工具和完整 schema，不经过任何白名单或去重。
  const availableTools = connection.tools || [];
  const contextSelection = useMemo(
    () => selectGameHallContext(messages, session?.contextMessageLimit),
    [messages, session?.contextMessageLimit],
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
          contextMessageLimit: null,
          schemaValidationMode: 'off',
          planRepairAttempts: 0,
          autoArchiveAccounts: true,
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
    const reload = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; charId?: string }>).detail;
      if (!selected || (detail?.charId && detail.charId !== selected.id)) return;
      void (async () => {
        const current = await getActiveGameHallSession(selected.id);
        if (!current) return;
        const [nextMessages, nextPending] = await Promise.all([
          getGameHallMessages(current.id),
          getPendingGameHallActions(current.id),
        ]);
        setSession(current);
        setMessages(nextMessages);
        setPending(nextPending);
        if (current.autoplay?.latestState) setGameState(current.autoplay.latestState);
      })();
    };
    window.addEventListener(GAME_HALL_AUTOPLAY_STATE_EVENT, reload);
    return () => window.removeEventListener(GAME_HALL_AUTOPLAY_STATE_EVENT, reload);
  }, [selected?.id]);

  useEffect(() => {
    if (!sheetOpen) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pending, runStatus, sheetOpen]);

  const changeMode = async (next: GameHallCompanionMode) => {
    setMode(next);
    if (!session) return;
    const updated = { ...session, mode: next, updatedAt: Date.now() };
    setSession(updated);
    await saveGameHallSession(updated);
  };


  const changeContextLimit = async (raw: number) => {
    if (!session) return;
    const contextMessageLimit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
    const updated: GameHallSession = {
      ...session,
      contextMessageLimit,
      updatedAt: Date.now(),
    };
    setSession(updated);
    await saveGameHallSession(updated);
  };

  const updateSessionSettings = async (patch: Partial<GameHallSession>) => {
    if (!session) return;
    const updated: GameHallSession = { ...session, ...patch, updatedAt: Date.now() };
    setSession(updated);
    await saveGameHallSession(updated);
  };


  const executeAction = async (action: GameHallPendingAction, automatic = false) => {
    if (!selected || executingActionIdsRef.current.has(action.id)) return;
    executingActionIdsRef.current.add(action.id);
    setBusy(true);
    setRunStatus(`正在执行 ${action.toolName}…`);
    const running = { ...action, status: 'confirmed' as const, updatedAt: Date.now() };
    setPending(value => value.some(item => item.id === action.id)
      ? value.map(item => item.id === action.id ? running : item)
      : [...value, running]);
    await savePendingGameHallAction(running);

    try {
      const execution = await executePendingGameHallAction(
        connection,
        running,
        session?.schemaValidationMode || 'off',
      );
      const { result, request } = execution;
      if (!result.success) {
        const failed = {
          ...running,
          status: 'failed' as const,
          error: result.error || '行动失败',
          updatedAt: Date.now(),
        };
        await savePendingGameHallAction(failed);
        setPending(value => value.map(item => item.id === action.id ? failed : item));
        await append('tool', `执行 ${action.toolName} 失败。`, {
          toolName: action.toolName,
          toolRequest: request,
          toolResult: result,
          accountRef: action.accountRef,
        });
        await append('system', `行动失败：${failed.error}`);
        return;
      }

      const done = { ...running, status: 'executed' as const, updatedAt: Date.now() };
      await savePendingGameHallAction(done);
      setPending(value => value.filter(item => item.id !== action.id));

      let savedAccount: CharacterExternalAccount | undefined;
      setRunStatus('正在保存工具结果…');
      if (session?.autoArchiveAccounts !== false) {
        setRunStatus('正在检查工具结果中的账号资料…');
        savedAccount = await persistCharacterAccountFromToolResultIfPresent({
          charId: selected.id,
          connection,
          toolName: action.toolName,
          result,
        });
        if (savedAccount && session) {
          const updatedSession: GameHallSession = {
            ...session,
            activeAccountRef: savedAccount.accountRef,
            updatedAt: Date.now(),
          };
          setSession(updatedSession);
          await saveGameHallSession(updatedSession);
          await reloadAccounts();
        }
      }

      const executionLabel = automatic ? '自动回合' : '已确认';
      const toolMessage = await append(
        'tool',
        `${executionLabel}执行 ${action.toolName} 成功。${
          savedAccount ? `\n角色账号资料已完整保存：${savedAccount.accountRef}` : ''
        }`,
        {
          toolName: action.toolName,
          toolRequest: request,
          toolResult: result,
          accountRef: savedAccount?.accountRef || action.accountRef,
        },
      );

      setRunStatus('正在整理工具结果…');
      try {
        const history = session ? await getGameHallMessages(session.id) : [...messages, ...(toolMessage ? [toolMessage] : [])];
        const reply = await respondToGameHallToolResult({
          apiConfig: resolvedGameHallApi.config,
          char: selected,
          userProfile,
          groups,
          realtimeConfig,
          action,
          toolResult: result,
          accountRef: savedAccount?.accountRef || action.accountRef,
          history,
          contextMessageLimit: session?.contextMessageLimit,
        });
        if (reply) await append('assistant', reply);
      } catch (error: any) {
        await append('system', `工具已成功，但角色整理结果失败：${error?.message || String(error)}`);
      }

      const nextState = stateFromGameHallToolResult(result);
      setGameState(nextState);
      if (session && (nextState.gameId || nextState.gameName)) {
        const updatedSession: GameHallSession = {
          ...session,
          gameId: nextState.gameId || session.gameId,
          gameName: nextState.gameName || session.gameName,
          updatedAt: Date.now(),
        };
        setSession(updatedSession);
        await saveGameHallSession(updatedSession);
      }
    } catch (error: any) {
      const failed = {
        ...running,
        status: 'failed' as const,
        error: error?.message || String(error),
        updatedAt: Date.now(),
      };
      await savePendingGameHallAction(failed).catch(() => undefined);
      setPending(value => value.map(item => item.id === action.id ? failed : item));
      await append('system', `行动失败：${failed.error}`).catch(() => undefined);
    } finally {
      executingActionIdsRef.current.delete(action.id);
      setBusy(false);
      setRunStatus('');
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

  const runTurn = async (
    text: string,
    image?: GameHallMessage['image'],
  ) => {
    if ((!text.trim() && !image) || !session || !selected || busy || handoffBusy) return;
    setBusy(true);
    setRunStatus(image ? '正在保存图片…' : '正在保存消息…');
    try {
      const userMessage = await append('user', text.trim() || '[图片]', image ? { image } : {});
      const turnHistory = [...messages, ...(userMessage ? [userMessage] : [])];

      const state = gameState;
      setRunStatus(`${selected.name}正在思考…`);
      const plan = await planGameHallTurn({
        apiConfig: resolvedGameHallApi.config,
        char: selected,
        userProfile,
        groups,
        realtimeConfig,
        mode,
        userText: text.trim() || '[用户发送了一张图片]',
        state,
        availableTools,
        sessionId: session.id,
        history: turnHistory,
        accounts,
        preferredAccountRef: session.activeAccountRef,
        contextMessageLimit: session.contextMessageLimit,
        schemaValidationMode: session.schemaValidationMode || 'off',
        repairAttempts: session.planRepairAttempts || 0,
      });

      await append('assistant', plan.reply);
      if (plan.validationWarnings?.length) {
        await append('system', `本轮工具规划提示：${plan.validationWarnings.join('；')}`);
      }

      if (plan.pending) {
        if (mode === 'auto-turn') {
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
      setRunStatus('');
    }
  };

  const autoplayRunning = session?.autoplay?.status === 'queued'
    || session?.autoplay?.status === 'running'
    || session?.autoplay?.status === 'stopping';

  const sendAutoplayCommand = (type: 'start' | 'pause' | 'resume' | 'stop') => {
    if (!selected) return;
    enqueueGameHallAutoplayCommands([
      createGameHallAutoplayUiCommand(
        selected.id,
        type,
        type === 'start' ? {
          instruction: '自己选择想玩的内容，连续玩到自然告一段落。',
          returnToMainChat: false,
        } : undefined,
      ),
    ]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    if (autoplayRunning) {
      await append('user', text);
      return;
    }
    await runTurn(text);
  };

  const handleImageSelect = async (file: File) => {
    if (!file || busy || handoffBusy) return;
    const caption = input.trim();
    setInput('');
    setBusy(true);
    setRunStatus('正在处理图片…');
    try {
      const prepared = await prepareChatImageForSend(file);
      setBusy(false);
      const image = {
        displayDataUrl: prepared.displayDataUrl,
        visionDataUrl: prepared.visionDataUrl,
        fileName: file.name,
        mimeType: file.type,
        isAnimatedGif: prepared.isAnimatedGif,
      };
      if (autoplayRunning) await append('user', caption || '[图片]', { image });
      else await runTurn(caption || '[图片]', image);
    } catch (error: any) {
      await append('system', `图片处理失败：${error?.message || String(error)}`);
      setBusy(false);
      setRunStatus('');
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const handoffToMainChat = async () => {
    if (!session || !selected || handoffBusy || busy) return;
    setHandoffBusy(true);
    setRunStatus('正在准备游戏厅交接…');
    try {
      const result = await createGameHallMainChatHandoff({
        session,
        messages,
        accounts,
        char: selected,
        userProfile,
        apiConfig: resolvedGameHallApi.config,
        memoryPalaceConfig,
        onProgress: (_stage, text) => setRunStatus(text),
      });
      const deleted = new Set(result.deletedMessageIds);
      setMessages(value => value.filter(message => !deleted.has(message.id)));
      setSession(value => value ? {
        ...value,
        lastHandoffAt: Date.now(),
        lastHandoffMessageAt: result.lastHandoffMessageAt,
        updatedAt: Date.now(),
      } : value);
      setActiveCharacterId(selected.id);
      openApp('chat');
    } catch (error: any) {
      await append('system', `回主对话交接失败：${error?.message || String(error)}`);
    } finally {
      setHandoffBusy(false);
      setRunStatus('');
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
      `${result.message}。角色实际可见 ${result.tools?.length || 0} 个原始工具；下面分类只作辅助说明，不参与任何执行判断。`,
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
      await saveCharacterExternalAccount({ ...parsed, updatedAt: Date.now() });
      if (parsed.accountRef !== accountEditorRef) {
        await deleteCharacterExternalAccount(accountEditorRef);
        if (session?.activeAccountRef === accountEditorRef) {
          const updated = { ...session, activeAccountRef: parsed.accountRef, updatedAt: Date.now() };
          setSession(updated);
          await saveGameHallSession(updated);
        }
      }
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
          disabled={!selected || handoffBusy || busy}
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


              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="whitespace-nowrap rounded-full bg-sky-500/15 px-2 py-1 text-[10px] text-sky-200"
                title="查看并设置角色本轮能看到的游戏厅原文"
              >
                {contextSelection.limit == null
                  ? `上下文 全部 ${contextSelection.includedCount}/${contextSelection.totalCount}`
                  : `上下文 ${contextSelection.includedCount}/${contextSelection.totalCount}`}
              </button>

              {pending.length > 0 && (
                <span className="whitespace-nowrap rounded-full bg-amber-500/20 px-2 py-1 text-[10px] text-amber-200">
                  {pending.length} 个待确认
                </span>
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

                <div className="mt-2 flex shrink-0 flex-wrap gap-2 rounded-xl bg-black/20 p-2 text-[11px]">
                  {(!session?.autoplay || ['completed', 'cancelled', 'failed'].includes(session.autoplay.status)) ? (
                    <button onClick={() => sendAutoplayCommand('start')} className="rounded-lg bg-emerald-600 px-3 py-1.5">开始自主连玩</button>
                  ) : session.autoplay.status === 'paused' ? (
                    <button onClick={() => sendAutoplayCommand('resume')} className="rounded-lg bg-emerald-600 px-3 py-1.5">继续</button>
                  ) : (
                    <button onClick={() => sendAutoplayCommand('pause')} className="rounded-lg bg-amber-600 px-3 py-1.5">暂停</button>
                  )}
                  {session?.autoplay && !['completed', 'cancelled', 'failed'].includes(session.autoplay.status) && (
                    <button onClick={() => sendAutoplayCommand('stop')} className="rounded-lg bg-rose-700 px-3 py-1.5">停止</button>
                  )}
                  {session?.autoplay && (
                    <span className="self-center text-slate-300">{session.autoplay.status} · 已完成 {session.autoplay.turnCount} 步</span>
                  )}
                </div>

                <div
                  ref={listRef}
                  className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain text-xs"
                >
                  {messages.map(message => (
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
                      {message.image && (
                        <img
                          src={message.image.displayDataUrl}
                          alt={message.image.fileName || '游戏厅图片'}
                          className="mt-2 max-h-72 w-full rounded-xl object-contain"
                        />
                      )}
                      {message.toolRequest && (
                        <details className="mt-2 rounded-lg bg-black/30 p-2">
                          <summary className="cursor-pointer font-semibold text-sky-200">完整工具请求</summary>
                          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-slate-200">
                            {JSON.stringify(message.toolRequest, null, 2)}
                          </pre>
                        </details>
                      )}
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

                  {runStatus && (
                    <div className="flex items-end gap-2 pr-8 animate-fade-in" role="status" aria-live="polite">
                      {selected?.avatar ? (
                        <img src={selected.avatar} className="h-8 w-8 rounded-full object-cover" alt="" />
                      ) : <span>🎮</span>}
                      <div className="flex items-center gap-2 rounded-xl bg-slate-800 px-3 py-2 text-[11px] text-slate-200">
                        <SpinnerGap size={15} className="animate-spin text-violet-300" />
                        <span>{runStatus}</span>
                      </div>
                    </div>
                  )}

                  {pending.map(action => (
                    <div key={action.id} className="rounded-xl border border-amber-400/30 bg-amber-950/40 p-3">
                      <b>建议行动：{action.toolName}</b>
                      <p className="my-1 text-slate-300">{action.reason}</p>
                      {action.status === 'failed' && <p className="mb-2 text-rose-300">上次失败：{action.error}</p>}
                      {!!action.validationWarnings?.length && (
                        <details className="mb-2 rounded-lg bg-amber-950/40 p-2 text-[10px] text-amber-200">
                          <summary>schema 提示（当前设置未必阻止执行）</summary>
                          <pre className="mt-1 whitespace-pre-wrap">{action.validationWarnings.join('\n')}</pre>
                        </details>
                      )}
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
                          {action.status === 'failed' ? '原样重试' : '确认执行'}
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
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={event => {
                      const file = event.target.files?.[0];
                      if (file) void handleImageSelect(file);
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy || handoffBusy}
                    onClick={() => imageInputRef.current?.click()}
                    className="rounded-xl bg-slate-800 p-2 text-sky-200 disabled:opacity-40"
                    aria-label="发送图片"
                  >
                    <ImageSquare size={20} />
                  </button>
                  <input
                    value={input}
                    onChange={event => setInput(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') void send();
                    }}
                    placeholder="和角色讨论这一局…"
                    className="min-w-0 flex-1 rounded-xl bg-slate-800 px-3 py-2 text-sm"
                  />
                  <button
                    disabled={busy || handoffBusy || !input.trim()}
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
                <ShieldCheck />协议诊断（分类仅供参考）
              </div>
              <p>{diagnostic}</p>
              {capabilities && (
                <ul className="mt-2 text-slate-400">
                  {describeCedarCapabilities(capabilities).map(item => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>
              )}

              {!!connection.tools?.length && (
                <div className="mt-3 rounded-xl bg-black/25 p-2">
                  <div className="font-bold text-violet-200">角色实际可见的全部工具（{connection.tools.length}）</div>
                  {connection.tools.map((tool, index) => (
                    <details key={`${index}:${tool.name}`} className="mt-2">
                      <summary className="cursor-pointer font-mono text-emerald-200">#{index} · {tool.name}</summary>
                      <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all text-[9px] text-slate-300">{JSON.stringify(tool, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              )}
            </div>

            <section className="mt-4 rounded-2xl border border-sky-400/20 bg-slate-900 p-4">
              <h3 className="text-sm font-bold">游戏厅上下文</h3>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                只决定角色本轮读取多少条原文。未进入上下文的消息仍完整保存，不会因为范围设置而删除。
                填 0 表示全部，不设置隐藏上限。
              </p>
              <label className="mt-3 block text-xs">
                最近多少条进入上下文（0 = 全部）
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={session?.contextMessageLimit ?? 0}
                  onChange={event => void changeContextLimit(Number(event.target.value))}
                  className="mt-1 w-full rounded-xl bg-slate-950 p-3 font-mono"
                />
              </label>
              <div className="mt-2 rounded-xl bg-black/25 px-3 py-2 text-[11px] text-sky-200">
                {gameHallContextLabel(contextSelection)}
                {contextSelection.excludedCount > 0 && (
                  <div className="mt-1 text-slate-400">
                    另有 {contextSelection.excludedCount} 条不进入本轮模型上下文，但仍保存在游戏厅。
                  </div>
                )}
              </div>
              <details className="mt-3 rounded-xl bg-black/25 p-3">
                <summary className="cursor-pointer text-xs font-bold text-sky-200">查看本轮准确上下文</summary>
                <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
                  {messages.map(message => {
                    const included = contextSelection.messages.some(item => item.id === message.id);
                    return (
                      <div key={message.id} className={`rounded-lg px-2 py-1.5 text-[10px] ${included ? 'bg-sky-950/45 text-sky-100' : 'bg-slate-950 text-slate-500'}`}>
                        <b>{included ? '进入上下文' : '保留但不进入'} · {message.role}</b>
                        <div className="mt-1 whitespace-pre-wrap break-words">{message.content || (message.image ? '[图片]' : '')}</div>
                        {message.image && <div className="mt-1 text-sky-300">🖼 {message.image.fileName || '图片'}</div>}
                        {message.toolName && <div className="mt-1 font-mono">tool: {message.toolName}</div>}
                      </div>
                    );
                  })}
                  {!messages.length && <p className="text-[10px] text-slate-500">还没有游戏厅消息。</p>}
                </div>
              </details>
            </section>

            <section className="mt-4 rounded-2xl border border-emerald-400/20 bg-slate-900 p-4">
              <h3 className="text-sm font-bold">自主连玩与 API</h3>
              <label className="mt-3 block text-xs">游戏厅 API 预设
                <select value={gameHallApiSettings.activePresetId || ''} onChange={event => {
                  const next = { ...gameHallApiSettings, activePresetId: event.target.value || null };
                  setGameHallApiSettings(next); saveGameHallApiSettings(next);
                }} className="mt-1 w-full rounded-xl bg-slate-950 p-3">
                  <option value="">跟随当前聊天 API</option>
                  {apiPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
              </label>
              <label className="mt-3 block text-xs">步骤间隔（毫秒，0 = 不额外等待）
                <input type="number" min={0} value={gameHallApiSettings.stepDelayMs} onChange={event => {
                  const next = { ...gameHallApiSettings, stepDelayMs: Math.max(0, Number(event.target.value) || 0) };
                  setGameHallApiSettings(next); saveGameHallApiSettings(next);
                }} className="mt-1 w-full rounded-xl bg-slate-950 p-3 font-mono" />
              </label>
              <label className="mt-3 block text-xs">回合上限（留空 = 不限）
                <input type="number" min={0} placeholder="不限" value={gameHallApiSettings.maxTurns ?? ''} onChange={event => {
                  const raw = event.target.value;
                  const next = { ...gameHallApiSettings, maxTurns: raw === '' || Number(raw) <= 0 ? null : Math.floor(Number(raw)) };
                  setGameHallApiSettings(next); saveGameHallApiSettings(next);
                }} className="mt-1 w-full rounded-xl bg-slate-950 p-3 font-mono" />
              </label>
              <p className="mt-2 text-[10px] text-slate-400">只要前端进程仍运行就会连续执行；WebView 被系统冻结或杀掉时会暂停，恢复后从已持久化进度继续。</p>
            </section>

            <section className="mt-4 rounded-2xl border border-amber-400/20 bg-slate-900 p-4">
              <h3 className="text-sm font-bold">执行规则（全部可见、手动设置）</h3>
              <label className="mt-3 block text-xs">
                schema 校验
                <select
                  value={session?.schemaValidationMode || 'off'}
                  onChange={event => void updateSessionSettings({ schemaValidationMode: event.target.value as any })}
                  className="mt-1 w-full rounded-xl bg-slate-950 p-3"
                >
                  <option value="off">关闭：不因 schema 阻止调用</option>
                  <option value="warn">提示：显示问题但仍允许调用</option>
                  <option value="strict">严格：不符合 schema 时阻止调用</option>
                </select>
              </label>
              <label className="mt-3 block text-xs">
                规划失败自动修正次数（0 = 不额外调用）
                <input
                  type="number" min={0} max={5} step={1}
                  value={session?.planRepairAttempts || 0}
                  onChange={event => void updateSessionSettings({ planRepairAttempts: Math.max(0, Math.min(5, Number(event.target.value) || 0)) })}
                  className="mt-1 w-full rounded-xl bg-slate-950 p-3 font-mono"
                />
              </label>
              <label className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-black/25 p-3 text-xs">
                <span>工具成功结果含账号/凭证时自动建档</span>
                <input
                  type="checkbox"
                  checked={session?.autoArchiveAccounts !== false}
                  onChange={event => void updateSessionSettings({ autoArchiveAccounts: event.target.checked })}
                />
              </label>
              <label className="mt-3 block text-xs">
                当前角色身份（所有工具调用都使用这个身份端点；可改回基础连接）
                <select
                  value={session?.activeAccountRef || ''}
                  onChange={event => void updateSessionSettings({ activeAccountRef: event.target.value || undefined })}
                  className="mt-1 w-full rounded-xl bg-slate-950 p-3 font-mono text-[10px]"
                >
                  <option value="">基础 MCP 连接</option>
                  {accounts.map(account => (
                    <option key={account.accountRef} value={account.accountRef}>
                      {account.username || account.accountId || account.accountRef}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                自动回合会直接执行角色本轮选中的一次真实工具调用，不再依赖隐藏的 state/turn 正则、allowsAiAction 或状态哈希闸门。
              </p>
            </section>

            <section className="mt-4 rounded-2xl border border-violet-400/20 bg-slate-900 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold">{selected?.name || '角色'}的外部账号档案</h3>
                  <p className="mt-1 text-[10px] text-slate-400">
                    注册成功即自动保存。账号资料完整可见、可编辑；accountRef 只是便捷引用，客户端只补缺失参数，不删除或覆盖已有参数。
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
                            if (session?.activeAccountRef === account.accountRef) {
                              await updateSessionSettings({ activeAccountRef: undefined });
                            }
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
