import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Plus, Play, Trash, FloppyDisk, Sparkle } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import type {
  AppMemoryCandidate,
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
  } = useOS();

  const [view, setView] = useState<View>('list');
  const [projects, setProjects] = useState<SimulatorProject[]>([]);
  const [project, setProject] = useState<SimulatorProject | null>(null);
  const [session, setSession] = useState<SimulatorSession | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<AppMemoryCandidate[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SimulatorProject | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const char = useMemo(
    () => characters.find((v) => v.id === project?.charId) || null,
    [characters, project?.charId],
  );

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
    return (
      <div className="h-full w-full bg-[#f5f6fa] flex flex-col text-slate-800 relative">
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

            {char?.avatar ? (
              <img
                src={char.avatar}
                alt=""
                className="w-9 h-9 rounded-full object-cover shrink-0 border border-slate-100"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-slate-100 text-slate-500 grid place-items-center shrink-0 text-xs font-bold">
                {(char?.name || '?').slice(0, 1)}
              </div>
            )}

            <div className="min-w-0 flex-1">
              <h1 className="text-[15px] font-semibold text-slate-800 truncate">{project.name}</h1>
              <p className="text-[11px] text-slate-400 truncate">
                {char?.name} · {modeLabel[project.mode]}
              </p>
            </div>

            <button
              onClick={makeMemoryCandidates}
              disabled={busy}
              className="w-9 h-9 rounded-xl bg-slate-100 text-slate-600 grid place-items-center active:scale-95 transition-all disabled:opacity-40"
              aria-label="整理记忆"
            >
              <Sparkle size={18} weight="duotone" />
            </button>

            <button
              onClick={endSession}
              disabled={session.status === 'ended'}
              className={[
                'h-9 px-3 rounded-xl text-xs font-semibold transition-all',
                session.status === 'ended'
                  ? 'bg-slate-100 text-slate-400'
                  : 'bg-rose-50 text-rose-500 active:scale-95',
              ].join(' ')}
            >
              {session.status === 'ended' ? '已结束' : '结束'}
            </button>
          </div>
        </div>

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
          <div className="flex-1 min-h-0 flex flex-col bg-[#f5f6fa]">
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5 space-y-3 no-scrollbar">
              {session.turns.length === 0 && !busy && (
                <div className="h-full min-h-48 flex flex-col items-center justify-center text-center px-10">
                  <div className="w-14 h-14 rounded-2xl bg-white border border-slate-100 shadow-sm grid place-items-center text-indigo-400 mb-3">
                    <Sparkle size={25} weight="duotone" />
                  </div>
                  <div className="text-sm font-semibold text-slate-600">本局还没开始说话</div>
                  <p className="mt-1.5 text-xs leading-5 text-slate-400">
                    和 {char?.name || '角色'} 一起推进这段故事。
                  </p>
                </div>
              )}

              {session.turns.map(t => {
                const isUser = t.role === 'user';
                return (
                  <div
                    key={t.id}
                    className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    {!isUser && (
                      char?.avatar ? (
                        <img
                          src={char.avatar}
                          alt=""
                          className="w-8 h-8 rounded-full object-cover shrink-0 mr-2 mt-0.5 border border-white shadow-sm"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-white border border-slate-100 shadow-sm text-slate-500 grid place-items-center shrink-0 mr-2 mt-0.5 text-[10px] font-bold">
                          {(char?.name || '?').slice(0, 1)}
                        </div>
                      )
                    )}

                    <div
                      className={[
                        'max-w-[78%] px-3.5 py-2.5 text-[14px] leading-6 whitespace-pre-wrap break-words',
                        isUser
                          ? 'bg-primary text-white rounded-[20px] rounded-br-[7px] shadow-sm'
                          : 'bg-white text-slate-700 border border-slate-100 rounded-[20px] rounded-bl-[7px] shadow-sm shadow-slate-200/40',
                      ].join(' ')}
                    >
                      {t.action ? (
                        <>
                          <div className={`mb-1.5 text-[10px] font-semibold tracking-wide ${isUser ? 'text-white/70' : 'text-slate-400'}`}>
                            前端动作 · {t.action}
                          </div>
                          <div>{JSON.stringify(t.payload ?? '')}</div>
                        </>
                      ) : (
                        t.content
                      )}
                    </div>
                  </div>
                );
              })}

              {busy && (
                <div className="flex items-center gap-2 text-xs text-slate-400 pl-10">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-pulse" />
                  {char?.name || '角色'} 正在回复…
                </div>
              )}
            </div>

            <div
              className="shrink-0 px-3 pt-2 bg-white/90 backdrop-blur-xl border-t border-slate-200/70"
              style={{ paddingBottom: 'calc(10px + var(--safe-bottom))' }}
            >
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0 min-h-[46px] rounded-[22px] bg-slate-100 border border-slate-200/70 px-4 py-2.5 flex items-center">
                  <textarea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    rows={1}
                    placeholder="你要做什么…"
                    className="w-full max-h-28 resize-none bg-transparent outline-none text-[14px] leading-6 text-slate-800 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={sendText}
                  disabled={busy || !input.trim()}
                  className="h-11 px-4 rounded-[18px] bg-primary text-white text-sm font-semibold shadow-sm active:scale-95 transition-all disabled:opacity-35 disabled:active:scale-100"
                >
                  发送
                </button>
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
