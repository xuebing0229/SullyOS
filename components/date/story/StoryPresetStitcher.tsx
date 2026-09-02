import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, FloppyDisk, Plus, Trash } from '@phosphor-icons/react';
import type { StoryTheaterPreset, StoryTheaterPresetPrompt } from '../../../types';
import {
    getStoryPresetPromptGroups,
    isImportedStoryPresetGroupMarker,
    isProtectedStoryPrompt,
    isStoryPresetSectionMarker,
    makeStoryTheaterId,
} from '../../../utils/storyTheater';

interface Props {
    presets: StoryTheaterPreset[];
    onBack: () => void;
    onSave: (preset: StoryTheaterPreset) => Promise<void> | void;
}

const cloneBasePreset = (preset: StoryTheaterPreset, now = Date.now()): StoryTheaterPreset => {
    const name = `${preset.name} · 缝合`;
    return {
        ...preset,
        id: makeStoryTheaterId(),
        name,
        sourceFileName: undefined,
        builtIn: false,
        createdAt: now,
        updatedAt: now,
        document: {
            ...preset.document,
            name,
            generation: { ...preset.document.generation },
            prompts: preset.document.prompts.map(prompt => ({ ...prompt })),
        },
    };
};

const isStructuralPrompt = (prompt: StoryTheaterPresetPrompt): boolean => (
    isStoryPresetSectionMarker(prompt) || isImportedStoryPresetGroupMarker(prompt)
);

const canStitchPrompt = (prompt: StoryTheaterPresetPrompt): boolean => (
    !isStructuralPrompt(prompt) && !isProtectedStoryPrompt(prompt)
);

const groupVisiblePrompts = (
    preset: StoryTheaterPreset,
    promptIds: string[],
): StoryTheaterPresetPrompt[] => {
    const ids = new Set(promptIds);
    return preset.document.prompts.filter(prompt => ids.has(prompt.id) && !isStructuralPrompt(prompt));
};

const groupStitchablePrompts = (
    preset: StoryTheaterPreset,
    promptIds: string[],
): StoryTheaterPresetPrompt[] => groupVisiblePrompts(preset, promptIds).filter(canStitchPrompt);

const StoryPresetStitcher: React.FC<Props> = ({ presets, onBack, onSave }) => {
    const firstPreset = presets[0] || null;
    const [baseId, setBaseId] = useState(firstPreset?.id || '');
    const [sourceId, setSourceId] = useState(() => presets.find(item => item.id !== firstPreset?.id)?.id || firstPreset?.id || '');
    const [draft, setDraft] = useState<StoryTheaterPreset | null>(() => firstPreset ? cloneBasePreset(firstPreset) : null);
    const [expandedSourceGroup, setExpandedSourceGroup] = useState<string | null>(null);
    const [expandedResultGroup, setExpandedResultGroup] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [saving, setSaving] = useState(false);

    const basePreset = useMemo(() => presets.find(item => item.id === baseId) || firstPreset, [baseId, firstPreset, presets]);
    const sourcePreset = useMemo(
        () => presets.find(item => item.id === sourceId) || presets.find(item => item.id !== baseId) || basePreset || null,
        [baseId, basePreset, presets, sourceId],
    );
    const sourceGroups = useMemo(
        () => sourcePreset ? getStoryPresetPromptGroups(sourcePreset.document) : [],
        [sourcePreset],
    );
    const resultGroups = useMemo(
        () => draft ? getStoryPresetPromptGroups(draft.document) : [],
        [draft],
    );
    const resultPromptIds = useMemo(
        () => new Set(draft?.document.prompts.map(prompt => prompt.id) || []),
        [draft],
    );

    const resetFromBase = (nextBaseId: string) => {
        const nextBase = presets.find(item => item.id === nextBaseId);
        if (!nextBase) return;
        setBaseId(nextBase.id);
        setDraft(cloneBasePreset(nextBase));
        setExpandedResultGroup(null);
        setExpandedSourceGroup(null);
        const nextSource = presets.find(item => item.id !== nextBase.id);
        setSourceId(current => current !== nextBase.id && presets.some(item => item.id === current) ? current : (nextSource?.id || nextBase.id));
        setNotice(`已用「${nextBase.name}」重新建立成品；生成参数和系统连接骨架都跟随底稿。`);
    };

    const patchPrompts = (prompts: StoryTheaterPresetPrompt[]) => {
        setDraft(current => current ? {
            ...current,
            updatedAt: Date.now(),
            document: { ...current.document, prompts },
        } : current);
    };

    const appendPrompt = (source: StoryTheaterPreset, prompt: StoryTheaterPresetPrompt) => {
        if (!draft || !canStitchPrompt(prompt)) return;
        const existing = draft.document.prompts.find(item => item.id === prompt.id);
        if (existing) {
            setNotice(`「${prompt.name}」的 ID 已经存在；请点“替换”决定是否用素材版本覆盖。`);
            return;
        }

        const markerName = `━━ ${source.name} · 单条缝合 ━━`;
        const prompts = [...draft.document.prompts];
        let markerIndex = prompts.findIndex(item => (
            isImportedStoryPresetGroupMarker(item) && item.name === markerName
        ));
        if (markerIndex < 0) {
            prompts.push({
                id: makeStoryTheaterId(),
                name: markerName,
                enabled: false,
                role: 'system',
                content: '',
            });
            markerIndex = prompts.length - 1;
        }

        let insertAt = markerIndex + 1;
        while (
            insertAt < prompts.length
            && !isStoryPresetSectionMarker(prompts[insertAt])
            && !isImportedStoryPresetGroupMarker(prompts[insertAt])
        ) insertAt += 1;
        prompts.splice(insertAt, 0, { ...prompt });
        patchPrompts(prompts);
        setNotice(`已缝入「${prompt.name}」。`);
    };

    const replacePrompt = (prompt: StoryTheaterPresetPrompt) => {
        if (!draft || !canStitchPrompt(prompt)) return;
        const index = draft.document.prompts.findIndex(item => item.id === prompt.id);
        if (index < 0) return appendPrompt(sourcePreset || draft, prompt);
        if (isProtectedStoryPrompt(draft.document.prompts[index])) {
            setNotice('系统连接骨架不能被素材预设覆盖。');
            return;
        }
        const prompts = [...draft.document.prompts];
        prompts[index] = { ...prompt };
        patchPrompts(prompts);
        setNotice(`已用素材版本替换「${prompt.name}」。`);
    };

    const appendGroup = (source: StoryTheaterPreset, groupKey: string) => {
        if (!draft) return;
        const group = sourceGroups.find(item => item.key === groupKey);
        if (!group) return;
        const candidates = groupStitchablePrompts(source, group.promptIds);
        if (candidates.length === 0) {
            setNotice(group.protected ? '这一组只有系统连接位，底稿已经自带，不需要重复缝。' : '这一组没有可缝入的普通提示词。');
            return;
        }

        const existingIds = new Set(draft.document.prompts.map(prompt => prompt.id));
        const additions = candidates.filter(prompt => !existingIds.has(prompt.id));
        const skipped = candidates.length - additions.length;
        if (additions.length === 0) {
            setNotice(`「${group.label}」里的条目都已经存在；需要覆盖时展开后逐条点“替换”。`);
            return;
        }

        const marker: StoryTheaterPresetPrompt = {
            id: makeStoryTheaterId(),
            name: `━━ ${source.name} · ${group.label} ━━`,
            enabled: false,
            role: 'system',
            content: '',
        };
        patchPrompts([
            ...draft.document.prompts,
            marker,
            ...additions.map(prompt => ({ ...prompt })),
        ]);
        setNotice(`已缝入「${group.label}」${skipped ? `，${skipped} 条同 ID 内容已跳过` : ''}。`);
    };

    const toggleResultPrompt = (id: string) => {
        if (!draft) return;
        const prompt = draft.document.prompts.find(item => item.id === id);
        if (!prompt || isProtectedStoryPrompt(prompt) || isStructuralPrompt(prompt)) return;
        patchPrompts(draft.document.prompts.map(item => item.id === id ? { ...item, enabled: !item.enabled } : item));
    };

    const removeResultPrompt = (id: string) => {
        if (!draft) return;
        const prompt = draft.document.prompts.find(item => item.id === id);
        if (!prompt || isProtectedStoryPrompt(prompt) || isStructuralPrompt(prompt)) return;
        patchPrompts(draft.document.prompts.filter(item => item.id !== id));
    };

    const moveResultPrompt = (groupKey: string, id: string, direction: -1 | 1) => {
        if (!draft) return;
        const group = resultGroups.find(item => item.key === groupKey);
        if (!group) return;
        const visible = groupVisiblePrompts(draft, group.promptIds);
        const index = visible.findIndex(item => item.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= visible.length) return;

        const prompts = [...draft.document.prompts];
        const fromIndex = prompts.findIndex(item => item.id === id);
        const toIndex = prompts.findIndex(item => item.id === visible[target].id);
        if (fromIndex < 0 || toIndex < 0) return;
        [prompts[fromIndex], prompts[toIndex]] = [prompts[toIndex], prompts[fromIndex]];
        patchPrompts(prompts);
    };

    const moveResultGroup = (groupKey: string, direction: -1 | 1) => {
        if (!draft) return;
        const index = resultGroups.findIndex(item => item.key === groupKey);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= resultGroups.length) return;
        const ordered = [...resultGroups];
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
        const byId = new Map(draft.document.prompts.map(prompt => [prompt.id, prompt]));
        patchPrompts(ordered.flatMap(group => group.promptIds.map(id => byId.get(id)).filter((prompt): prompt is StoryTheaterPresetPrompt => Boolean(prompt))));
    };

    const removeResultGroup = (groupKey: string) => {
        if (!draft) return;
        const group = resultGroups.find(item => item.key === groupKey);
        if (!group || group.protected) return;
        const groupPrompts = group.promptIds
            .map(id => draft.document.prompts.find(prompt => prompt.id === id))
            .filter((prompt): prompt is StoryTheaterPresetPrompt => Boolean(prompt));
        if (groupPrompts.some(isProtectedStoryPrompt)) {
            setNotice('这一组含系统连接位，不能整组删除。');
            return;
        }
        const ids = new Set(group.promptIds);
        patchPrompts(draft.document.prompts.filter(prompt => !ids.has(prompt.id)));
        if (expandedResultGroup === groupKey) setExpandedResultGroup(null);
        setNotice(`已从成品移除「${group.label}」。`);
    };

    const save = async () => {
        if (!draft || saving) return;
        const name = draft.name.trim() || draft.document.name.trim();
        if (!name) {
            setNotice('先给新预设起个名字。');
            return;
        }
        const now = Date.now();
        const next: StoryTheaterPreset = {
            ...draft,
            name,
            builtIn: false,
            sourceFileName: undefined,
            updatedAt: now,
            document: { ...draft.document, name },
        };
        setSaving(true);
        try {
            await onSave(next);
        } finally {
            setSaving(false);
        }
    };

    if (!draft || !basePreset) return (
        <div className='h-full w-full grid place-items-center bg-stone-100 text-slate-500'>
            <button onClick={onBack} className='rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold'>没有可用预设，返回</button>
        </div>
    );

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200 bg-stone-100/95'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onBack} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div className='min-w-0 flex-1'>
                    <div className='text-[9px] uppercase tracking-[.24em] font-bold text-violet-500'>Preset stitcher</div>
                    <div className='font-semibold truncate'>缝合台</div>
                </div>
                <button
                    onClick={() => { void save(); }}
                    disabled={saving}
                    className='h-9 px-3 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50'
                >
                    <FloppyDisk size={14} />{saving ? '保存中' : '保存新预设'}
                </button>
            </div>
        </header>

        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-28'>
            <div className='max-w-2xl mx-auto space-y-7'>
                <section className='rounded-3xl border border-slate-200 bg-white/70 p-4'>
                    <div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>1 · Base</div>
                    <h2 className='mt-1 text-lg font-semibold'>选底稿</h2>
                    <p className='mt-1 text-[10px] leading-5 text-slate-500'>底稿决定生成参数、assistant prefill 和角色 / 世界书 / 历史连接骨架。换底稿会重新开始当前成品。</p>
                    <select
                        value={baseId}
                        onChange={event => resetFromBase(event.target.value)}
                        className='mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs font-semibold outline-none'
                    >
                        {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                    </select>
                    <label className='mt-4 block'>
                        <span className='text-[10px] font-bold text-slate-500'>新预设名称</span>
                        <input
                            value={draft.name}
                            onChange={event => {
                                const name = event.target.value;
                                setDraft(current => current ? { ...current, name, document: { ...current.document, name } } : current);
                            }}
                            className='mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold outline-none focus:border-violet-300'
                            placeholder='给缝好的预设起名'
                        />
                    </label>
                </section>

                <section className='rounded-3xl border border-violet-100 bg-violet-50/50 p-4'>
                    <div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>2 · Material</div>
                    <h2 className='mt-1 text-lg font-semibold'>从素材预设往里缝</h2>
                    <select
                        value={sourcePreset?.id || ''}
                        onChange={event => { setSourceId(event.target.value); setExpandedSourceGroup(null); setNotice(''); }}
                        className='mt-3 w-full rounded-xl border border-violet-100 bg-white px-3 py-3 text-xs font-semibold outline-none'
                    >
                        {presets.filter(preset => preset.id !== baseId).map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                    </select>

                    {sourcePreset && <div className='mt-4 space-y-2'>
                        {sourceGroups.map(group => {
                            const visible = groupVisiblePrompts(sourcePreset, group.promptIds);
                            const stitchable = visible.filter(canStitchPrompt);
                            const duplicateCount = stitchable.filter(prompt => resultPromptIds.has(prompt.id)).length;
                            const expanded = expandedSourceGroup === group.key;
                            return <div key={group.key} className='rounded-2xl border border-violet-100 bg-white overflow-hidden'>
                                <div className='flex items-center gap-2 px-3 py-3'>
                                    <button
                                        onClick={() => setExpandedSourceGroup(current => current === group.key ? null : group.key)}
                                        className='min-w-0 flex-1 text-left'
                                    >
                                        <span className='block text-xs font-bold truncate'>{group.label}</span>
                                        <span className='mt-1 block text-[9px] text-slate-400'>
                                            {group.protected ? '系统连接区 · 不重复缝' : `${stitchable.length} 条可缝${duplicateCount ? ` · ${duplicateCount} 条已存在` : ''}`}
                                        </span>
                                    </button>
                                    <button
                                        disabled={stitchable.length === 0}
                                        onClick={() => appendGroup(sourcePreset, group.key)}
                                        className='shrink-0 rounded-xl bg-violet-100 px-3 py-2 text-[10px] font-bold text-violet-700 disabled:opacity-30'
                                    >
                                        + 整组
                                    </button>
                                </div>
                                {expanded && visible.length > 0 && <div className='border-t border-violet-50 px-3 pb-2'>
                                    {visible.map(prompt => {
                                        const protectedPrompt = !canStitchPrompt(prompt);
                                        const exists = resultPromptIds.has(prompt.id);
                                        return <div key={prompt.id} className='flex items-center gap-2 border-b border-slate-100 py-2.5 last:border-0'>
                                            <div className='min-w-0 flex-1'>
                                                <div className='truncate text-[11px] font-semibold'>{prompt.name}</div>
                                                <div className='mt-0.5 text-[8px] uppercase text-slate-400'>{protectedPrompt ? '系统连接位' : `${prompt.role} · ${prompt.enabled ? 'ON' : 'OFF'}`}</div>
                                            </div>
                                            {protectedPrompt ? <span className='text-[9px] text-slate-300'>底稿保留</span> : exists ? (
                                                <button onClick={() => replacePrompt(prompt)} className='rounded-lg bg-amber-50 px-2.5 py-1.5 text-[9px] font-bold text-amber-700'>替换</button>
                                            ) : (
                                                <button onClick={() => appendPrompt(sourcePreset, prompt)} className='rounded-lg bg-violet-50 px-2.5 py-1.5 text-[9px] font-bold text-violet-700'><Plus size={11} className='inline -mt-0.5 mr-0.5' />加入</button>
                                            )}
                                        </div>;
                                    })}
                                </div>}
                            </div>;
                        })}
                    </div>}
                </section>

                {notice && <div className='rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-[10px] leading-5 text-amber-800'>{notice}</div>}

                <section>
                    <div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>3 · Result</div>
                    <div className='mt-1 flex items-end justify-between gap-3'>
                        <div>
                            <h2 className='text-lg font-semibold'>成品</h2>
                            <p className='mt-1 text-[10px] leading-5 text-slate-500'>整组可以上下换位置；展开后可调单条顺序、开关或删除。系统连接位始终保留。</p>
                        </div>
                        <span className='shrink-0 text-[9px] text-slate-400'>{draft.document.prompts.length} 条</span>
                    </div>

                    <div className='mt-4 space-y-2'>
                        {resultGroups.map((group, groupIndex) => {
                            const visible = groupVisiblePrompts(draft, group.promptIds);
                            const expanded = expandedResultGroup === group.key;
                            const groupHasProtected = group.protected || visible.some(isProtectedStoryPrompt);
                            return <div key={group.key} className='rounded-2xl border border-slate-200 bg-white/80 overflow-hidden'>
                                <div className='flex items-center gap-1 px-3 py-3'>
                                    <button
                                        onClick={() => setExpandedResultGroup(current => current === group.key ? null : group.key)}
                                        className='min-w-0 flex-1 text-left'
                                    >
                                        <span className='block truncate text-xs font-bold'>{group.label}</span>
                                        <span className='mt-1 block text-[9px] text-slate-400'>{group.protected ? '系统连接区' : `${visible.length} 条`}</span>
                                    </button>
                                    <button disabled={groupIndex === 0} onClick={() => moveResultGroup(group.key, -1)} className='p-1.5 text-slate-400 disabled:opacity-20'><ArrowUp size={14} /></button>
                                    <button disabled={groupIndex === resultGroups.length - 1} onClick={() => moveResultGroup(group.key, 1)} className='p-1.5 text-slate-400 disabled:opacity-20'><ArrowDown size={14} /></button>
                                    {!groupHasProtected && <button onClick={() => removeResultGroup(group.key)} className='p-1.5 text-rose-400'><Trash size={14} /></button>}
                                </div>
                                {expanded && visible.length > 0 && <div className='border-t border-slate-100 px-3 pb-2'>
                                    {visible.map((prompt, index) => {
                                        const locked = isProtectedStoryPrompt(prompt);
                                        return <div key={prompt.id} className='flex items-center gap-1 border-b border-slate-100 py-2.5 last:border-0'>
                                            <button
                                                disabled={locked}
                                                onClick={() => toggleResultPrompt(prompt.id)}
                                                className={`w-9 shrink-0 text-left text-[9px] font-bold disabled:opacity-40 ${prompt.enabled ? 'text-emerald-600' : 'text-slate-300'}`}
                                            >
                                                {prompt.enabled ? 'ON' : 'OFF'}
                                            </button>
                                            <div className='min-w-0 flex-1'>
                                                <div className='truncate text-[11px] font-semibold'>{prompt.name}</div>
                                                <div className='mt-0.5 text-[8px] uppercase text-slate-400'>{locked ? '系统连接位' : prompt.role}</div>
                                            </div>
                                            <button disabled={index === 0} onClick={() => moveResultPrompt(group.key, prompt.id, -1)} className='p-1 text-slate-400 disabled:opacity-20'><ArrowUp size={13} /></button>
                                            <button disabled={index === visible.length - 1} onClick={() => moveResultPrompt(group.key, prompt.id, 1)} className='p-1 text-slate-400 disabled:opacity-20'><ArrowDown size={13} /></button>
                                            {!locked && <button onClick={() => removeResultPrompt(prompt.id)} className='p-1 text-rose-400'><Trash size={13} /></button>}
                                        </div>;
                                    })}
                                </div>}
                            </div>;
                        })}
                    </div>
                </section>

                <button
                    onClick={() => { void save(); }}
                    disabled={saving}
                    className='w-full h-12 rounded-2xl bg-slate-900 text-white text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50'
                >
                    <FloppyDisk size={16} />{saving ? '正在保存…' : '保存为新剧情预设'}
                </button>
            </div>
        </main>
    </div>;
};

export default StoryPresetStitcher;
