import React, { useEffect, useState } from 'react';
import type { CharacterProfile, DateCgImagePromptConfig } from '../../types';
import { useOS } from '../../context/OSContext';
import { getApiPresetModelEntries } from '../../utils/apiPresetModels';
import {
    deleteStoryImageTextPreset,
    loadStoryImageTextPresets,
    renameStoryImageTextPreset,
    resolveStoryImagePresetForActors,
    upsertStoryImageTextPreset,
    type StoryImageTextPreset,
} from '../../utils/storyImageTextPresets';

const normalizeDraft = (char: CharacterProfile): DateCgImagePromptConfig => ({
    stylePrompt: char.dateCgImagePrompt?.stylePrompt || '',
    negativePrompt: char.dateCgImagePrompt?.negativePrompt || '',
    userAnchor: char.dateCgImagePrompt?.userAnchor || '',
    characterAnchors: { ...(char.dateCgImagePrompt?.characterAnchors || {}) },
});

const DateCgPromptSettings: React.FC<{ char: CharacterProfile }> = ({ char }) => {
    const { updateCharacter, addToast, userProfile, apiPresets, apiConfig } = useOS();
    const [draft, setDraft] = useState<DateCgImagePromptConfig>(() => normalizeDraft(char));
    const [textPresets, setTextPresets] = useState<StoryImageTextPreset[]>(() => loadStoryImageTextPresets());
    const [presetName, setPresetName] = useState('');
    const selectedPlannerPreset = apiPresets.find(preset => preset.id === char.dateCgPlannerApiPresetId);
    const plannerModels = selectedPlannerPreset ? getApiPresetModelEntries(selectedPlannerPreset) : [];
    const plannerModel = selectedPlannerPreset
        ? (char.dateCgPlannerModel || selectedPlannerPreset.config.model)
        : apiConfig.model;

    useEffect(() => {
        setDraft(normalizeDraft(char));
        setTextPresets(loadStoryImageTextPresets());
        setPresetName('');
    }, [char.id]);

    const saveDraft = (next: DateCgImagePromptConfig = draft) => {
        const normalized: DateCgImagePromptConfig = {
            stylePrompt: next.stylePrompt?.trim() || undefined,
            negativePrompt: next.negativePrompt?.trim() || undefined,
            userAnchor: next.userAnchor?.trim() || undefined,
            characterAnchors: {
                [char.id]: next.characterAnchors?.[char.id]?.trim() || '',
            },
        };
        updateCharacter(char.id, { dateCgImagePrompt: normalized });
        addToast('见面 CG 提示词已保存', 'success');
    };

    const applyTextPreset = (preset: StoryImageTextPreset) => {
        const resolved = resolveStoryImagePresetForActors(preset, [{ id: char.id, name: char.name }]);
        const next: DateCgImagePromptConfig = {
            stylePrompt: resolved.stylePrompt,
            negativePrompt: resolved.negativePrompt,
            userAnchor: resolved.userAnchor,
            characterAnchors: resolved.characterAnchors,
        };
        setDraft(next);
        updateCharacter(char.id, { dateCgImagePrompt: next });
        addToast(`已应用共享配图预设「${preset.name}」`, 'success');
    };

    const saveTextPreset = () => {
        const name = presetName.trim();
        if (!name) {
            addToast('先给配图预设起个名字', 'error');
            return;
        }
        try {
            const result = upsertStoryImageTextPreset({
                presets: textPresets,
                name,
                stylePrompt: draft.stylePrompt,
                negativePrompt: draft.negativePrompt,
                userAnchor: draft.userAnchor,
                actors: [{ id: char.id, name: char.name }],
                characterAnchors: draft.characterAnchors,
            });
            setTextPresets(result.presets);
            setPresetName('');
            addToast(result.replaced ? `已覆盖共享配图预设「${name}」` : `已保存共享配图预设「${name}」`, 'success');
        } catch (error: any) {
            addToast(error?.message || '配图预设保存失败', 'error');
        }
    };

    const renamePreset = (preset: StoryImageTextPreset) => {
        const requested = window.prompt('新的预设名称', preset.name);
        if (requested === null) return;
        try {
            const next = renameStoryImageTextPreset(textPresets, preset.id, requested);
            setTextPresets(next);
            addToast(`已重命名为「${requested.trim()}」`, 'success');
        } catch (error: any) {
            addToast(error?.message || '配图预设重命名失败', 'error');
        }
    };

    const deletePreset = (preset: StoryImageTextPreset) => {
        if (!window.confirm(`删除配图预设「${preset.name}」？文游里也会一起消失。`)) return;
        try {
            setTextPresets(deleteStoryImageTextPreset(textPresets, preset.id));
            addToast(`已删除共享配图预设「${preset.name}」`, 'success');
        } catch {
            addToast('配图预设删除失败', 'error');
        }
    };

    const setField = (patch: Partial<DateCgImagePromptConfig>) => {
        setDraft(current => ({ ...current, ...patch }));
    };

    return <div className="space-y-4">
        <div className="rounded-xl bg-violet-50 px-3 py-2.5 text-[10px] leading-5 text-violet-700">
            与文游共用同一套「配图内容预设」。规划 API 会看到这些固定层来理解人物与画风，但只负责本轮场景、构图、谁入镜和参考图选择；真正出图前由客户端按实际入镜者确定性合并固定外貌、画风与负面词。
        </div>

        <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
            <div className="text-[11px] font-bold text-slate-600">CG 生图规划模型</div>
            <p className="mt-1 text-[10px] leading-5 text-slate-400">
                只负责理解见面剧情、选择生图工具和画面参数。可与写剧情的模型使用不同 API；
                真正出图仍由已选的 GPT Image / NovelAI 执行。
            </p>
            <select
                aria-label="见面 CG 规划 API 预设"
                value={char.dateCgPlannerApiPresetId || ''}
                onChange={event => {
                    const presetId = event.target.value;
                    const preset = apiPresets.find(item => item.id === presetId);
                    updateCharacter(char.id, {
                        dateCgPlannerApiPresetId: presetId || undefined,
                        dateCgPlannerModel: preset?.config.model || undefined,
                    });
                }}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs outline-none"
            >
                <option value="">跟随当前聊天 API（{apiConfig.model || '未配置模型'}）</option>
                {char.dateCgPlannerApiPresetId && !selectedPlannerPreset && (
                    <option value={char.dateCgPlannerApiPresetId} disabled>所选预设已删除，请重新选择</option>
                )}
                {apiPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
            {selectedPlannerPreset && <select
                aria-label="见面 CG 规划模型"
                value={plannerModel}
                onChange={event => updateCharacter(char.id, { dateCgPlannerModel: event.target.value })}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs outline-none"
            >
                {!plannerModels.some(item => item.model === plannerModel) && (
                    <option value={plannerModel} disabled>模型已从预设中删除：{plannerModel}</option>
                )}
                {plannerModels.map(item => <option key={item.model} value={item.model}>{item.model}</option>)}
            </select>}
            <div className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-[10px] leading-5 text-violet-700">
                {char.dateCgPlannerApiPresetId && !selectedPlannerPreset
                    ? '原规划 API 预设已失效，请重新选择（不会偷偷切回正文模型）。'
                    : `当前规划器：${selectedPlannerPreset?.name || '跟随聊天 API'} · ${plannerModel || '未配置'}`}
            </div>
        </div>

        <div>
            <div className="text-[11px] font-bold text-slate-500">共享配图预设</div>
            <p className="mt-1 text-[10px] leading-5 text-slate-400">这里保存或删除后，文游的「配图内容预设」会同步看到同一份列表。</p>
            <div className="mt-2 flex gap-2">
                <input
                    value={presetName}
                    onChange={event => setPresetName(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            saveTextPreset();
                        }
                    }}
                    placeholder="给当前四项起个预设名"
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs outline-none"
                />
                <button type="button" onClick={saveTextPreset} className="shrink-0 rounded-xl bg-violet-600 px-3 text-[10px] font-bold text-white">
                    保存当前
                </button>
            </div>
            {textPresets.length > 0 ? <div className="mt-3 space-y-2">
                {textPresets.map(preset => <div key={preset.id} className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 p-2">
                    <button type="button" onClick={() => applyTextPreset(preset)} className="min-w-0 flex-1 rounded-lg bg-violet-50 px-3 py-2 text-left text-[11px] font-bold text-violet-700">
                        <span className="block truncate">{preset.name}</span>
                        <span className="mt-0.5 block text-[8px] font-normal text-violet-500">点这里一键填入</span>
                    </button>
                    <button type="button" onClick={() => renamePreset(preset)} className="shrink-0 rounded-lg px-2 py-2 text-[9px] font-bold text-slate-500">改名</button>
                    <button type="button" onClick={() => deletePreset(preset)} className="shrink-0 rounded-lg px-2 py-2 text-[9px] font-bold text-rose-500">删除</button>
                </div>)}
            </div> : <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[9px] leading-4 text-slate-400">
                还没有共享预设。填好下面四类内容后，可以直接在这里保存；文游也能用。
            </div>}
        </div>

        <label className="block border-t border-slate-100 pt-4">
            <span className="text-[11px] font-bold text-slate-500">画风补充</span>
            <textarea
                value={draft.stylePrompt || ''}
                onChange={event => setField({ stylePrompt: event.target.value })}
                placeholder="例如：电影感、柔和逆光、细腻背景"
                className="mt-1.5 min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 outline-none"
            />
        </label>

        <div className="border-t border-slate-100 pt-4">
            <div className="text-[11px] font-bold text-slate-500">人物外观锚点</div>
            <p className="mt-1 text-[10px] leading-5 text-slate-400">和文游一样，固定外貌层不会让 planner 自己改写；只有实际入镜的人才会被合并进最终生图参数。</p>
            <label className="mt-3 block">
                <span className="text-[10px] font-bold text-slate-500">{userProfile.name || '你'} · 当前身份</span>
                <textarea
                    value={draft.userAnchor || ''}
                    onChange={event => setField({ userAnchor: event.target.value })}
                    placeholder="发型、发色、瞳色、衣着等"
                    className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 outline-none"
                />
            </label>
            <label className="mt-3 block">
                <span className="text-[10px] font-bold text-slate-500">{char.name}</span>
                <textarea
                    value={draft.characterAnchors?.[char.id] || ''}
                    onChange={event => setField({
                        characterAnchors: { ...(draft.characterAnchors || {}), [char.id]: event.target.value },
                    })}
                    placeholder="固定外貌与常用服装"
                    className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 outline-none"
                />
            </label>
        </div>

        <label className="block border-t border-slate-100 pt-4">
            <span className="text-[11px] font-bold text-slate-500">避免内容 / 负面提示</span>
            <textarea
                value={draft.negativePrompt || ''}
                onChange={event => setField({ negativePrompt: event.target.value })}
                placeholder="例如：文字、水印、额外手指"
                className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 outline-none"
            />
        </label>

        <button type="button" onClick={() => saveDraft()} className="h-11 w-full rounded-xl bg-slate-900 text-xs font-bold text-white active:scale-[0.99] transition-transform">
            保存见面 CG 提示词
        </button>
    </div>;
};

export default DateCgPromptSettings;
