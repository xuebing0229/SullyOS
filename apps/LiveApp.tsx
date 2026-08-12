import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowClockwise, Broadcast, CaretRight, GearSix, Gift, Microphone,
  Pause, Play, Ranking, Repeat, Sparkle, UsersThree, X,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { branchLiveTimeline, indexLiveEvents, visibleLiveEvents } from '../utils/livePlayback';
import { generateLiveRooms, generateLiveTimeline, generateMyLiveReactions, type LiveAiRuntime } from '../utils/liveAiClient';
import { LiveRepository } from '../utils/liveRepository';
import {
  defaultLiveSettings, LIVE_GIFTS, liveId,
  type LiveEvent, type LiveGift, type LiveRoom, type LiveSession, type LiveSettings,
} from '../utils/liveTypes';

type HomeTab = 'recommend' | 'following' | 'mine';
type Overlay = 'gift' | 'rank' | 'mic' | 'settings' | 'start' | null;

const shell = 'h-full w-full bg-[#0c0c12] text-white flex flex-col overflow-hidden';
const panel = 'bg-white/[0.07] border border-white/10 rounded-2xl';

const viewerText = (count: number) => count >= 10000 ? `${(count / 10000).toFixed(1)}万` : String(count);

const LiveApp: React.FC = () => {
  const {
    closeApp, characters, activeCharacterId, apiConfig, userProfile, groups,
    realtimeConfig, addToast,
  } = useOS();
  const runtime: LiveAiRuntime = useMemo(() => ({ apiConfig, userProfile, groups, realtimeConfig }), [apiConfig, userProfile, groups, realtimeConfig]);
  const [tab, setTab] = useState<HomeTab>('recommend');
  const [settings, setSettings] = useState<LiveSettings>(defaultLiveSettings);
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [room, setRoom] = useState<LiveRoom | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [danmuInput, setDanmuInput] = useState('');
  const [micInput, setMicInput] = useState('');
  const [micActive, setMicActive] = useState(false);
  const [hostInput, setHostInput] = useState('');
  const [newTitle, setNewTitle] = useState('今晚随便聊聊');
  const [error, setError] = useState('');
  const eventMap = useMemo(() => indexLiveEvents(events), [events]);
  const visible = useMemo(() => visibleLiveEvents(events, currentTime), [events, currentTime]);
  const roomRef = useRef(room);
  roomRef.current = room;

  useEffect(() => {
    Promise.all([LiveRepository.getSettings(), LiveRepository.getRooms(), LiveRepository.getSessions()])
      .then(([savedSettings, savedRooms, savedSessions]) => {
        setSettings({ ...savedSettings, profileName: savedSettings.profileName || userProfile.name });
        setRooms(savedRooms);
        setSessions(savedSessions);
      })
      .catch(err => setError(err?.message || '直播数据加载失败'));
  }, [userProfile.name]);

  useEffect(() => {
    if (!playing || !room) return;
    const delay = Math.max(120, Math.round(1000 / settings.speed));
    const timer = window.setInterval(() => {
      setCurrentTime(previous => {
        const next = previous + 1;
        if (next >= room.duration) {
          setPlaying(false);
          return room.duration;
        }
        return next;
      });
    }, delay);
    return () => window.clearInterval(timer);
  }, [playing, room?.id, room?.duration, settings.speed]);

  useEffect(() => {
    if (!room) return;
    const id = window.setTimeout(() => {
      const updated = { ...room, currentTime, status: playing ? 'live' as const : 'paused' as const, updatedAt: Date.now() };
      LiveRepository.saveRoom(updated).catch(() => undefined);
      if (updated.kind === 'mine') {
        LiveRepository.saveSession({
          id: `session_${updated.id}`, roomId: updated.id, mode: 'host', title: updated.title,
          status: 'paused', currentTime, createdAt: updated.createdAt, updatedAt: Date.now(),
        }).catch(() => undefined);
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [currentTime, playing, room?.id]);

  const persistTimeline = async (nextRoom: LiveRoom, nextEvents: LiveEvent[]) => {
    setRoom(nextRoom);
    setEvents(nextEvents);
    setRooms(previous => [nextRoom, ...previous.filter(item => item.id !== nextRoom.id)]);
    await Promise.all([LiveRepository.saveRoom(nextRoom), LiveRepository.replaceEvents(nextRoom.id, nextEvents)]);
  };

  const refreshList = async (kind: 'recommend' | 'following') => {
    setBusy(true); setError('');
    try {
      const generated = await generateLiveRooms({ runtime, settings, kind, characters });
      const keep = rooms.filter(item => item.kind !== kind);
      setRooms([...generated, ...keep]);
      await LiveRepository.saveRooms(generated);
      if (kind === 'following' && !generated.length) addToast('先在直播设置里选择关注角色', 'info');
    } catch (err: any) { setError(err?.message || '直播列表生成失败'); }
    finally { setBusy(false); }
  };

  const enterRoom = async (selected: LiveRoom) => {
    setBusy(true); setError('');
    try {
      const saved = await LiveRepository.getEvents(selected.id);
      let timeline = saved;
      let nextRoom = { ...selected, status: 'live' as const };
      if (!timeline.length) {
        const character = characters.find(char => char.id === selected.characterId);
        timeline = await generateLiveTimeline({ runtime, settings, room: selected, character });
        const maxTime = Math.max(settings.duration, ...timeline.map(event => event.time + 1));
        nextRoom = { ...nextRoom, duration: maxTime, currentTime: 0, updatedAt: Date.now() };
      }
      await persistTimeline(nextRoom, timeline);
      setCurrentTime(Math.min(selected.currentTime || 0, nextRoom.duration));
      setPlaying(true);
      setMicActive(false);
    } catch (err: any) { setError(err?.message || '进入直播间失败'); }
    finally { setBusy(false); }
  };

  const leaveRoom = async () => {
    if (room) await LiveRepository.saveRoom({ ...room, currentTime, status: 'paused', updatedAt: Date.now() });
    setPlaying(false); setRoom(null); setEvents([]); setOverlay(null); setMicActive(false);
    setSessions(await LiveRepository.getSessions());
  };

  const rewriteFuture = async (triggerText: string, triggerType: LiveEvent['type'], triggerUser?: string, atTime = currentTime, roomOverride?: LiveRoom) => {
    const baseRoom = roomOverride || room;
    if (!baseRoom) return;
    setBusy(true); setPlaying(false); setError('');
    try {
      const character = characters.find(char => char.id === baseRoom.characterId);
      const trigger: LiveEvent = {
        id: liveId('event'), roomId: baseRoom.id, time: atTime, type: triggerType,
        content: triggerText, user: triggerUser, origin: 'user', createdAt: Date.now(),
      };
      const future = await generateLiveTimeline({
        runtime, settings, room: baseRoom, character, startAt: atTime,
        trigger: `${triggerUser || userProfile.name} ${triggerText}`, history: [...events.filter(e => e.time <= atTime), trigger],
      });
      const nextEvents = branchLiveTimeline(events, atTime, trigger, future);
      const nextRoom = { ...baseRoom, duration: Math.max(atTime + 1, ...nextEvents.map(event => event.time + 1)), status: 'live' as const, updatedAt: Date.now() };
      await persistTimeline(nextRoom, nextEvents);
      setPlaying(true);
      return future;
    } catch (err: any) { setError(err?.message || '直播互动失败'); }
    finally { setBusy(false); }
  };

  const sendDanmu = async () => {
    const text = danmuInput.trim(); if (!text) return;
    setDanmuInput('');
    await rewriteFuture(text, 'danmu', userProfile.name || '我');
  };

  const sendGift = async (gift: LiveGift) => {
    if (!room || settings.walletBalance < gift.price) { addToast('直播币余额不足', 'error'); return; }
    const nextSettings = { ...settings, walletBalance: settings.walletBalance - gift.price, updatedAt: Date.now() };
    const previous = room.rank.find(item => item.isUser);
    const userRank = { id: previous?.id || 'user', name: userProfile.name || '我', avatar: userProfile.avatar, score: (previous?.score || 0) + gift.price, isUser: true };
    const nextRoom = { ...room, rank: [userRank, ...room.rank.filter(item => !item.isUser)].sort((a, b) => b.score - a.score) };
    setSettings(nextSettings); setRoom(nextRoom); setOverlay(null);
    await Promise.all([LiveRepository.saveSettings(nextSettings), LiveRepository.saveRoom(nextRoom)]);
    await rewriteFuture(`送出了 ${gift.emoji}${gift.name}（${gift.price} 直播币）`, 'gift', userProfile.name || '我', currentTime, nextRoom);
  };

  const requestMic = async () => {
    setOverlay(null);
    const future = await rewriteFuture('申请连麦', 'mic', userProfile.name || '我');
    const accepted = (future || []).some(event => /接通|接受|可以|欢迎|上麦/.test(event.content));
    setMicActive(accepted);
    addToast(accepted ? '主播接受了连麦' : '主播暂时没有接通', accepted ? 'success' : 'info');
  };

  const sendMic = async () => {
    const text = micInput.trim(); if (!text || !micActive) return;
    setMicInput(''); setOverlay(null);
    await rewriteFuture(`麦上说：${text}`, 'mic', userProfile.name || '我');
  };

  const continueRoom = async () => {
    if (!room) return;
    setCurrentTime(room.duration);
    await rewriteFuture('请求主播继续直播', 'system', userProfile.name || '我', room.duration);
  };

  const regenerate = async () => {
    if (!room) return;
    await rewriteFuture('从此刻重新生成直播未来', 'system');
  };

  const startMyLive = async () => {
    const now = Date.now();
    const mine: LiveRoom = {
      id: liveId('my_live'), kind: 'mine', streamerName: settings.profileName || userProfile.name || '我',
      streamerAvatar: settings.profileAvatar || userProfile.avatar, title: newTitle.trim() || '今晚随便聊聊',
      category: '我的直播', coverText: '正在直播', viewerCount: Math.max(20, characters.length * 12),
      status: 'live', rank: [], currentTime: 0, duration: 3600, createdAt: now, updatedAt: now,
    };
    const welcome: LiveEvent[] = [
      { id: liveId('event'), roomId: mine.id, time: 0, type: 'system', content: '直播开始了', origin: 'system', createdAt: now },
      { id: liveId('event'), roomId: mine.id, time: 1, type: 'danmu', user: '新来的观众', content: '来啦来啦！', origin: 'ai', createdAt: now + 1 },
    ];
    const session: LiveSession = { id: `session_${mine.id}`, roomId: mine.id, mode: 'host', title: mine.title, status: 'paused', currentTime: 0, createdAt: now, updatedAt: now };
    await Promise.all([persistTimeline(mine, welcome), LiveRepository.saveSession(session)]);
    setSessions(previous => [session, ...previous]); setCurrentTime(0); setPlaying(true); setOverlay(null);
  };

  const advanceMyLive = async () => {
    if (!room || room.kind !== 'mine') return;
    const action = hostInput.trim(); if (!action) return;
    setHostInput(''); setBusy(true); setPlaying(false);
    try {
      const hostEvent: LiveEvent = { id: liveId('event'), roomId: room.id, time: currentTime, type: 'visual', user: room.streamerName, content: action, origin: 'user', createdAt: Date.now() };
      const audience = settings.followingCharacterIds.length
        ? characters.filter(char => settings.followingCharacterIds.includes(char.id))
        : characters.filter(char => char.id === activeCharacterId).slice(0, 1);
      const reactions = await generateMyLiveReactions({ runtime, room, characters: audience, action, currentTime, history: [...events, hostEvent] });
      const nextEvents = [...events.filter(e => e.time <= currentTime), hostEvent, ...reactions].sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
      const giftEvents = reactions.filter(event => event.type === 'gift');
      const rank = [...room.rank];
      giftEvents.forEach(event => {
        const name = event.user || '神秘观众'; const existing = rank.find(item => item.name === name);
        if (existing) existing.score += 88; else rank.push({ id: liveId('rank'), name, score: 88 });
      });
      const nextRoom = { ...room, rank: rank.sort((a, b) => b.score - a.score), viewerCount: room.viewerCount + Math.floor(Math.random() * 20), duration: Math.max(room.duration, ...nextEvents.map(e => e.time + 1)) };
      await persistTimeline(nextRoom, nextEvents); setPlaying(true);
    } catch (err: any) { setError(err?.message || '观众反应生成失败'); }
    finally { setBusy(false); }
  };

  const saveSettings = async () => {
    await LiveRepository.saveSettings(settings);
    setOverlay(null); addToast('直播设置已保存', 'success');
  };

  if (room) {
    const atSecond = eventMap.get(currentTime) || [];
    return (
      <div className={shell}>
        <header className="shrink-0 px-3 pb-2 bg-black/40 border-b border-white/10" style={{ paddingTop: 'calc(var(--safe-top) + 6px)' }}>
          <div className="flex items-center gap-2">
            <button onClick={leaveRoom} className="p-2 rounded-full bg-white/10"><ArrowLeft size={20} /></button>
            <img src={room.streamerAvatar || 'https://api.dicebear.com/7.x/initials/svg?seed=live'} className="w-9 h-9 rounded-full object-cover bg-white/10" />
            <div className="min-w-0 flex-1"><div className="font-bold text-sm truncate">{room.streamerName}</div><div className="text-[10px] text-white/55 flex items-center gap-1"><UsersThree /> {viewerText(room.viewerCount)} · {room.category}</div></div>
            <button onClick={() => setOverlay('rank')} className="p-2 rounded-full bg-white/10"><Ranking size={19} /></button>
            <button onClick={() => setOverlay('settings')} className="p-2 rounded-full bg-white/10"><GearSix size={19} /></button>
          </div>
        </header>

        <main className="flex-1 min-h-0 relative overflow-hidden bg-gradient-to-b from-[#211b31] via-[#12121d] to-[#09090f]">
          <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_50%_20%,#ff4d6d55,transparent_45%)]" />
          <div className="relative h-full overflow-y-auto px-4 py-4 pb-32">
            <div className="text-center mb-4"><div className="inline-flex px-2 py-1 rounded-full text-[10px] bg-red-500/20 text-red-300 border border-red-400/20">LIVE · {currentTime}s / {room.duration}s · {settings.speed}×</div><h2 className="mt-2 font-bold">{room.title}</h2></div>
            <div className={`${panel} p-4 min-h-44 space-y-3`}>
              {visible.visuals.length ? visible.visuals.map(event => <div key={event.id} className="animate-[fadeIn_.25s_ease] text-sm leading-relaxed"><span className="text-pink-300 text-[10px] mr-2">{event.time}s</span>{event.type === 'mic' && <Microphone className="inline mr-1 text-cyan-300" />}{event.content}</div>) : <div className="text-white/40 text-sm text-center py-12">直播画面准备中…</div>}
            </div>
            <div className="mt-3 space-y-1.5">
              {visible.danmu.slice(-12).map(event => <div key={event.id} className="text-xs drop-shadow"><span className={event.type === 'gift' ? 'text-yellow-300 font-bold' : event.origin === 'user' ? 'text-pink-300 font-bold' : 'text-cyan-300'}>{event.user || (event.type === 'gift' ? '礼物' : '观众')}：</span><span className="text-white/90">{event.content}</span></div>)}
            </div>
            {!!atSecond.length && <div className="sr-only">本秒 {atSecond.length} 个事件</div>}
          </div>
        </main>

        <footer className="shrink-0 bg-[#111119]/95 border-t border-white/10 px-3 pt-2" style={{ paddingBottom: 'calc(var(--safe-bottom) + 8px)' }}>
          {room.kind === 'mine' ? (
            <div className="flex gap-2"><input value={hostInput} onChange={e => setHostInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && advanceMyLive()} placeholder="说句话或描述你的动作…" className="flex-1 min-w-0 bg-white/10 rounded-full px-4 text-sm outline-none focus:ring-1 focus:ring-pink-400" /><button disabled={busy} onClick={advanceMyLive} className="px-4 py-2 rounded-full bg-pink-500 font-bold text-sm">继续</button></div>
          ) : (
            <div className="flex gap-2"><input value={danmuInput} onChange={e => setDanmuInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendDanmu()} placeholder="发送弹幕…" className="flex-1 min-w-0 bg-white/10 rounded-full px-4 text-sm outline-none focus:ring-1 focus:ring-pink-400" /><button disabled={busy} onClick={sendDanmu} className="px-4 py-2 rounded-full bg-pink-500 font-bold text-sm">发送</button></div>
          )}
          <div className="flex items-center justify-around pt-2 text-white/75">
            <button onClick={() => { setPlaying(false); setCurrentTime(0); }} className="p-2"><Repeat size={20} /></button>
            <button onClick={() => setPlaying(value => !value)} className="p-2.5 rounded-full bg-white text-black">{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button>
            {room.kind !== 'mine' && <><button onClick={() => setOverlay('gift')} className="p-2"><Gift size={21} /></button><button onClick={() => setOverlay('mic')} className={`p-2 ${micActive ? 'text-cyan-300' : ''}`}><Microphone size={21} /></button><button disabled={busy} onClick={continueRoom} className="p-2"><CaretRight size={21} /></button><button disabled={busy} onClick={regenerate} className="p-2"><ArrowClockwise size={21} /></button></>}
          </div>
        </footer>
        {busy && <div className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center"><div className="text-center"><Broadcast size={34} className="animate-pulse mx-auto text-pink-400" /><div className="mt-2 text-sm">正在生成直播未来…</div></div></div>}
        {error && <div className="absolute top-24 left-4 right-4 z-50 bg-red-950/95 border border-red-400/30 p-3 rounded-xl text-sm flex gap-2"><span className="flex-1">{error}</span><button onClick={() => setError('')}><X /></button></div>}
        {overlay && <OverlayPanel overlay={overlay} close={() => setOverlay(null)} room={room} settings={settings} setSettings={setSettings} characters={characters} micActive={micActive} micInput={micInput} setMicInput={setMicInput} requestMic={requestMic} sendMic={sendMic} sendGift={sendGift} saveSettings={saveSettings} />}
      </div>
    );
  }

  const tabRooms = rooms.filter(item => item.kind === tab);
  return (
    <div className={shell}>
      <header className="shrink-0 px-4 pb-3 bg-[#111119]/95 border-b border-white/10" style={{ paddingTop: 'calc(var(--safe-top) + 8px)' }}>
        <div className="flex items-center"><button onClick={closeApp} className="p-2 -ml-2"><ArrowLeft size={22} /></button><div className="flex-1 text-center font-black tracking-widest"><Broadcast className="inline mr-2 text-pink-400" weight="fill" />直播</div><button onClick={() => setOverlay('settings')} className="p-2"><GearSix size={21} /></button></div>
        <div className="grid grid-cols-3 bg-white/5 rounded-xl p-1 mt-2 text-sm">{(['recommend', 'following', 'mine'] as HomeTab[]).map(item => <button key={item} onClick={() => setTab(item)} className={`py-2 rounded-lg ${tab === item ? 'bg-pink-500 text-white font-bold' : 'text-white/55'}`}>{item === 'recommend' ? '推荐' : item === 'following' ? '关注' : '我的'}</button>)}</div>
      </header>
      <main className="flex-1 overflow-y-auto px-3 py-3" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
        {tab !== 'mine' && <button disabled={busy} onClick={() => refreshList(tab)} className="w-full mb-3 py-2 rounded-xl bg-white/10 text-xs flex items-center justify-center gap-2"><ArrowClockwise className={busy ? 'animate-spin' : ''} />{busy ? '正在生成…' : tabRooms.length ? '刷新直播列表' : '生成直播列表'}</button>}
        {error && <div className="mb-3 p-3 rounded-xl bg-red-950 border border-red-400/20 text-sm">{error}</div>}
        {tab === 'mine' && <button onClick={() => setOverlay('start')} className="w-full mb-4 py-4 rounded-2xl bg-gradient-to-r from-pink-500 to-red-500 font-black flex items-center justify-center gap-2"><Sparkle weight="fill" />我要开直播</button>}
        <div className="grid grid-cols-2 gap-3">
          {tabRooms.map(item => <button key={item.id} onClick={() => enterRoom(item)} className="text-left bg-white/[0.06] border border-white/10 rounded-2xl overflow-hidden active:scale-[.98] transition-transform"><div className="aspect-[4/3] bg-gradient-to-br from-pink-500/30 via-purple-500/20 to-cyan-500/20 p-3 flex flex-col justify-between"><span className="self-start px-2 py-1 text-[9px] rounded-full bg-red-500">LIVE</span><div className="text-sm font-bold line-clamp-3">{item.coverText}</div><div className="text-[10px] text-white/65"><UsersThree className="inline" /> {viewerText(item.viewerCount)}</div></div><div className="p-2"><div className="font-bold text-xs truncate">{item.title}</div><div className="text-[10px] text-white/45 mt-1 truncate">{item.streamerName} · {item.category}</div></div></button>)}
        </div>
        {tab === 'mine' && sessions.length > 0 && <section className="mt-5"><h3 className="text-xs text-white/45 mb-2">直播历史</h3>{sessions.map(session => <div key={session.id} className={`${panel} p-3 mb-2 flex items-center`}><div className="flex-1"><div className="font-bold text-sm">{session.title}</div><div className="text-[10px] text-white/45">{new Date(session.createdAt).toLocaleString()} · 已暂停</div></div><button onClick={() => { const target = rooms.find(item => item.id === session.roomId); if (target) enterRoom(target); }} className="text-xs text-pink-300">继续</button></div>)}</section>}
        {!tabRooms.length && !busy && <div className="text-center text-white/35 text-sm py-20">{tab === 'following' ? '选择关注角色后生成角色直播' : tab === 'mine' ? '还没有直播历史' : '点击上方生成此刻的直播推荐'}</div>}
      </main>
      {overlay === 'start' && <StartPanel title={newTitle} setTitle={setNewTitle} close={() => setOverlay(null)} start={startMyLive} />}
      {overlay === 'settings' && <OverlayPanel overlay="settings" close={() => setOverlay(null)} room={null} settings={settings} setSettings={setSettings} characters={characters} micActive={false} micInput="" setMicInput={() => undefined} requestMic={() => undefined} sendMic={() => undefined} sendGift={() => undefined} saveSettings={saveSettings} />}
    </div>
  );
};

const Sheet: React.FC<{ title: string; close: () => void; children: React.ReactNode }> = ({ title, close, children }) => <div className="absolute inset-0 z-50 bg-black/60 flex items-end" onMouseDown={event => event.target === event.currentTarget && close()}><div className="w-full max-h-[78%] overflow-y-auto bg-[#191923] rounded-t-3xl border-t border-white/10 p-4" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}><div className="flex items-center mb-4"><h3 className="flex-1 font-black">{title}</h3><button onClick={close} className="p-2"><X /></button></div>{children}</div></div>;

const OverlayPanel: React.FC<any> = ({ overlay, close, room, settings, setSettings, characters, micActive, micInput, setMicInput, requestMic, sendMic, sendGift, saveSettings }) => {
  if (overlay === 'gift') return <Sheet title={`礼物 · 余额 ${settings.walletBalance}`} close={close}><div className="grid grid-cols-3 gap-2">{LIVE_GIFTS.map(gift => <button key={gift.id} onClick={() => sendGift(gift)} className={`${panel} p-3 text-center`}><div className="text-3xl">{gift.emoji}</div><div className="text-xs font-bold mt-1">{gift.name}</div><div className="text-[10px] text-yellow-300">{gift.price}</div></button>)}</div></Sheet>;
  if (overlay === 'rank') return <Sheet title="贡献榜" close={close}><div className="space-y-2">{(room?.rank || []).length ? room.rank.map((item: any, index: number) => <div key={item.id} className={`${panel} p-3 flex items-center gap-3`}><b className="w-6 text-yellow-300">#{index + 1}</b><span className="flex-1">{item.name}{item.isUser ? '（我）' : ''}</span><span className="text-pink-300">{item.score}</span></div>) : <div className="text-center text-white/35 py-10">还没人送出礼物</div>}</div></Sheet>;
  if (overlay === 'mic') return <Sheet title="连麦" close={close}>{micActive ? <div><div className="text-sm text-cyan-300 mb-3">已接通，可以在麦上说话</div><div className="flex gap-2"><input value={micInput} onChange={e => setMicInput(e.target.value)} className="flex-1 bg-white/10 rounded-xl px-3 py-2 outline-none" placeholder="你想说什么…" /><button onClick={sendMic} className="px-4 rounded-xl bg-cyan-500 font-bold">发送</button></div></div> : <button onClick={requestMic} className="w-full py-3 rounded-xl bg-cyan-500 font-bold">向主播申请连麦</button>}</Sheet>;
  if (overlay === 'settings') return <Sheet title="直播设置" close={close}><div className="space-y-4 text-sm"><label className="block">直播时长（秒）<input type="number" min={30} max={1800} value={settings.duration} onChange={e => setSettings({ ...settings, duration: Math.max(30, Number(e.target.value) || 90) })} className="mt-1 w-full bg-white/10 rounded-xl p-3" /></label><label className="block">播放速度<select value={settings.speed} onChange={e => setSettings({ ...settings, speed: Number(e.target.value) })} className="mt-1 w-full bg-[#252532] rounded-xl p-3"><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={1.5}>1.5×</option><option value={2}>2×</option><option value={3}>3×</option></select></label><label className="block">推荐直播世界观<textarea value={settings.recommendWorldview} onChange={e => setSettings({ ...settings, recommendWorldview: e.target.value })} className="mt-1 w-full bg-white/10 rounded-xl p-3" rows={2} /></label><label className="block">关注直播世界观<textarea value={settings.followingWorldview} onChange={e => setSettings({ ...settings, followingWorldview: e.target.value })} className="mt-1 w-full bg-white/10 rounded-xl p-3" rows={2} /></label><label className="block">全局直播 Prompt<textarea value={settings.globalPrompt} onChange={e => setSettings({ ...settings, globalPrompt: e.target.value })} className="mt-1 w-full bg-white/10 rounded-xl p-3" rows={3} /></label><div><div className="mb-2">关注角色</div><div className="flex flex-wrap gap-2">{characters.map((char: any) => { const selected = settings.followingCharacterIds.includes(char.id); return <button key={char.id} onClick={() => setSettings({ ...settings, followingCharacterIds: selected ? settings.followingCharacterIds.filter((id: string) => id !== char.id) : [...settings.followingCharacterIds, char.id] })} className={`px-3 py-2 rounded-full text-xs ${selected ? 'bg-pink-500' : 'bg-white/10'}`}>{char.name}</button>; })}</div></div><label className="block">我的直播名<input value={settings.profileName} onChange={e => setSettings({ ...settings, profileName: e.target.value })} className="mt-1 w-full bg-white/10 rounded-xl p-3" /></label><button onClick={saveSettings} className="w-full py-3 rounded-xl bg-pink-500 font-bold">保存设置</button></div></Sheet>;
  return null;
};

const StartPanel: React.FC<{ title: string; setTitle: (value: string) => void; close: () => void; start: () => void }> = ({ title, setTitle, close, start }) => <Sheet title="我要开直播" close={close}><label className="text-sm">直播标题<input value={title} onChange={e => setTitle(e.target.value)} className="mt-2 w-full bg-white/10 rounded-xl p-3 outline-none" /></label><p className="text-xs text-white/45 my-4">你是主播，现有 AI 角色和路人会作为观众发送弹幕、送礼并进入贡献榜。</p><button onClick={start} className="w-full py-3 rounded-xl bg-gradient-to-r from-pink-500 to-red-500 font-black">开始直播</button></Sheet>;

export default LiveApp;
