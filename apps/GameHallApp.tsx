import React, { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, GameController, GearSix, LinkSimple, ShieldCheck, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import SensitiveTextInput from '../components/SensitiveTextInput';
import CedarToySurface from '../components/gameHall/CedarToySurface';
import { buildCedarCapabilityMap, clearCedarConnection, describeCedarCapabilities, diagnoseCedarConnection, loadCedarConnection, saveCedarConnection } from '../utils/cedarToyMcpAdapter';
import type { CedarCapabilityMap, CedarToyConnection, GameHallCompanionMode, GameHallWebState } from '../utils/gameHallTypes';

const MODES: Array<{ id: GameHallCompanionMode; label: string }> = [
  { id: 'observe', label: '只观察' }, { id: 'ask-before-action', label: '行动前询问' }, { id: 'auto-turn', label: '自动回合' },
];

const GameHallApp: React.FC = () => {
  const { closeApp, characters, activeCharacterId, isLocked } = useOS();
  const [charId, setCharId] = useState(activeCharacterId || characters[0]?.id || '');
  const [mode, setMode] = useState<GameHallCompanionMode>('ask-before-action');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connection, setConnection] = useState<CedarToyConnection>(() => loadCedarConnection());
  const [capabilities, setCapabilities] = useState<CedarCapabilityMap | null>(() => connection.tools ? buildCedarCapabilityMap(connection.tools) : null);
  const [testing, setTesting] = useState(false);
  const [diagnostic, setDiagnostic] = useState('尚未测试连接');
  const [webState, setWebState] = useState<GameHallWebState>({ url: 'https://toy.cedarstar.org/', loading: true });
  const selected = useMemo(() => characters.find(c => c.id === charId) || characters[0], [characters, charId]);
  const handleWebState = useCallback((state: GameHallWebState) => setWebState(state), []);

  const testConnection = async () => {
    setTesting(true); setDiagnostic('正在执行 initialize 与 tools/list…');
    const result = await diagnoseCedarConnection(connection);
    setTesting(false);
    if (!result.ok) { setDiagnostic(`连接失败：${result.message}`); return; }
    const next = { ...connection, tools: result.tools || [], updatedAt: Date.now() };
    setConnection(next); saveCedarConnection(next);
    const map = result.capabilities || buildCedarCapabilityMap(result.tools || []);
    setCapabilities(map);
    const missing = !map.state.length ? '连接成功，但暂未识别出游戏状态工具。' : !map.action.length ? '连接成功，已识别状态工具，但暂未识别行动工具。' : '连接成功，已识别状态与行动能力。';
    setDiagnostic(`${result.message}。${missing}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top,#312e81,#0f172a_48%,#020617)] text-white" style={{ paddingTop: 'var(--chrome-top)', paddingBottom: 'var(--safe-bottom)' }}>
      <header className="flex h-14 shrink-0 items-center gap-3 px-3">
        <button onClick={closeApp} className="rounded-xl p-2 hover:bg-white/10" aria-label="返回桌面"><ArrowLeft size={22} /></button>
        <GameController size={25} weight="fill" className="text-violet-300" />
        <div className="min-w-0 flex-1"><h1 className="font-bold">游戏厅</h1><p className="truncate text-[10px] text-slate-400">Cedar Toy · {webState.loading ? '加载中' : webState.title || '已打开'}</p></div>
        <button onClick={() => setSettingsOpen(true)} className="rounded-xl p-2 hover:bg-white/10" aria-label="游戏厅设置"><GearSix size={22} /></button>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
        <CedarToySurface suspended={settingsOpen || isLocked} onState={handleWebState} />
        <section className="shrink-0 rounded-2xl border border-white/10 bg-slate-900/90 p-3 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-3">
            {selected?.avatar ? <img src={selected.avatar} alt="" className="h-10 w-10 rounded-full object-cover" /> : <div className="grid h-10 w-10 place-items-center rounded-full bg-violet-500">🎮</div>}
            <select value={charId} onChange={e => setCharId(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-800 px-3 py-2 text-sm">
              {characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}
            </select>
            <span className={`h-2.5 w-2.5 rounded-full ${capabilities?.state.length ? 'bg-emerald-400' : 'bg-amber-400'}`} title="MCP 状态" />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-black/20 p-1">
            {MODES.map(item => <button key={item.id} onClick={() => setMode(item.id)} className={`rounded-lg px-1 py-2 text-[11px] ${mode === item.id ? 'bg-violet-500 font-semibold' : 'text-slate-400'}`}>{item.label}</button>)}
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-300">{selected ? `${selected.name} 已进入陪玩席。` : '请先创建并选择角色。'} Phase 1 仅提供网页、角色席与真实 MCP 协议诊断；未识别工具前不会假装读取或操作存档。</p>
        </section>
      </main>

      {settingsOpen && <div className="absolute inset-0 z-50 flex items-end bg-black/60" onClick={() => setSettingsOpen(false)}>
        <div className="max-h-[88%] w-full overflow-y-auto rounded-t-3xl bg-slate-950 p-5 pb-[calc(var(--safe-bottom)+20px)]" onClick={e => e.stopPropagation()}>
          <div className="mb-5 flex items-center"><div className="flex-1"><h2 className="font-bold">Cedar Toy MCP</h2><p className="text-xs text-slate-400">URL 与工具参数全部以服务端实际协议为准</p></div><button onClick={() => setSettingsOpen(false)} className="p-2"><X size={22}/></button></div>
          <label className="mb-3 block text-xs text-slate-300">MCP URL<input value={connection.url} onChange={e => setConnection(v => ({ ...v, url: e.target.value }))} placeholder="https://实际服务地址（不会自动拼 /mcp）" className="mt-1 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-3 text-sm" inputMode="url" /></label>
          <label className="mb-3 block text-xs text-slate-300">Bearer Token（可选）<SensitiveTextInput value={connection.token || ''} onChange={e => setConnection(v => ({ ...v, token: e.target.value }))} className="mt-1 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-3 text-sm" autoComplete="off" /></label>
          <label className="mb-3 block text-xs text-slate-300">代理 URL（可选）<input value={connection.proxyUrl || ''} onChange={e => setConnection(v => ({ ...v, proxyUrl: e.target.value }))} className="mt-1 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-3 text-sm" inputMode="url" /></label>
          <div className="grid grid-cols-2 gap-2"><button disabled={testing} onClick={testConnection} className="flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 py-3 text-sm font-semibold disabled:opacity-50"><LinkSimple size={18}/>{testing ? '测试中…' : '测试连接'}</button><button onClick={() => { saveCedarConnection({ ...connection, updatedAt: Date.now() }); setDiagnostic('设置已保存，尚未重新测试。'); }} className="rounded-xl bg-slate-800 px-3 py-3 text-sm">保存设置</button></div>
          <div className="mt-4 rounded-2xl border border-white/10 bg-slate-900 p-4"><div className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="text-emerald-400"/>协议诊断</div><p className="text-xs leading-5 text-slate-300">{diagnostic}</p>{capabilities && <ul className="mt-3 space-y-1 text-xs text-slate-400">{describeCedarCapabilities(capabilities).map(line => <li key={line}>• {line}</li>)}</ul>}</div>
          <button onClick={() => { clearCedarConnection(); setConnection({ url: '', token: '', proxyUrl: '', proxyKey: '', updatedAt: 0 }); setCapabilities(null); setDiagnostic('连接设置与本地工具缓存已清除。'); }} className="mt-4 w-full rounded-xl border border-red-400/30 px-3 py-3 text-sm text-red-300">清除会话与连接设置</button>
          <p className="mt-4 text-[11px] leading-5 text-slate-500">隐私边界：游戏厅不会读取或导出网页 Cookie、密码、LocalStorage、表单值或页面正文。原生层只上报 URL、标题、加载状态和能否后退。</p>
        </div>
      </div>}
    </div>
  );
};
export default GameHallApp;
