import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageSquare, X } from '@phosphor-icons/react';
import { useOS } from '../../../context/OSContext';
import type { StoryTheaterEntry, StoryTheaterImageConfig } from '../../../types';
import { getBuiltinImageMcpServers, loadBuiltinImageSettings } from '../../../utils/builtinImageMcp';
import { getApiPresetModelEntries } from '../../../utils/apiPresetModels';

interface Props {
    entry: StoryTheaterEntry;
    onChange: (entry: StoryTheaterEntry) => Promise<void> | void;
    triggerLabel?: string;
    triggerClassName?: string;
}

const fallback = (entry: StoryTheaterEntry): StoryTheaterImageConfig => ({
    enabled: entry.imageGeneration?.enabled === true,
    plannerApiPresetId: entry.imageGeneration?.plannerApiPresetId || '',
    plannerModel: entry.imageGeneration?.plannerModel || '',
    stylePrompt: entry.imageGeneration?.stylePrompt || '',
    negativePrompt: entry.imageGeneration?.negativePrompt || '',
    width: entry.imageGeneration?.width || 1216,
    height: entry.imageGeneration?.height || 832,
    userAnchor: entry.imageGeneration?.userAnchor || '',
    characterAnchors: entry.imageGeneration?.characterAnchors || {},
});

const STORY_IMAGE_TEXT_PRESETS_KEY = 'sullyos_story_image_text_presets_v1';

type StoryImageTextPreset = {
    id: string;
    name: string;
    stylePrompt: string;
    negativePrompt: string;
    userAnchor: string;
    characterAnchors: Record<string, string>;
    characterAnchorNames: Record<string, string>;
    updatedAt: number;
};

const loadImageTextPresets = (): StoryImageTextPreset[] => {
    try {
        const raw = JSON.parse(localStorage.getItem(STORY_IMAGE_TEXT_PRESETS_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(item => item && typeof item === 'object' && typeof item.name === 'string')
            .map(item => ({
                id: typeof item.id === 'string' && item.id ? item.id : `story_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: item.name.trim(),
                stylePrompt: typeof item.stylePrompt === 'string' ? item.stylePrompt : '',
                negativePrompt: typeof item.negativePrompt === 'string' ? item.negativePrompt : '',
                userAnchor: typeof item.userAnchor === 'string' ? item.userAnchor : '',
                characterAnchors: item.characterAnchors && typeof item.characterAnchors === 'object' ? item.characterAnchors : {},
                characterAnchorNames: item.characterAnchorNames && typeof item.characterAnchorNames === 'object' ? item.characterAnchorNames : {},
                updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
            }))
            .filter(item => item.name.length > 0)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
};

const persistImageTextPresets = (presets: StoryImageTextPreset[]) => {
    localStorage.setItem(STORY_IMAGE_TEXT_PRESETS_KEY, JSON.stringify(presets));
};

const Toggle: React.FC<{ value: boolean; onChange: (value: boolean) => void }> = ({ value, onChange }) => <button type='button' aria-pressed={value} onClick={() => onChange(!value)} className={`relative h-7 w-12 shrink-0 rounded-full transition ${value ? 'bg-violet-600' : 'bg-slate-200'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition ${value ? 'left-6' : 'left-1'}`} /></button>;

const StoryImageSettingsButton: React.FC<Props> = ({ entry, onChange, triggerLabel, triggerClassName }) => {
    const { addToast, characters, userProfile, registerBackHandler, apiPresets, apiConfig } = useOS();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<StoryTheaterImageConfig>(() => fallback(entry));
    const [textPresets, setTextPresets] = useState<StoryImageTextPreset[]>(() => loadImageTextPresets());
    const [presetName, setPresetName] = useState('');
    useEffect(() => { if (open) setDraft(fallback(entry)); }, [entry, open]);
    useEffect(() => {
        if (!open) return;
        setTextPresets(loadImageTextPresets());
        setPresetName('');
    }, [open]);
    useEffect(() => {
        if (!open) return;
        return registerBackHandler(() => {
            setOpen(false);
            return true;
        });
    }, [open, registerBackHandler]);
    const settings = loadBuiltinImageSettings();
    const preferred = settings.preferredEngine;
    const ready = Boolean(preferred && settings.engines[preferred].enabled && getBuiltinImageMcpServers().some(server => server.enabled && (server.tools || []).length > 0));
    const actors = characters.filter(character => entry.characterIds.includes(character.id));
    const selectedPlannerPreset = apiPresets.find(preset => preset.id === draft.plannerApiPresetId);
    const selectedPlannerModels = selectedPlannerPreset ? getApiPresetModelEntries(selectedPlannerPreset) : [];
    const plannerDisplayModel = selectedPlannerPreset
        ? (draft.plannerModel || selectedPlannerPreset.config.model)
        : apiConfig.model;

    const applyTextPreset = (preset: StoryImageTextPreset) => {
        const savedAnchorValues = Object.values(preset.characterAnchors || {}).filter(value => typeof value === 'string' && value.trim().length > 0);
        const singleSavedAnchor = savedAnchorValues.length === 1 ? savedAnchorValues[0] : '';
        const nextActorAnchors: Record<string, string> = {};
        for (const actor of actors) {
            nextActorAnchors[actor.id] = preset.characterAnchors?.[actor.id]
                ?? preset.characterAnchorNames?.[actor.name]
                ?? (actors.length === 1 ? singleSavedAnchor : '')
                ?? '';
        }
        setDraft(current => ({
            ...current,
            stylePrompt: preset.stylePrompt,
            negativePrompt: preset.negativePrompt,
            userAnchor: preset.userAnchor,
            characterAnchors: { ...current.characterAnchors, ...nextActorAnchors },
        }));
        addToast(`已应用配图预设「${preset.name}」`, 'success');
    };

    const saveTextPreset = () => {
        const name = presetName.trim();
        if (!name) { addToast('先给配图预设起个名字', 'error'); return; }
        const characterAnchorNames = actors.reduce<Record<string, string>>((result, actor) => {
            result[actor.name] = draft.characterAnchors[actor.id] || '';
            return result;
        }, {});
        const now = Date.now();
        const existing = textPresets.find(item => item.name === name);
        const nextPreset: StoryImageTextPreset = {
            id: existing?.id || `story_img_${now}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            stylePrompt: draft.stylePrompt || '',
            negativePrompt: draft.negativePrompt || '',
            userAnchor: draft.userAnchor || '',
            characterAnchors: actors.reduce<Record<string, string>>((result, actor) => {
                result[actor.id] = draft.characterAnchors[actor.id] || '';
                return result;
            }, {}),
            characterAnchorNames,
            updatedAt: now,
        };
        const next = [nextPreset, ...textPresets.filter(item => item.id !== nextPreset.id)].sort((a, b) => b.updatedAt - a.updatedAt);
        try {
            persistImageTextPresets(next);
            setTextPresets(next);
            setPresetName('');
            addToast(existing ? `已覆盖配图预设「${name}」` : `已保存配图预设「${name}」`, 'success');
        } catch {
            addToast('配图预设保存失败', 'error');
        }
    };

    const renameTextPreset = (preset: StoryImageTextPreset) => {
        const requested = window.prompt('新的预设名称', preset.name);
        if (requested === null) return;
        const name = requested.trim();
        if (!name) { addToast('预设名称不能为空', 'error'); return; }
        if (textPresets.some(item => item.id !== preset.id && item.name === name)) { addToast('已经有同名配图预设', 'error'); return; }
        const next = textPresets.map(item => item.id === preset.id ? { ...item, name, updatedAt: Date.now() } : item).sort((a, b) => b.updatedAt - a.updatedAt);
        try {
            persistImageTextPresets(next);
            setTextPresets(next);
            addToast(`已重命名为「${name}」`, 'success');
        } catch {
            addToast('配图预设重命名失败', 'error');
        }
    };

    const deleteTextPreset = (preset: StoryImageTextPreset) => {
        if (!window.confirm(`删除配图预设「${preset.name}」？`)) return;
        const next = textPresets.filter(item => item.id !== preset.id);
        try {
            persistImageTextPresets(next);
            setTextPresets(next);
            addToast(`已删除配图预设「${preset.name}」`, 'success');
        } catch {
            addToast('配图预设删除失败', 'error');
        }
    };

    const save = async () => {
        if (draft.enabled && !ready) { addToast('请先在设置里启用并选择一个内置生图引擎', 'error'); return; }
        await onChange({ ...entry, imageGeneration: draft, updatedAt: Date.now() });
        addToast(draft.enabled ? '本剧情自动配图已开启' : '本剧情自动配图已关闭', 'success');
        setOpen(false);
    };
    return <>
        <button
            type='button'
            onClick={() => setOpen(true)}
            className={triggerClassName || `relative z-20 grid h-9 w-9 place-items-center rounded-full ${entry.imageGeneration?.enabled ? 'text-violet-600' : ''}`}
            title='剧情配图'
            aria-label='剧情配图'
        >
            <ImageSquare size={18} weight={entry.imageGeneration?.enabled ? 'fill' : 'regular'} />
            {triggerLabel && <span className='min-w-0 flex-1 text-left'>{triggerLabel}</span>}
            {entry.imageGeneration?.enabled && <span className={triggerLabel ? 'ml-auto h-2 w-2 shrink-0 rounded-full bg-emerald-500' : 'absolute right-1 top-1 h-2 w-2 rounded-full border border-stone-100 bg-emerald-500'} />}
        </button>
        {open && createPortal(<div
            className='story-theme fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/35'
            style={{ position: 'fixed', inset: 0, pointerEvents: 'auto' }}
            onClick={() => setOpen(false)}
        >
            <div className='story-safe-sheet flex max-h-[88dvh] w-full max-w-sm flex-col overflow-hidden rounded-t-[28px] bg-stone-100 shadow-2xl' onClick={event => event.stopPropagation()} role='dialog' aria-modal='true' aria-labelledby='story-image-settings-title'>
                <div className='shrink-0 px-5 pb-4 pt-5'><div className='flex items-start gap-4'><div className='min-w-0 flex-1'><div className='text-[9px] font-bold uppercase tracking-[.22em] text-violet-500'>Story illustration</div><h2 id='story-image-settings-title' className='mt-1 text-lg font-semibold'>本剧情自动配图</h2><p className='mt-1 text-[10px] leading-5 text-slate-500'>规划模型可以单独选快速模型；真正出图仍复用当前 GPT Image / NovelAI。</p></div><button type='button' onClick={() => setOpen(false)} className='grid h-10 w-10 shrink-0 place-items-center rounded-full border border-slate-200 bg-white'><X size={17} /></button></div></div>
                <div className='min-h-0 flex-1 overflow-y-auto border-y border-slate-200 px-5'>
                    <div className='py-4'><div className='flex items-center justify-between gap-4'><div><div className='text-sm font-semibold'>每轮自动配一张图</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>正文先显示；配图失败不会影响剧情。</p></div><Toggle value={draft.enabled} onChange={enabled => setDraft(current => ({ ...current, enabled }))} /></div></div>
                    {!ready && <div className='mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-700'>内置生图引擎尚未配置完成，开启前请先去设置。</div>}
                    <div className='border-t border-slate-200 py-4'>
                        <div className='flex items-start justify-between gap-3'>
                            <div><div className='text-[10px] font-bold text-slate-500'>配图内容预设</div><p className='mt-1 text-[9px] leading-4 text-slate-400'>跨文游存档保存。只保存画风、你的外观、角色外观和负面提示；点预设名即可一键填入，不会改规划模型、画幅或开关。</p></div>
                        </div>
                        <div className='mt-2 flex gap-2'>
                            <input value={presetName} onChange={event => setPresetName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveTextPreset(); } }} placeholder='给当前四项起个预设名' className='min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-xs outline-none' />
                            <button type='button' onClick={saveTextPreset} className='shrink-0 rounded-2xl bg-violet-600 px-3 text-[10px] font-bold text-white'>保存当前</button>
                        </div>
                        {textPresets.length > 0 ? <div className='mt-3 space-y-2'>
                            {textPresets.map(preset => <div key={preset.id} className='flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2'>
                                <button type='button' onClick={() => applyTextPreset(preset)} className='min-w-0 flex-1 rounded-xl bg-violet-50 px-3 py-2 text-left text-[11px] font-bold text-violet-700'><span className='block truncate'>{preset.name}</span><span className='mt-0.5 block text-[8px] font-normal text-violet-500'>点这里一键填入</span></button>
                                <button type='button' onClick={() => renameTextPreset(preset)} className='shrink-0 rounded-xl px-2 py-2 text-[9px] font-bold text-slate-500'>改名</button>
                                <button type='button' onClick={() => deleteTextPreset(preset)} className='shrink-0 rounded-xl px-2 py-2 text-[9px] font-bold text-rose-500'>删除</button>
                            </div>)}
                        </div> : <div className='mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[9px] leading-4 text-slate-400'>还没有预设。把下面四类内容填好后，在这里保存一次即可。</div>}
                    </div>
                    <div className='border-t border-slate-200 py-4'>
                        <div className='text-[10px] font-bold text-slate-500'>配图规划模型</div>
                        <p className='mt-1 text-[9px] leading-4 text-slate-400'>这是单独一次很轻的文本调用，只负责看最新剧情、选生图工具/参考图和构图。真正出图仍走下面的 GPT Image / NovelAI，不会把这个模型当生图模型。</p>
                        <select
                            value={draft.plannerApiPresetId || ''}
                            onChange={event => {
                                const presetId = event.target.value;
                                const preset = apiPresets.find(item => item.id === presetId);
                                setDraft(current => ({
                                    ...current,
                                    plannerApiPresetId: presetId || undefined,
                                    plannerModel: preset ? preset.config.model : undefined,
                                }));
                            }}
                            className='mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs outline-none'
                        >
                            <option value=''>跟随当前聊天 API（{apiConfig.model || '未配置模型'}）</option>
                            {apiPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                        </select>
                        {selectedPlannerPreset && <select
                            value={plannerDisplayModel}
                            onChange={event => setDraft(current => ({ ...current, plannerModel: event.target.value }))}
                            className='mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs outline-none'
                        >
                            {selectedPlannerModels.length > 0
                                ? selectedPlannerModels.map(item => <option key={item.model} value={item.model}>{item.model}</option>)
                                : <option value={selectedPlannerPreset.config.model}>{selectedPlannerPreset.config.model}</option>}
                        </select>}
                        <div className='mt-2 rounded-xl bg-violet-50 px-3 py-2 text-[9px] leading-4 text-violet-700'>
                            当前规划器：{selectedPlannerPreset ? `${selectedPlannerPreset.name} · ${plannerDisplayModel}` : `跟随当前聊天 API · ${plannerDisplayModel || '未配置'}`}
                        </div>
                    </div>
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
