import React, { useEffect, useRef, useState } from 'react';
import { Check, ImageSquare, Trash, UploadSimple } from '@phosphor-icons/react';

import BlobImage from '../media/BlobImage';
import Modal from '../os/Modal';
import { ensureNovelAiReferenceUploaded } from '../../utils/novelAiReference';
import {
    addVibeReference,
    loadVibeReferenceLibrary,
    removeVibeReference,
    setActiveVibeReference,
    setVibeReferenceEnabled,
    updateVibeReference,
    type VibeReferenceLibrary,
} from '../../utils/vibeReference';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onChanged?: () => void;
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const VibeReferenceLibraryModal: React.FC<Props> = ({ isOpen, onClose, onChanged, addToast }) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [library, setLibrary] = useState<VibeReferenceLibrary>(() => loadVibeReferenceLibrary());
    const [busy, setBusy] = useState(false);

    const refresh = () => {
        setLibrary(loadVibeReferenceLibrary());
        onChanged?.();
    };

    useEffect(() => {
        if (isOpen) setLibrary(loadVibeReferenceLibrary());
    }, [isOpen]);

    const upload = async (files: FileList | null) => {
        if (!files?.length) return;
        setBusy(true);
        let added = 0;
        try {
            for (const file of Array.from(files)) {
                await addVibeReference(file, file.name);
                added += 1;
            }
            refresh();
            addToast(`已加入 ${added} 张 Vibe 参考图`, 'success');
        } catch (error: any) {
            refresh();
            addToast(error?.message || 'Vibe 图片处理失败', 'error');
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = '';
        }
    };

    const toggle = () => {
        setVibeReferenceEnabled(!library.enabled);
        refresh();
    };

    const choose = (id: string) => {
        setActiveVibeReference(id);
        refresh();
    };

    const remove = async (id: string) => {
        await removeVibeReference(id);
        refresh();
    };

    const patchActive = (patch: { name?: string; strength?: number; informationExtracted?: number }) => {
        if (!library.activeId) return;
        updateVibeReference(library.activeId, patch);
        refresh();
    };

    const syncActive = async () => {
        const active = library.items.find(item => item.id === library.activeId);
        if (!active) return;
        setBusy(true);
        try {
            const result = await ensureNovelAiReferenceUploaded(active);
            addToast(result.uploaded ? 'Vibe 已同步到 NovelAI MCP' : '服务器上的 Vibe 已是最新', 'success');
        } catch (error: any) {
            addToast(error?.message || 'Vibe 同步失败', 'error');
        } finally {
            setBusy(false);
        }
    };

    const active = library.items.find(item => item.id === library.activeId) || null;

    return (
        <Modal isOpen={isOpen} title="Vibe 参考图库" onClose={onClose}>
            <div className="space-y-4">
                <div className="flex items-center justify-between rounded-2xl bg-violet-50 px-4 py-3 border border-violet-100">
                    <div>
                        <p className="text-sm font-bold text-slate-700">随生图使用</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">只影响 NovelAI；不会替换角色锁脸图</p>
                    </div>
                    <button
                        type="button"
                        onClick={toggle}
                        disabled={!library.items.length}
                        className={`shrink-0 appearance-none border-0 bg-transparent p-0 ${!library.items.length ? 'opacity-40' : ''}`}
                        aria-label="Vibe 总开关"
                    >
                        <span className={`flex h-6 w-10 items-center rounded-full p-1 transition-colors ${library.enabled ? 'bg-violet-500' : 'bg-slate-200'}`}>
                            <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${library.enabled ? 'translate-x-4' : ''}`} />
                        </span>
                    </button>
                </div>

                <button
                    type="button"
                    disabled={busy}
                    onClick={() => inputRef.current?.click()}
                    className="w-full py-3 rounded-2xl border border-dashed border-violet-300 bg-violet-50/50 text-violet-600 font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                    <UploadSimple size={18} weight="bold" />
                    {busy ? '处理中…' : '上传 Vibe 图片（可多选）'}
                </button>
                <input ref={inputRef} type="file" multiple accept="image/*" className="hidden" onChange={event => void upload(event.target.files)} />

                {library.items.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2">
                        {library.items.map(item => {
                            const selected = item.id === library.activeId;
                            return (
                                <div key={item.id} className="relative">
                                    <button
                                        type="button"
                                        onClick={() => choose(item.id)}
                                        className={`relative block aspect-square w-full overflow-hidden rounded-2xl border-2 ${selected ? 'border-violet-500' : 'border-transparent'}`}
                                    >
                                        <BlobImage src={item.imageRef} alt={item.name} className="h-full w-full object-cover" fallback={<div className="h-full w-full bg-slate-100 flex items-center justify-center"><ImageSquare className="text-slate-300" size={24} /></div>} />
                                        {selected && <span className="absolute right-1.5 top-1.5 rounded-full bg-violet-500 p-1 text-white"><Check size={11} weight="bold" /></span>}
                                        <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-[9px] text-white">{item.name}</span>
                                    </button>
                                    <button type="button" aria-label={`删除 ${item.name}`} onClick={() => void remove(item.id)} className="absolute -right-1 -top-1 rounded-full bg-white p-1 text-rose-500 shadow border border-rose-100">
                                        <Trash size={12} weight="bold" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="py-6 text-center text-xs text-slate-400">还没有 Vibe 图片</div>
                )}

                {active && (
                    <div className="space-y-3 rounded-2xl bg-slate-50 p-4 border border-slate-100">
                        <input
                            value={active.name}
                            onChange={event => {
                                const next = { ...library, items: library.items.map(item => item.id === active.id ? { ...item, name: event.target.value } : item) };
                                setLibrary(next);
                            }}
                            onBlur={event => patchActive({ name: event.target.value })}
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 outline-none focus:border-violet-400"
                        />
                        <label className="block">
                            <span className="flex justify-between text-[11px] text-slate-500"><b>参考强度</b><span>{active.strength.toFixed(2)}</span></span>
                            <input type="range" min="0" max="1" step="0.05" value={active.strength} onChange={event => patchActive({ strength: Number(event.target.value) })} className="w-full accent-violet-500" />
                        </label>
                        <label className="block">
                            <span className="flex justify-between text-[11px] text-slate-500"><b>信息提取</b><span>{active.informationExtracted.toFixed(2)}</span></span>
                            <input type="range" min="0" max="1" step="0.05" value={active.informationExtracted} onChange={event => patchActive({ informationExtracted: Number(event.target.value) })} className="w-full accent-violet-500" />
                            <span className="mt-1 block text-[9px] leading-relaxed text-slate-400">改这个值会生成一份新的 Vibe 编码；同一张图 + 同一信息提取值命中缓存后不会重复编码。</span>
                        </label>
                        <button type="button" disabled={busy} onClick={() => void syncActive()} className="w-full rounded-xl bg-white border border-slate-200 py-2 text-xs font-bold text-slate-600 disabled:opacity-50">
                            同步参考图到服务器
                        </button>
                    </div>
                )}

                <p className="text-[10px] leading-relaxed text-slate-400">
                    这里使用真正的 NovelAI Vibe Transfer，不再拿 Style Precise 代替。第一次按「图片 + 模型 + 信息提取」编码时可能产生额外费用，之后会复用服务器缓存；只改参考强度不会重新编码。Vibe Transfer 与 Precise Reference 不能同时发送，因此开启 Vibe 时本次生成会优先 Vibe、暂不带角色/用户精密参照。当前模型或线路若不支持 Vibe 会明确报错，不会偷偷退化。
                </p>
            </div>
        </Modal>
    );
};

export default VibeReferenceLibraryModal;
