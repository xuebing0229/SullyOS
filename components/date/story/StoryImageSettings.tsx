import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageSquare, X } from '@phosphor-icons/react';
import { useOS } from '../../../context/OSContext';
import type { StoryTheaterEntry, StoryTheaterImageConfig } from '../../../types';
import { getBuiltinImageMcpServers, loadBuiltinImageSettings } from '../../../utils/builtinImageMcp';

interface Props { entry: StoryTheaterEntry; onChange: (entry: StoryTheaterEntry) => Promise<void> | void; }

const fallback = (entry: StoryTheaterEntry): StoryTheaterImageConfig => ({
    enabled: entry.imageGeneration?.enabled === true,
    stylePrompt: entry.imageGeneration?.stylePrompt || '',
    negativePrompt: entry.imageGeneration?.negativePrompt || '',
    width: entry.imageGeneration?.width || 1216,
    height: entry.imageGeneration?.height || 832,
    userAnchor: entry.imageGeneration?.userAnchor || '',
    characterAnchors: entry.imageGeneration?.characterAnchors || {},
});

const Toggle: React.FC<{ value: boolean; onChange: (value: boolean) => void }> = ({ value, onChange }) => <button type='button' aria-pressed={value} onClick={() => onChange(!value)} className={`relative h-7 w-12 shrink-0 rounded-full transition ${value ? 'bg-violet-600' : 'bg-slate-200'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition ${value ? 'left-6' : 'left-1'}`} /></button>;

const StoryImageSettingsButton: React.FC<Props> = ({ entry, onChange }) => {
    const { addToast, characters, userProfile } = useOS();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<StoryTheaterImageConfig>(() => fallback(entry));
    useEffect(() => { if (open) setDraft(fallback(entry)); }, [entry, open]);
    const settings = loadBuiltinImageSettings();
    const preferred = settings.preferredEngine;
    const ready = Boolean(preferred && settings.engines[preferred].enabled && getBuiltinImageMcpServers().some(server => server.enabled && (server.tools || []).length > 0));
    const actors = characters.filter(character => entry.characterIds.includes(character.id));
    const save = async () => {
        if (draft.enabled && !ready) { addToast('请先在设置里启用并选择一个内置生图引擎', 'error'); return; }
        await onChange({ ...entry, imageGeneration: draft, updatedAt: Date.now() });
        addToast(draft.enabled ? '本剧情自动配图已开启' : '本剧情自动配图已关闭', 'success');
        setOpen(false);
    };
    return <>
        <button type='button' onClick={() => setOpen(true)} className={`relative z-20 grid h-9 w-9 place-items-center rounded-full ${entry.imageGeneration?.enabled ? 'text-violet-600' : ''}`} title='剧情配图' aria-label='剧情配图'><ImageSquare size={18} weight={entry.imageGeneration?.enabled ? 'fill' : 'regular'} />{entry.imageGeneration?.enabled && <span className='absolute right-1 top-1 h-2 w-2 rounded-full border border-stone-100 bg-emerald-500' />}</button>
        {open && createPortal(<div
            className='story-theme fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/35'
            style={{ position: 'fixed', inset: 0, pointerEvents: 'auto' }}
            onClick={() => setOpen(false)}
        >
            <div className='story-safe-sheet flex max-h-[88dvh] w-full max-w-sm flex-col overflow-hidden rounded-t-[28px] bg-stone-100 shadow-2xl' onClick={event => event.stopPropagation()} role='dialog' aria-modal='true' aria-labelledby='story-image-settings-title'>
                <div className='shrink-0 px-5 pb-4 pt-5'><div className='flex items-start gap-4'><div className='min-w-0 flex-1'><div className='text-[9px] font-bold uppercase tracking-[.22em] text-violet-500'>Story illustration</div><h2 id='story-image-settings-title' className='mt-1 text-lg font-semibold'>本剧情自动配图</h2><p className='mt-1 text-[10px] leading-5 text-slate-500'>直接复用设置里当前选中的 GPT Image 或 NovelAI。</p></div><button type='button' onClick={() => setOpen(false)} className='grid h-10 w-10 shrink-0 place-items-center rounded-full border border-slate-200 bg-white'><X size={17} /></button></div></div>
                <div className='min-h-0 flex-1 overflow-y-auto border-y border-slate-200 px-5'>
                    <div className='py-4'><div className='flex items-center justify-between gap-4'><div><div className='text-sm font-semibold'>每轮自动配一张图</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>正文先显示；配图失败不会影响剧情。</p></div><Toggle value={draft.enabled} onChange={enabled => setDraft(current => ({ ...current, enabled }))} /></div></div>
                    {!ready && <div className='mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-700'>内置生图引擎尚未配置完成，开启前请先去设置。</div>}
                    <label className='block border-t border-slate-200 py-4'><span className='text-[10px] font-bold text-slate-500'>画风补充</span><textarea value={draft.stylePrompt} onChange={event => setDraft(current => ({ ...current, stylePrompt: event.target.value }))} placeholder='例如：电影感、柔和逆光、细腻背景' className='mt-1.5 min-h-24 w-full resize-y rounded-2xl border border-slate-200 bg-white p-3 text-xs leading-5 outline-none' /></label>
                    <div className='border-t border-slate-200 py-4'><div className='text-[10px] font-bold text-slate-500'>人物外观锚点</div><p className='mt-1 text-[9px] leading-4 text-slate-400'>填写稳定外貌特征，减少每轮换脸或换发色。</p><label className='mt-3 block'><span className='text-[10px] font-bold text-slate-500'>{userProfile.name || '你'} · 当前身份</span><textarea value={draft.userAnchor} onChange={event => setDraft(current => ({ ...current, userAnchor: event.target.value }))} placeholder='发型、发色、瞳色、衣着等' className='mt-1.5 min-h-20 w-full resize-y rounded-2xl border border-slate-200 bg-white p-3 text-xs leading-5 outline-none' /></label><div className='mt-3 space-y-3'>{actors.map(actor => <label key={actor.id} className='block'><span className='text-[10px] font-bold text-slate-500'>{actor.name}</span><textarea value={draft.characterAnchors[actor.id] || ''} onChange={event => setDraft(current => ({ ...current, characterAnchors: { ...current.characterAnchors, [actor.id]: event.target.value } }))} placeholder='固定外貌与常用服装' className='mt-1.5 min-h-20 w-full resize-y rounded-2xl border border-slate-200 bg-white p-3 text-xs leading-5 outline-none' /></label>)}</div></div>
                    <label className='block border-t border-slate-200 py-4'><span className='text-[10px] font-bold text-slate-500'>避免内容 / 负面提示</span><textarea value={draft.negativePrompt} onChange={event => setDraft(current => ({ ...current, negativePrompt: event.target.value }))} placeholder='例如：文字、水印、额外手指' className='mt-1.5 min-h-20 w-full resize-y rounded-2xl border border-slate-200 bg-white p-3 text-xs leading-5 outline-none' /></label>
                    <label className='block border-t border-slate-200 py-4'><span className='text-[10px] font-bold text-slate-500'>画幅</span><select value={`${draft.width}x${draft.height}`} onChange={event => { const [width, height] = event.target.value.split('x').map(Number); setDraft(current => ({ ...current, width, height })); }} className='mt-1.5 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs outline-none'><option value='1216x832'>横图 1216×832</option><option value='1344x768'>宽横图 1344×768</option><option value='1024x1024'>方图 1024×1024</option><option value='832x1216'>竖图 832×1216</option><option value='768x1344'>长竖图 768×1344</option></select></label>
                </div>
                <div className='shrink-0 px-5 py-4'><button type='button' onClick={() => void save()} className='h-12 w-full rounded-2xl bg-slate-900 text-xs font-bold text-white'>保存配图设置</button></div>
            </div>
        </div>, document.body)}
    </>;
};

export default StoryImageSettingsButton;
