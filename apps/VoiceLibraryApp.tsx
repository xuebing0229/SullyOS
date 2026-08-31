import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    MagnifyingGlass,
    Pause,
    Play,
    Star,
    Trash,
    Waveform,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import ConfirmDialog from '../components/os/ConfirmDialog';
import {
    VOICE_LIBRARY_CHANGED_EVENT,
    getVoiceLibraryBlob,
    listVoiceLibrary,
    migrateExistingVoiceHistoryToLibrary,
    removeVoiceLibraryItem,
    setVoiceLibraryStarred,
    voiceLibrarySourceLabel,
    type VoiceLibraryItem,
    type VoiceLibrarySource,
} from '../utils/voiceLibrary';

type SourceFilter = 'all' | VoiceLibrarySource;

const sourceFilters: Array<{ value: SourceFilter; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'chat', label: '聊天' },
    { value: 'call', label: '通话' },
    { value: 'date', label: '见面' },
];

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

const providerLabel = (provider?: string) => ({
    minimax: 'MiniMax',
    fishaudio: 'Fish Audio',
    elevenlabs: 'ElevenLabs',
}[provider || ''] || provider || '');

const formatDuration = (seconds?: number) => {
    if (!Number.isFinite(seconds) || !seconds || seconds < 0) return '--:--';
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
};

const VoiceLibraryApp: React.FC = () => {
    const { closeApp, characters, addToast } = useOS();
    const [items, setItems] = useState<VoiceLibraryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [starredOnly, setStarredOnly] = useState(false);
    const [visibleLimit, setVisibleLimit] = useState(100);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [durationMap, setDurationMap] = useState<Record<string, number>>({});
    const [currentTime, setCurrentTime] = useState(0);
    const [deleteTarget, setDeleteTarget] = useState<VoiceLibraryItem | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const objectUrlRef = useRef<string | null>(null);

    const stopPlayback = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            audioRef.current.src = '';
        }
        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }
        setPlayingId(null);
        setCurrentTime(0);
    }, []);

    const refresh = useCallback(async () => {
        setItems(await listVoiceLibrary());
    }, []);

    useEffect(() => {
        let cancelled = false;
        const boot = async () => {
            try {
                const migration = await migrateExistingVoiceHistoryToLibrary(characters);
                if (cancelled) return;
                await refresh();
                if (!migration.alreadyDone && migration.imported > 0) {
                    addToast(`已把 ${migration.imported} 条旧语音收进语音库`, 'success');
                }
            } catch (error) {
                console.warn('[VoiceLibrary] migration/load failed', error);
                if (!cancelled) {
                    await refresh().catch(() => undefined);
                    addToast('语音库读取失败，请检查本机存储空间', 'error');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void boot();

        const onChanged = () => { void refresh(); };
        window.addEventListener(VOICE_LIBRARY_CHANGED_EVENT, onChanged);
        return () => {
            cancelled = true;
            window.removeEventListener(VOICE_LIBRARY_CHANGED_EVENT, onChanged);
            stopPlayback();
        };
    }, [addToast, characters, refresh, stopPlayback]);

    useEffect(() => {
        setVisibleLimit(100);
    }, [query, sourceFilter, starredOnly]);

    const filteredItems = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return items.filter(item => {
            if (sourceFilter !== 'all' && item.source !== sourceFilter) return false;
            if (starredOnly && !item.starred) return false;
            if (!needle) return true;
            return [
                item.charName,
                item.originalText,
                item.spokenText,
                item.translation,
                item.provider,
                item.voiceId,
                item.model,
            ].some(value => value?.toLowerCase().includes(needle));
        });
    }, [items, query, sourceFilter, starredOnly]);

    const visibleItems = filteredItems.slice(0, visibleLimit);

    const playVoice = async (item: VoiceLibraryItem) => {
        if (playingId === item.id) {
            stopPlayback();
            return;
        }
        stopPlayback();

        const blob = await getVoiceLibraryBlob(item.id);
        if (!blob) {
            addToast('这条语音的本地音频文件缺失', 'error');
            return;
        }

        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        const audio = audioRef.current || new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.onloadedmetadata = () => {
            if (Number.isFinite(audio.duration)) {
                setDurationMap(previous => ({ ...previous, [item.id]: audio.duration }));
            }
        };
        audio.ontimeupdate = () => setCurrentTime(audio.currentTime || 0);
        audio.onended = () => stopPlayback();
        audio.onerror = () => {
            stopPlayback();
            addToast('语音播放失败', 'error');
        };

        try {
            await audio.play();
            setPlayingId(item.id);
        } catch {
            stopPlayback();
            addToast('系统阻止了播放，请再点一次', 'info');
        }
    };

    const toggleStar = async (item: VoiceLibraryItem) => {
        try {
            await setVoiceLibraryStarred(item.id, !item.starred);
            setItems(previous => previous.map(candidate => (
                candidate.id === item.id ? { ...candidate, starred: !item.starred } : candidate
            )));
        } catch {
            addToast('收藏状态保存失败', 'error');
        }
    };

    const deleteVoice = async () => {
        if (!deleteTarget) return;
        const target = deleteTarget;
        setDeleteTarget(null);
        if (playingId === target.id) stopPlayback();
        try {
            await removeVoiceLibraryItem(target.id);
            setItems(previous => previous.filter(item => item.id !== target.id));
            addToast('语音已从语音库删除', 'success');
        } catch {
            addToast('删除失败，请检查本机存储', 'error');
        }
    };

    const seekPlaying = (value: number) => {
        const audio = audioRef.current;
        if (!audio || !playingId) return;
        audio.currentTime = value;
        setCurrentTime(value);
    };

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col text-slate-800 relative">
            <ConfirmDialog
                isOpen={!!deleteTarget}
                title="删除语音"
                message="确定从语音库永久删除这条语音吗？聊天记录不会受影响。"
                confirmText="删除"
                variant="danger"
                onConfirm={() => void deleteVoice()}
                onCancel={() => setDeleteTarget(null)}
            />

            <div className="bg-white/85 backdrop-blur-xl border-b border-slate-100 shrink-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="h-16 flex items-center px-4">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full active:bg-black/5 active:scale-90 transition-transform" aria-label="返回">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="ml-2 min-w-0">
                        <h1 className="text-lg font-semibold tracking-tight">语音库</h1>
                        <p className="text-[11px] text-slate-400">{items.length} 条本地语音</p>
                    </div>
                    <Waveform size={22} className="ml-auto text-slate-400" />
                </div>
            </div>

            <div className="shrink-0 bg-slate-50/95 px-4 pt-3 pb-3 border-b border-slate-100">
                <label className="h-10 rounded-2xl bg-white border border-slate-200 flex items-center gap-2 px-3 shadow-sm">
                    <MagnifyingGlass size={16} className="text-slate-400 shrink-0" />
                    <input
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        placeholder="搜角色、台词、音色..."
                        className="min-w-0 flex-1 bg-transparent outline-none text-sm placeholder:text-slate-400"
                    />
                </label>
                <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-0.5">
                    {sourceFilters.map(filter => (
                        <button
                            key={filter.value}
                            onClick={() => setSourceFilter(filter.value)}
                            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${sourceFilter === filter.value ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200'}`}
                        >
                            {filter.label}
                        </button>
                    ))}
                    <button
                        onClick={() => setStarredOnly(value => !value)}
                        className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border flex items-center gap-1 transition-colors ${starredOnly ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white text-slate-500 border-slate-200'}`}
                    >
                        <Star size={13} weight={starredOnly ? 'fill' : 'regular'} />
                        收藏
                    </button>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                {loading ? (
                    <div className="h-40 grid place-items-center text-sm text-slate-400">正在整理语音库…</div>
                ) : visibleItems.length === 0 ? (
                    <div className="h-64 flex flex-col items-center justify-center text-center px-8">
                        <div className="w-16 h-16 rounded-full bg-white shadow-sm border border-slate-100 grid place-items-center text-slate-300 mb-4">
                            <Waveform size={28} />
                        </div>
                        <div className="text-sm font-medium text-slate-500">{items.length ? '没有符合筛选的语音' : '语音库还是空的'}</div>
                        <p className="mt-2 text-xs leading-5 text-slate-400">
                            之后成功生成的聊天、通话和见面语音会自动保存到这里。
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {visibleItems.map(item => {
                            const active = playingId === item.id;
                            const char = characters.find(candidate => candidate.id === item.charId);
                            const secondary = item.translation || item.spokenText;
                            const showSecondary = !!secondary && secondary.trim() !== item.originalText.trim();
                            const duration = durationMap[item.id];
                            const provider = providerLabel(item.provider);
                            return (
                                <article key={item.id} className="bg-white border border-slate-100 rounded-2xl shadow-sm p-4">
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => void playVoice(item)}
                                            className={`mt-0.5 w-11 h-11 rounded-full shrink-0 grid place-items-center transition-transform active:scale-95 ${active ? 'bg-amber-500 text-white' : 'bg-slate-800 text-white'}`}
                                            aria-label={active ? '暂停' : '播放'}
                                        >
                                            {active ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" className="ml-0.5" />}
                                        </button>

                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 min-w-0">
                                                {char?.avatar ? (
                                                    <img src={char.avatar} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                                                ) : (
                                                    <span className="w-5 h-5 rounded-full bg-slate-100 text-[9px] font-bold text-slate-500 grid place-items-center shrink-0">
                                                        {(item.charName || '?').slice(0, 1)}
                                                    </span>
                                                )}
                                                <span className="text-xs font-semibold truncate">{item.charName}</span>
                                                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{voiceLibrarySourceLabel(item.source)}</span>
                                                <span className="ml-auto shrink-0 text-[10px] text-slate-400">{formatDuration(duration)}</span>
                                            </div>

                                            <p className="mt-2 text-[14px] leading-6 whitespace-pre-wrap break-words text-slate-800">
                                                {item.originalText || item.spokenText || '（无文字）'}
                                            </p>
                                            {showSecondary && (
                                                <p className="mt-1 text-xs leading-5 text-slate-500 whitespace-pre-wrap break-words">
                                                    <span className="mr-1.5 text-[10px] font-semibold text-amber-700">{item.translation ? '翻译' : '朗读'}</span>
                                                    {secondary}
                                                </p>
                                            )}

                                            {active && Number.isFinite(duration) && !!duration && (
                                                <div className="mt-3 flex items-center gap-2">
                                                    <span className="text-[10px] tabular-nums text-slate-400 w-8">{formatDuration(currentTime)}</span>
                                                    <input
                                                        type="range"
                                                        min={0}
                                                        max={duration}
                                                        step={0.1}
                                                        value={Math.min(currentTime, duration)}
                                                        onChange={event => seekPlaying(Number(event.target.value))}
                                                        className="min-w-0 flex-1 accent-slate-700"
                                                        aria-label="播放进度"
                                                    />
                                                    <span className="text-[10px] tabular-nums text-slate-400 w-8 text-right">{formatDuration(duration)}</span>
                                                </div>
                                            )}

                                            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-400">
                                                <time>{timeFormatter.format(new Date(item.savedAt))}</time>
                                                {provider && <><span>·</span><span>{provider}</span></>}
                                                {item.model && <><span>·</span><span className="truncate max-w-[130px]">{item.model}</span></>}
                                                {item.language && <><span>·</span><span>{item.language}</span></>}
                                            </div>
                                        </div>

                                        <div className="shrink-0 flex flex-col gap-1">
                                            <button
                                                onClick={() => void toggleStar(item)}
                                                className={`w-9 h-9 rounded-full grid place-items-center active:bg-amber-50 ${item.starred ? 'text-amber-500' : 'text-slate-300'}`}
                                                aria-label={item.starred ? '取消收藏' : '收藏'}
                                            >
                                                <Star size={17} weight={item.starred ? 'fill' : 'regular'} />
                                            </button>
                                            <button
                                                onClick={() => setDeleteTarget(item)}
                                                className="w-9 h-9 rounded-full grid place-items-center text-slate-300 active:bg-rose-50 active:text-rose-500"
                                                aria-label="删除"
                                            >
                                                <Trash size={17} />
                                            </button>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}

                        {visibleLimit < filteredItems.length && (
                            <button
                                onClick={() => setVisibleLimit(limit => limit + 100)}
                                className="w-full py-3 rounded-2xl bg-white border border-slate-200 text-xs font-medium text-slate-500 active:bg-slate-50"
                            >
                                再显示 100 条
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default VoiceLibraryApp;
