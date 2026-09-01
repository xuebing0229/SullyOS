import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Plus, Play, Trash, FloppyDisk, Sparkle, PaperPlaneTilt, Smiley } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import type {
  AppMemoryCandidate,
  Message,
  SimulatorMode,
  SimulatorProject,
  SimulatorSession,
  SimulatorTurn,
} from '../types';
import {
  callAppModel,
  parseFirstJsonObject,
  sliceLocalMessages,
} from '../utils/appContext';
import {
  generateAppMemoryCandidates,
} from '../utils/appMemoryBridge';
import AppMemoryCandidatePanel from '../components/AppMemoryCandidatePanel';
import ConfirmDialog from '../components/os/ConfirmDialog';
import ChatHeader from '../components/chat/ChatHeaderShell';
import MessageItem from '../components/chat/MessageItem';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { resolveChatTheme } from '../utils/groupChat/theme';
import { buildChatFineTuneCss, mergeChatFineTune } from '../utils/chatFineTuneCss';
import { useBlobRefUrl } from '../utils/blobRef';
import {
  isSimulatorIframeAction,
  postSimulatorState,
  SIMULATOR_BRIDGE_HELP,
} from '../utils/simulator/iframeBridge';

type View = 'list' | 'editor' | 'run';

const uid = (p: string) =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const modeLabel: Record<SimulatorMode, string> = {
  html: '直接运行 HTML',
  text: '纯文字 AI 文游',
  hybrid: '文字 + HTML 面板',
  frontend_ai: 'HTML 选项 + AI 推进',
};

const fieldClass =
  'w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-800 outline-none transition-all placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50';
const sectionClass =
  'rounded-[1.5rem] border border-slate-200/70 bg-white p-5 shadow-sm shadow-slate-200/40';

const defaultHtml = `<div style="font-family:sans-serif;padding:24px">
  <h2>我的万象匣</h2>
  <p id="status">等待开始</p>
  <button onclick="parent.postMessage({type:'SULLY_SIM_ACTION',action:'start',payload:{}},'*')">
    开始
  </button>
  <script>
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'SULLY_SIM_STATE') {
        document.getElementById('status').textContent =
          JSON.stringify(event.data.state, null, 2);
      }
    });
  </script>
</div>`;

const SimulatorApp: React.FC = () => {
  const {
    closeApp,
    characters,
    userProfile,
    groups,
    apiConfig,
    realtimeConfig,
    memoryPalaceConfig,
    remoteVectorConfig,
    updateCharacter,
    addToast,
    registerBackHandler,
    customThemes,
    theme: osTheme,
  } = useOS();

  const [view, setView] = useState<View>('list');
  const [projects, setProjects] = useState<SimulatorProject[]>([]);
  const [project, setProject] = useState<SimulatorProject | null>(null);
  const [session, setSession] = useState<SimulatorSession | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<AppMemoryCandidate[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [runPanel, setRunPanel] = useState<'none' | 'actions'>('none');
  const [deleteTarget, setDeleteTarget] = useState<SimulatorProject | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const char = useMemo(
    () => characters.find((v) => v.id === project?.charId) || null,
    [characters, project?.charId],
  );

  // 万象匣的聊天区直接吃主聊天的外观状态：角色气泡主题、聊天背景、
  // 白框/输入栏配置与细节微调都共用同一份数据，不再维护第二套“像聊天”的皮肤。
  const resolvedChatBackground = useBlobRefUrl(char?.chatBackground);
  const activeChatTheme = useMemo(
    () => resolveChatTheme(char?.bubbleStyle || 'default', customThemes, PRESET_THEMES),
    [char?.bubbleStyle, customThemes],
  );
  const mergedChatFineTune = useMemo(
    () => mergeChatFineTune(osTheme, char?.chatFineTune),
    [osTheme, char?.chatFineTune],
  );
  const simulatorChatFineTuneCss = useMemo(
    () => buildChatFineTuneCss(mergedChatFineTune),
    [mergedChatFineTune],
  );
  const runScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (view !== 'run') return;
    const el = runScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  }, [view, session?.turns.length, busy]);

  const reload = useCallback(async () => {
    setProjects(await DB.getSimulatorProjects());
  }, []);

  useEffect(() => {
    void reload();
    return () => abortRef.current?.abort();
  }, [reload]);

  useEffect(() => {
    return registerBackHandler(() => {
      if (showMemory) {
        setShowMemory(false);
        return true;
      }
      if (view === 'run') {
        setView('list');
        setSession(null);
        setProject(null);
        return true;
      }
      if (view === 'editor') {
        setView('list');
        setProject(null);
        return true;
      }
      return false;
    });
  }, [registerBackHandler, showMemory, view]);

  const openNew = () => {
    const firstChar = characters[0];
    if (!firstChar) {
      addToast('请先创建角色');
      return;
    }
    setProject({
      id: uid('simproj'),
      name: '',
      description: '',
      mode: 'text',
      charId: firstChar.id,
      html: defaultHtml,
      prompt: '和用户共同推进一个连贯、有选择后果的互动故事。',
      breaker: '',
      worldbookEnabled: true,
      regexEnabled: true,
      mainContextEnabled: true,
      localContextLimit: 30,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setView('editor');
  };

  const saveProject = async () => {
    if (!project) return;
    if (!project.name.trim()) {
      addToast('请填写万象匣名称');
      return;
    }
    if (!project.charId) {
      addToast('请选择角色');
      return;
    }
    const next = { ...project, name: project.name.trim(), updatedAt: Date.now() };
    await DB.saveSimulatorProject(next);
    setProject(next);
    await reload();
    setView('list');
    addToast('已保存', 'success');
  };

  const deleteProject = async (id: string) => {
    await DB.deleteSimulatorProject(id);
    setDeleteTarget(null);
    await reload();
    addToast('万象匣已删除', 'success');
  };

  const start = async (p: SimulatorProject) => {
    const existing = (await DB.getSimulatorSessionsByProject(p.id))
      .filter((v: SimulatorSession) => v.status === 'active')
      .sort((a: SimulatorSession, b: SimulatorSession) => b.updatedAt - a.updatedAt)[0];
    const next: SimulatorSession =
      existing ||
      {
        id: uid('simsession'),
        projectId: p.id,
        charId: p.charId,
        status: 'active',
        turns: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    if (!existing) await DB.saveSimulatorSession(next);
    setProject(p);
    setSession(next);
    setCandidates(
      await DB.getAppMemoryCandidatesBySource(next.charId, 'simulator', next.id),
    );
    setView('run');
  };

  const persistTurn = async (turn: SimulatorTurn, frontendState?: unknown) => {
    if (!session) return null;
    const next: SimulatorSession = {
      ...session,
      turns: [...session.turns, turn],
      frontendState:
        frontendState === undefined ? session.frontendState : frontendState,
      updatedAt: Date.now(),
    };
    setSession(next);
    await DB.saveSimulatorSession(next);
    return next;
  };

  const appPrompt = `
你正在“万象匣”中和用户共同游玩。
玩法名称：${project?.name || '未命名'}
模式：${project ? modeLabel[project.mode] : ''}
玩法规则：
${project?.prompt || ''}
${project?.breaker ? `\n附加规则：\n${project.breaker}` : ''}

要求：
1. 继续保持主聊天里同一个角色的记忆、关系和语气。
2. 只根据已经发生的局内记录推进，不篡改过去。
3. 不声称你看见了 iframe 里没有通过动作或状态传来的内容。
4. 回复自然，不解释系统。
`;

  const buildLocal = (extra: SimulatorTurn) => {
    const turns = sliceLocalMessages(
      [...(session?.turns || []), extra],
      project?.localContextLimit || 30,
    );
    return turns.map((v) => ({
      role: v.role,
      content: v.action
        ? `[前端动作：${v.action}]\n${JSON.stringify(v.payload ?? null)}`
        : v.content,
    }));
  };

  const askAI = async (turn: SimulatorTurn) => {
    if (!project || !session || !char || busy) return;
    setBusy(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const sessionWithUser = await persistTurn(turn);
      if (!sessionWithUser) return;
      const raw = await callAppModel({
        sourceApp: 'simulator',
        purpose: 'App 内生成',
        char,
        userProfile,
        groups,
        apiConfig,
        realtimeConfig,
        sceneHint:
          `${project.name}；最近动作：${turn.action || turn.content}`.slice(0, 1000),
        appSystemPrompt:
          project.mode === 'frontend_ai'
            ? `${appPrompt}
严格输出 JSON：
{
  "message": "角色对用户说的话或剧情推进",
  "state": { "供 iframe 渲染的完整状态": true }
}
不要输出 Markdown。`
            : appPrompt,
        localMessages: buildLocal(turn),
        signal: abortRef.current.signal,
      });

      let content = raw;
      let frontendState: unknown = undefined;
      if (project.mode === 'frontend_ai') {
        const data = parseFirstJsonObject(raw);
        content = String(data?.message || '').trim() || '……';
        frontendState = data?.state ?? {};
        postSimulatorState(iframeRef.current, frontendState);
      }

      const nextSession: SimulatorSession = {
        ...sessionWithUser,
        turns: [...sessionWithUser.turns, {
          id: uid('simturn'),
          role: 'assistant',
          content,
          createdAt: Date.now(),
        }],
        frontendState: frontendState === undefined ? sessionWithUser.frontendState : frontendState,
        updatedAt: Date.now(),
      };
      setSession(nextSession);
      await DB.saveSimulatorSession(nextSession);
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        addToast(error?.message || '生成失败', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const sendText = async () => {
    const content = input.trim();
    if (!content) return;
    setInput('');
    await askAI({
      id: uid('simturn'),
      role: 'user',
      content,
      createdAt: Date.now(),
    });
  };

  useEffect(() => {
    if (view !== 'run' || project?.mode !== 'frontend_ai') return;
    const listener = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isSimulatorIframeAction(event.data)) return;
      void askAI({
        id: uid('simturn'),
        role: 'user',
        content: '',
        action: event.data.action,
        payload: event.data.payload,
        createdAt: Date.now(),
      });
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [view, project?.mode, session?.id, busy, char?.id]);

  const makeMemoryCandidates = async () => {
    if (!project || !session || !char || busy) return;
    setBusy(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      const transcript = session.turns
        .map((v) =>
          v.action
            ? `[动作 ${v.action}] ${JSON.stringify(v.payload ?? null)}`
            : `${v.role === 'user' ? userProfile.name : char.name}：${v.content}`,
        )
        .join('\n');
      const rows = await generateAppMemoryCandidates({
        sourceApp: 'simulator',
        sourceRecordId: session.id,
        char,
        userProfile,
        groups,
        apiConfig,
        realtimeConfig,
        transcript,
        sceneHint: `万象匣《${project.name}》共同经历`,
        signal: abortRef.current.signal,
      });
      setCandidates((old) => [...old, ...rows]);
      setShowMemory(true);
      if (rows.length === 0) addToast('这段经历暂时没有值得进入主记忆的内容');
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        addToast(error?.message || '整理记忆失败', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const endSession = async () => {
    if (!session) return;
    const next = {
      ...session,
      status: 'ended' as const,
      endedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await DB.saveSimulatorSession(next);
    setSession(next);
    addToast('本局已结束；是否进入主记忆仍由你决定');
  };

  if (view === 'editor' && project) {
    return (
      <div className="h-full w-full bg-[#f5f6fa] flex flex-col text-slate-800">
        <div
          className="bg-white/90 backdrop-blur-xl border-b border-slate-200/70 shrink-0 z-20"
          style={{ paddingTop: 'var(--safe-top)' }}
        >
          <div className="h-16 flex items-center px-4 gap-3">
            <button
              onClick={() => setView('list')}
              className="p-2 -ml-2 rounded-full text-slate-600 active:bg-black/5 active:scale-90 transition-all"
              aria-label="返回"
            >
              <ArrowLeft size={23} />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold tracking-tight">编辑万象匣</h1>
              <p className="text-[11px] text-slate-400 truncate">
                {project.name.trim() || '新建项目'}
              </p>
            </div>
            <button
              onClick={saveProject}
              className="h-9 px-3.5 rounded-xl bg-slate-900 text-white text-xs font-semibold shadow-sm active:scale-95 transition-all flex items-center gap-1.5"
            >
              <FloppyDisk size={16} weight="bold" />
              保存
            </button>
          </div>
        </div>

        <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 pb-10 space-y-4">
          <section className={sectionClass}>
            <div className="mb-4">
              <div className="text-[11px] font-bold tracking-[0.14em] text-indigo-500 uppercase">基础信息</div>
              <p className="mt-1 text-[10px] text-slate-400">名称、同行角色与运行方式。</p>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-500">名称</span>
                <input
                  value={project.name}
                  onChange={e => setProject({ ...project, name: e.target.value })}
                  placeholder="给这个万象匣起个名字"
                  className={fieldClass}
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-500">角色</span>
                <select
                  value={project.charId}
                  onChange={e => setProject({ ...project, charId: e.target.value })}
                  className={fieldClass}
                >
                  {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-500">运行模式</span>
                <select
                  value={project.mode}
                  onChange={e => setProject({ ...project, mode: e.target.value as SimulatorMode })}
                  className={fieldClass}
                >
                  {Object.entries(modeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className={sectionClass}>
            <div className="mb-4">
              <div className="text-[11px] font-bold tracking-[0.14em] text-indigo-500 uppercase">AI 与上下文</div>
              <p className="mt-1 text-[10px] text-slate-400">控制局内历史和玩法提示词。</p>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-500">局内上下文条数</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={project.localContextLimit}
                  onChange={e => setProject({
                    ...project,
                    localContextLimit: Math.max(1, Number(e.target.value) || 1),
                  })}
                  className={fieldClass}
                />
              </label>

              {project.mode !== 'html' && (
                <label className="block">
                  <span className="mb-2 block text-xs font-bold text-slate-500">玩法提示词</span>
                  <textarea
                    rows={8}
                    value={project.prompt}
                    onChange={e => setProject({ ...project, prompt: e.target.value })}
                    className={`${fieldClass} resize-y leading-6`}
                  />
                </label>
              )}
            </div>
          </section>

          {project.mode !== 'text' && (
            <section className={sectionClass}>
              <div className="mb-4">
                <div className="text-[11px] font-bold tracking-[0.14em] text-indigo-500 uppercase">页面与交互</div>
                <p className="mt-1 text-[10px] text-slate-400">HTML 会在沙箱 iframe 中运行。</p>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-500">HTML</span>
                <textarea
                  rows={18}
                  value={project.html}
                  onChange={e => setProject({ ...project, html: e.target.value })}
                  className={`${fieldClass} resize-y font-mono text-xs leading-5`}
                />
              </label>

              <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-600">iframe 通信示例</summary>
                <pre className="mt-3 whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-500">
                  {SIMULATOR_BRIDGE_HELP}
                </pre>
              </details>
            </section>
          )}

          <button
            onClick={saveProject}
            className="w-full h-12 rounded-2xl bg-slate-900 text-white text-sm font-semibold shadow-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <FloppyDisk size={18} weight="bold" />
            保存万象匣
          </button>
        </main>
      </div>
    );
  }

  if (view === 'run' && project && session) {
    const showFrame = project.mode !== 'text';
    const showChat = project.mode !== 'html';
    const acnh = osTheme.skin === 'animalcrossing' && osTheme.acnhChatSync !== false;
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const chatRootClass =
      chatChromeStyle === 'pixel'
        ? 'flex flex-col h-full bg-[#efe1cf] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
        : chatChromeStyle === 'flat'
          ? 'flex flex-col h-full bg-white overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
          : chatChromeStyle === 'floating'
            ? 'flex flex-col h-full bg-[#eef2ff] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
            : 'flex flex-col h-full bg-[#f1f5f9] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500';

    const chatRootStyle: React.CSSProperties = resolvedChatBackground
      ? {
          backgroundImage: `url("${resolvedChatBackground}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }
      : chatBackgroundStyle === 'grid'
        ? {
            backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
            backgroundImage:
              'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }
        : chatBackgroundStyle === 'paper'
          ? {
              backgroundColor: chatChromeStyle === 'pixel' ? '#f4e8d9' : '#f9f7f2',
              backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
              backgroundSize: '16px 16px',
            }
          : chatBackgroundStyle === 'mesh'
            ? {
                backgroundColor: '#f8fafc',
                backgroundImage:
                  'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
              }
            : { backgroundImage: 'none' };

    const finalChatRootClass = acnh
      ? 'flex flex-col h-full overflow-hidden relative font-sans transition-[background-color] duration-500'
      : chatRootClass;
    const finalChatRootStyle: React.CSSProperties = acnh
      ? { backgroundColor: '#F6F0D8', backgroundImage: 'none' }
      : chatRootStyle;

    const simulatorMessages: Message[] = session.turns.map((turn, index) => ({
      id: turn.createdAt + index,
      charId: char?.id || project.charId,
      role: turn.role,
      type: 'text',
      content: turn.action
        ? `前端动作 · ${turn.action}\n${JSON.stringify(turn.payload ?? '')}`
        : turn.content,
      timestamp: turn.createdAt,
      metadata: { source: 'simulator', simulatorTurnId: turn.id },
    }));
    const userAvatar = (char?.id && userProfile.perCharAvatars?.[char.id])
      || userProfile.avatar
      || '';

    const inputStyle = osTheme.chatInputStyle || 'default';
    const sendButtonStyle = osTheme.chatSendButtonStyle || 'circle';
    const isDiscordStyle = inputStyle === 'discord';
    const isPixelStyle = inputStyle === 'pixel' || chatChromeStyle === 'pixel';
    const inputShellClass = acnh
      ? 'bg-[#a8d6bb] border-t-[3px] border-[#86c29a] shadow-[0_-3px_0_rgba(110,160,130,0.18)]'
      : chatChromeStyle === 'pixel'
        ? 'bg-[#eadfce] border-t-[3px] border-[#8f674a] shadow-[0_-4px_0_rgba(123,90,64,0.15)]'
        : chatChromeStyle === 'flat'
          ? 'bg-white border-t border-slate-200 shadow-none'
          : chatChromeStyle === 'floating'
            ? 'bg-white/80 backdrop-blur-2xl border-t border-white/60 shadow-[0_-12px_30px_rgba(148,163,184,0.18)]'
            : 'bg-white/90 backdrop-blur-2xl border-t border-slate-200/50 shadow-[0_-5px_15px_rgba(0,0,0,0.02)]';
    const actionButtonClass = acnh
      ? 'w-11 h-11 shrink-0 rounded-full bg-[#4cb89e] flex items-center justify-center text-white hover:bg-[#43ad93] transition-colors shadow-sm'
      : isPixelStyle
        ? 'w-11 h-11 shrink-0 rounded-[4px] border-2 border-[#8f674a] bg-[#f8f0e0] flex items-center justify-center text-[#8f674a] hover:bg-[#fff7ed] transition-colors'
        : isDiscordStyle
          ? 'w-11 h-11 shrink-0 rounded-full bg-slate-800 flex items-center justify-center text-slate-200 hover:bg-slate-700 transition-colors'
          : 'w-11 h-11 shrink-0 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 transition-colors';
    const inputWrapClass = acnh
      ? 'bg-[#fbf4de] border-2 border-[#e6dab4] rounded-full'
      : inputStyle === 'rounded'
        ? 'bg-slate-100 rounded-full'
        : inputStyle === 'flat'
          ? 'bg-transparent border-b border-slate-200 rounded-none'
          : inputStyle === 'wechat'
            ? 'bg-white border border-slate-200 rounded-full'
            : inputStyle === 'ios'
              ? 'bg-white/80 border border-white/80 shadow-inner rounded-[26px]'
              : inputStyle === 'telegram'
                ? 'bg-white border border-sky-100 rounded-2xl'
                : inputStyle === 'discord'
                  ? 'bg-slate-800 border border-white/10 rounded-2xl text-white'
                  : inputStyle === 'pixel'
                    ? 'bg-[#f8f0e0] border-2 border-[#8f674a] rounded-[4px]'
                    : 'bg-slate-100 rounded-[24px]';
    const sendButtonClass = acnh
      ? 'w-11 h-11 shrink-0 rounded-full bg-[#f3d06a] text-[#6b5a3e] flex items-center justify-center shadow-md'
      : sendButtonStyle === 'pill'
        ? isPixelStyle
          ? 'h-11 min-w-[72px] shrink-0 rounded-[4px] border-2 border-[#8f674a] bg-[#c99872] px-4 text-[11px] font-bold text-[#fff7ed]'
          : 'h-11 min-w-[72px] shrink-0 rounded-full bg-primary px-4 text-[11px] font-bold text-white shadow-lg'
        : sendButtonStyle === 'minimal'
          ? isPixelStyle
            ? 'w-11 h-11 shrink-0 rounded-[4px] border-2 border-[#8f674a] bg-[#c99872] text-[#fff7ed] flex items-center justify-center'
            : isDiscordStyle
              ? 'w-11 h-11 shrink-0 rounded-full bg-transparent text-sky-300 flex items-center justify-center'
              : 'w-11 h-11 shrink-0 rounded-full bg-transparent text-primary flex items-center justify-center'
          : isPixelStyle
            ? 'w-11 h-11 shrink-0 rounded-[4px] border-2 border-[#8f674a] bg-[#c99872] text-[#fff7ed] flex items-center justify-center'
            : 'w-11 h-11 shrink-0 rounded-full bg-primary text-white flex items-center justify-center transition-all shadow-lg';

    const leaveRun = () => {
      setView('list');
      setSession(null);
      setProject(null);
    };

    return (
      <div className={`sully-chat-root ${finalChatRootClass}`} style={finalChatRootStyle}>
        {simulatorChatFineTuneCss && <style>{simulatorChatFineTuneCss}</style>}
        {osTheme.chatChromeCustomCss && <style>{osTheme.chatChromeCustomCss}</style>}
        {char?.chromeCustomCss && <style>{char.chromeCustomCss}</style>}
        {activeChatTheme.customCss && <style>{activeChatTheme.customCss}</style>}

        {(osTheme.chatChromeCustomCss || char?.chromeCustomCss || activeChatTheme.customCss) && (
          <style>{`
            .sully-chat-back{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
            .sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
            .sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important;}
          `}</style>
        )}

        {acnh && (
          <style>{`
            .sully-bubble-ai {
              background: #FBF4DE !important;
              color: #6b5a3e !important;
              border: 1.5px solid #efe6c8 !important;
              border-radius: 24px !important;
              box-shadow: 0 4px 10px -5px rgba(120,95,45,0.28) !important;
            }
            .sully-bubble-user {
              background: #F5C896 !important;
              color: #6b4a2f !important;
              border: 1.5px solid #eeb87f !important;
              border-radius: 24px !important;
              box-shadow: 0 4px 10px -5px rgba(150,100,55,0.32) !important;
            }
          `}</style>
        )}

        <ChatHeader
          selectionMode={false}
          selectedCount={0}
          onCancelSelection={() => undefined}
          activeCharacter={{
            id: char?.id || project.charId,
            name: project.name,
            avatar: char?.avatar || '',
            activeBuffs: char?.activeBuffs || [],
          }}
          isTyping={busy}
          isSummarizing={false}
          statusText={session.status === 'ended'
            ? `${char?.name || '角色'} · 已结束`
            : `${char?.name || '角色'} · ${modeLabel[project.mode]}`}
          extraAction={{
            label: '整理记忆',
            icon: <Sparkle className="w-5 h-5" weight="duotone" />,
            onClick: () => { if (!busy) void makeMemoryCandidates(); },
          }}
          triggerIcon="stop"
          lastTokenUsage={null}
          onClose={leaveRun}
          onTriggerAI={() => {
            if (!busy && session.status !== 'ended') void endSession();
          }}
          onShowCharsPanel={() => undefined}
          hideBuffs={osTheme.chatHideHeaderBuffs}
          headerStyle={osTheme.chatHeaderStyle}
          avatarShape={osTheme.chatAvatarShape}
          headerAlign={osTheme.chatHeaderAlign}
          headerDensity={osTheme.chatHeaderDensity}
          statusStyle={osTheme.chatStatusStyle}
          chromeStyle={osTheme.chatChromeStyle}
          acnh={acnh}
        />

        {showFrame && (
          <div
            className={[
              'bg-white min-h-0',
              project.mode === 'hybrid' ? 'flex-[0.9_1_0]' : 'flex-1',
            ].join(' ')}
          >
            <iframe
              ref={iframeRef}
              title={project.name}
              srcDoc={project.html}
              sandbox="allow-scripts allow-forms allow-modals"
              className="w-full h-full border-0 bg-white"
              onLoad={() => postSimulatorState(iframeRef.current, session.frontendState ?? {})}
            />
          </div>
        )}

        {showChat && (
          <div className="flex-1 min-h-0 flex flex-col bg-transparent">
            <div
              ref={runScrollRef}
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar"
            >
              {simulatorMessages.length === 0 && !busy && (
                <div className="h-full min-h-48 flex flex-col items-center justify-center text-center px-10">
                  <div className="text-sm font-semibold text-slate-500">本局还没开始说话</div>
                  <p className="mt-1.5 text-xs leading-5 text-slate-400">
                    和 {char?.name || '角色'} 一起推进这段故事。
                  </p>
                </div>
              )}

              {simulatorMessages.map((message, index) => (
                <MessageItem
                  key={session.turns[index]?.id || message.id}
                  msg={message}
                  isFirstInGroup={index === 0 || simulatorMessages[index - 1].role !== message.role}
                  isLastInGroup={index === simulatorMessages.length - 1 || simulatorMessages[index + 1].role !== message.role}
                  activeTheme={activeChatTheme}
                  charAvatar={char?.avatar || ''}
                  charName={char?.name || '角色'}
                  userAvatar={userAvatar}
                  isLatestMessage={index === simulatorMessages.length - 1}
                  onLongPress={() => undefined}
                  onReply={() => undefined}
                  selectionMode={false}
                  isSelected={false}
                  onToggleSelect={() => undefined}
                  avatarShape={osTheme.chatAvatarShape}
                  avatarSize={osTheme.chatAvatarSize}
                  avatarMode={osTheme.chatAvatarMode}
                  bubbleVariant={osTheme.chatBubbleStyle}
                  messageSpacing={osTheme.chatMessageSpacing}
                  showTimestamp={osTheme.chatShowTimestamp}
                  moduleAlign={mergedChatFineTune.chatModuleAlign || 'center'}
                />
              ))}

              {busy && (
                <div className="flex items-end gap-2 px-4 mb-4">
                  {char?.avatar && (
                    <img
                      src={char.avatar}
                      alt=""
                      className="w-9 h-9 rounded-full object-cover shrink-0 ring-1 ring-black/5"
                    />
                  )}
                  <div
                    className="px-4 py-3 rounded-[20px] text-sm"
                    style={{
                      color: activeChatTheme.ai.textColor,
                      backgroundColor: activeChatTheme.ai.backgroundColor,
                      opacity: activeChatTheme.ai.opacity ?? 1,
                    }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-35 animate-pulse" />
                      <span className="opacity-55">{char?.name || '角色'} 正在回复…</span>
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className={`sully-chat-inputbar ${inputShellClass} pb-safe shrink-0 z-40 relative`}>
              <div className="p-3 px-4 flex gap-3 items-end relative">
                <button
                  onClick={() => setRunPanel(runPanel === 'actions' ? 'none' : 'actions')}
                  disabled={busy}
                  className={actionButtonClass}
                  aria-label="万象匣操作"
                >
                  <Plus className="w-6 h-6" weight="bold" />
                </button>
                <div
                  className={`flex-1 min-w-0 flex items-center px-1 transition-all overflow-hidden ${inputWrapClass} ${
                    isPixelStyle
                      ? 'focus-within:bg-[#fff7ed]'
                      : isDiscordStyle
                        ? 'focus-within:bg-slate-800 focus-within:border-white/20'
                        : 'border border-transparent focus-within:bg-white focus-within:border-primary/30'
                  }`}
                >
                  <textarea
                    rows={1}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        if (!busy && session.status !== 'ended' && input.trim()) void sendText();
                      }
                    }}
                    disabled={busy || session.status === 'ended'}
                    inputMode="text"
                    enterKeyHint="send"
                    autoCorrect="on"
                    autoCapitalize="sentences"
                    placeholder={session.status === 'ended' ? '本局已结束' : 'Message...'}
                    className={`flex-1 min-w-0 bg-transparent px-4 py-3 text-[15px] resize-none max-h-24 no-scrollbar outline-none disabled:opacity-50 ${
                      isDiscordStyle
                        ? 'text-white placeholder:text-slate-500'
                        : isPixelStyle
                          ? 'text-[#6a4c35] placeholder:text-[#9b8677]'
                          : 'text-slate-800 placeholder:text-slate-400'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => addToast('万象匣暂时只发送文字消息')}
                    className={`p-2 shrink-0 ${isDiscordStyle ? 'text-slate-400 hover:text-sky-300' : isPixelStyle ? 'text-[#8f674a] hover:text-[#a16207]' : 'text-slate-400 hover:text-primary'}`}
                    aria-label="表情"
                  >
                    <Smiley className="w-6 h-6" weight="regular" />
                  </button>
                </div>
                <button
                  onClick={() => void sendText()}
                  disabled={busy || session.status === 'ended' || !input.trim()}
                  className={`${sendButtonClass} ${input.trim() && session.status !== 'ended' ? '' : 'opacity-45 shadow-none'} disabled:active:scale-100`}
                >
                  {sendButtonStyle === 'pill'
                    ? <span>发送</span>
                    : <PaperPlaneTilt className="w-5 h-5" weight="fill" />}
                </button>
              </div>

              <div
                className={`overflow-hidden transition-[max-height] duration-200 ease-out ${
                  isPixelStyle ? 'bg-[#f8f0e0] border-t-2 border-[#8f674a]' :
                  isDiscordStyle ? 'bg-slate-900/95 border-t border-white/10' :
                  acnh ? 'bg-[#f3ecdc] border-t-[3px] border-[#e0d6c0]' :
                  'bg-slate-50 border-t border-slate-200/60'
                }`}
                style={{ maxHeight: runPanel === 'actions' ? '9rem' : '0px' }}
              >
                <div className="grid grid-cols-2 gap-3 p-4">
                  <button
                    onClick={() => { setRunPanel('none'); if (!busy) void makeMemoryCandidates(); }}
                    disabled={busy}
                    className="h-16 rounded-2xl bg-white/80 border border-slate-200/70 flex flex-col items-center justify-center gap-1 text-xs font-semibold text-slate-600 active:scale-95 transition"
                  >
                    <Sparkle size={20} weight="duotone" />
                    整理记忆
                  </button>
                  <button
                    onClick={() => { setRunPanel('none'); if (!busy && session.status !== 'ended') void endSession(); }}
                    disabled={busy || session.status === 'ended'}
                    className="h-16 rounded-2xl bg-white/80 border border-slate-200/70 flex flex-col items-center justify-center gap-1 text-xs font-semibold text-slate-600 active:scale-95 transition disabled:opacity-40"
                  >
                    <span className="text-lg leading-none">■</span>
                    结束本局
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showMemory && char && (
          <AppMemoryCandidatePanel
            candidates={candidates}
            char={char}
            userProfile={userProfile}
            memoryPalaceConfig={memoryPalaceConfig}
            remoteVectorConfig={remoteVectorConfig}
            updateCharacter={updateCharacter}
            addToast={addToast}
            onChange={setCandidates}
            onClose={() => setShowMemory(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-[#f5f6fa] flex flex-col text-slate-800 relative">
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="删除万象匣"
        message={deleteTarget ? `确定删除「${deleteTarget.name}」吗？相关项目数据会一并移除。` : ''}
        confirmText="删除"
        variant="danger"
        onConfirm={() => {
          if (deleteTarget) void deleteProject(deleteTarget.id);
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      <div
        className="bg-white/90 backdrop-blur-xl border-b border-slate-200/70 shrink-0 z-20"
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <div className="h-16 flex items-center px-4 gap-3">
          <button
            onClick={closeApp}
            className="p-2 -ml-2 rounded-full text-slate-600 active:bg-black/5 active:scale-90 transition-all"
            aria-label="返回"
          >
            <ArrowLeft size={23} />
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight">万象匣</h1>
            <p className="text-[11px] text-slate-400">导入页面、模拟器和 AI 文游</p>
          </div>

          <button
            onClick={openNew}
            className="w-10 h-10 rounded-xl bg-slate-900 text-white grid place-items-center shadow-sm active:scale-95 transition-all"
            aria-label="新建万象匣"
          >
            <Plus size={20} weight="bold" />
          </button>
        </div>
      </div>

      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {projects.length === 0 ? (
          <div className="h-72 flex flex-col items-center justify-center text-center px-8">
            <div className="w-16 h-16 rounded-2xl bg-white border border-slate-100 shadow-sm grid place-items-center text-indigo-400 mb-4">
              <Sparkle size={28} weight="duotone" />
            </div>
            <div className="text-sm font-semibold text-slate-600">还没有万象匣</div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              新建一个项目，把纯文字文游、HTML 页面或 AI 互动收进来。
            </p>
            <button
              onClick={openNew}
              className="mt-5 h-10 px-4 rounded-xl bg-slate-900 text-white text-xs font-semibold shadow-sm active:scale-95 transition-all"
            >
              新建万象匣
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {projects.map(p => {
              const projectChar = characters.find(c => c.id === p.charId);
              return (
                <article
                  key={p.id}
                  className="rounded-[1.5rem] border border-slate-200/70 bg-white p-4 shadow-sm shadow-slate-200/40"
                >
                  <div className="flex gap-3 items-start">
                    <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-500 grid place-items-center shrink-0">
                      <Sparkle size={22} weight="duotone" />
                    </div>

                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="text-[15px] font-bold text-slate-800 truncate">{p.name}</div>
                      <div className="mt-1 text-xs text-slate-400 truncate">
                        {modeLabel[p.mode]} · {projectChar?.name || '角色已删除'}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-2">
                    <button
                      onClick={() => {
                        setProject(p);
                        setView('editor');
                      }}
                      className="h-9 px-3 rounded-xl bg-slate-100 text-slate-600 text-xs font-semibold active:scale-95 transition-all"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => setDeleteTarget(p)}
                      className="w-9 h-9 rounded-xl bg-rose-50 text-rose-500 grid place-items-center active:scale-95 transition-all"
                      aria-label={`删除 ${p.name}`}
                    >
                      <Trash size={17} />
                    </button>
                    <button
                      onClick={() => void start(p)}
                      className="ml-auto h-9 px-4 rounded-xl bg-slate-900 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm active:scale-95 transition-all"
                    >
                      <Play size={15} weight="fill" />
                      进入
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default SimulatorApp;
