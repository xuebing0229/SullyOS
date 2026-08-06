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
    await reload();
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
      <div className="w-full h-full overflow-auto bg-stone-50">
        <header style={{ padding: 'calc(var(--safe-top) + 14px) 16px 12px', display: 'flex', gap: 12 }}>
          <button onClick={() => setView('list')}><ArrowLeft size={22} /></button>
          <strong style={{ flex: 1 }}>编辑万象匣</strong>
          <button onClick={saveProject}><FloppyDisk size={22} /></button>
        </header>
        <main style={{ padding: 16, display: 'grid', gap: 14 }}>
          <label>名称<input value={project.name} onChange={e => setProject({...project,name:e.target.value})} /></label>
          <label>角色
            <select value={project.charId} onChange={e => setProject({...project,charId:e.target.value})}>
              {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>运行模式
            <select value={project.mode} onChange={e => setProject({...project,mode:e.target.value as SimulatorMode})}>
              {Object.entries(modeLabel).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>局内上下文条数
            <input type="number" min={1} max={200} value={project.localContextLimit}
              onChange={e => setProject({...project,localContextLimit:Math.max(1,Number(e.target.value)||1)})}/>
          </label>
          {project.mode !== 'html' && (
            <label>玩法提示词<textarea rows={8} value={project.prompt} onChange={e => setProject({...project,prompt:e.target.value})}/></label>
          )}
          {project.mode !== 'text' && (
            <>
              <label>HTML<textarea rows={18} value={project.html} onChange={e => setProject({...project,html:e.target.value})}/></label>
              <details><summary>iframe 通信示例</summary><pre style={{whiteSpace:'pre-wrap'}}>{SIMULATOR_BRIDGE_HELP}</pre></details>
            </>
          )}
          <button onClick={saveProject} style={{padding:14,background:'#6d28d9',color:'#fff',borderRadius:14}}>保存</button>
        </main>
      </div>
    );
  }

  if (view === 'run' && project && session) {
    const showFrame = project.mode !== 'text';
    const showChat = project.mode !== 'html';
    return (
      <div className="w-full h-full flex flex-col bg-slate-950 text-white" style={{position:'relative'}}>
        <header style={{ padding: 'calc(var(--safe-top) + 10px) 12px 10px', display:'flex',gap:10,alignItems:'center' }}>
          <button onClick={() => setView('list')}><ArrowLeft size={22}/></button>
          <div style={{flex:1}}><strong>{project.name}</strong><div style={{fontSize:11,opacity:.6}}>{char?.name} · {modeLabel[project.mode]}</div></div>
          <button onClick={makeMemoryCandidates} disabled={busy}><Sparkle size={21}/></button>
        </header>

        {showFrame && (
          <iframe
            ref={iframeRef}
            title={project.name}
            srcDoc={project.html}
            sandbox="allow-scripts allow-forms allow-modals"
            style={{ width:'100%', flex: project.mode === 'hybrid' ? '.9 1 0' : '1 1 0', border:0, background:'#fff' }}
            onLoad={() => postSimulatorState(iframeRef.current, session.frontendState ?? {})}
          />
        )}

        {showChat && (
          <div style={{flex:'1 1 0',minHeight:0,display:'flex',flexDirection:'column',background:'#0f172a'}}>
            <div style={{flex:1,overflow:'auto',padding:14,display:'grid',gap:10}}>
              {session.turns.map(t => (
                <div key={t.id} style={{
                  justifySelf:t.role==='user'?'end':'start',
                  maxWidth:'86%',padding:'9px 12px',borderRadius:14,
                  background:t.role==='user'?'#6d28d9':'#1e293b',whiteSpace:'pre-wrap'
                }}>
                  {t.action ? `[${t.action}] ${JSON.stringify(t.payload ?? '')}` : t.content}
                </div>
              ))}
              {busy && <div style={{opacity:.6}}>正在推进…</div>}
            </div>
            <div style={{display:'flex',gap:8,padding:`10px 12px calc(10px + var(--safe-bottom))`}}>
              <textarea value={input} onChange={e=>setInput(e.target.value)} rows={1}
                placeholder="你要做什么…" style={{flex:1,borderRadius:14,padding:10,color:'#111'}}/>
              <button onClick={sendText} disabled={busy||!input.trim()} style={{padding:'0 16px',background:'#7c3aed',borderRadius:14}}>发送</button>
            </div>
          </div>
        )}

        <div style={{position:'absolute',right:12,bottom:'calc(76px + var(--safe-bottom))'}}>
          <button onClick={endSession} disabled={session.status==='ended'}
            style={{padding:'8px 12px',borderRadius:999,background:'rgba(15,23,42,.84)'}}>
            {session.status==='ended'?'已结束':'结束本局'}
          </button>
        </div>

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
            onClose={()=>setShowMemory(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-auto bg-[#f7f4ed]">
      <header style={{padding:'calc(var(--safe-top) + 14px) 16px 12px',display:'flex',alignItems:'center',gap:12}}>
        <button onClick={closeApp}><ArrowLeft size={22}/></button>
        <div style={{flex:1}}><h1 style={{fontSize:20,fontWeight:800}}>万象匣</h1><div style={{fontSize:12,color:'#78716c'}}>导入页面、模拟器和 AI 文游</div></div>
        <button onClick={openNew}><Plus size={23}/></button>
      </header>
      <main style={{padding:16,display:'grid',gap:12}}>
        {projects.length===0 && <div style={{padding:48,textAlign:'center',color:'#78716c'}}>还没有万象匣</div>}
        {projects.map(p=>(
          <div key={p.id} style={{padding:14,borderRadius:18,background:'#fff',boxShadow:'0 8px 24px rgba(0,0,0,.06)'}}>
            <div style={{display:'flex',gap:10,alignItems:'center'}}>
              <div style={{flex:1}}><strong>{p.name}</strong><div style={{fontSize:12,color:'#78716c',marginTop:4}}>{modeLabel[p.mode]} · {characters.find(c=>c.id===p.charId)?.name||'角色已删除'}</div></div>
              <button onClick={()=>{setProject(p);setView('editor')}}>编辑</button>
              <button onClick={()=>deleteProject(p.id)}><Trash size={18}/></button>
              <button onClick={()=>start(p)} style={{padding:9,borderRadius:999,background:'#6d28d9',color:'#fff'}}><Play size={18}/></button>
            </div>
          </div>
        ))}
      </main>
    </div>
  );
};

export default SimulatorApp;
