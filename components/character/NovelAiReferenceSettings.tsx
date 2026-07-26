import React, { useEffect, useRef, useState } from 'react';
import type {
    GalleryImage,
    NovelAiPreciseReferenceConfig,
    NovelAiReferenceType,
} from '../../types';
import { DB } from '../../utils/db';
import BlobImage from '../media/BlobImage';
import Modal from '../os/Modal';
import {
    clampReferenceUnit,
    createReferenceConfigFromSource,
    createReferenceConfigFromStoredImage,
    deleteRemoteNovelAiReference,
    ensureNovelAiReferenceUploaded,
} from '../../utils/novelAiReference';

interface Props {
    characterId: string;
    value?: NovelAiPreciseReferenceConfig;
    onChange: (value: NovelAiPreciseReferenceConfig | undefined) => void;
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const Range: React.FC<{
    label: string;
    value: number;
    hint: string;
    onChange: (value: number) => void;
}> = ({ label, value, hint, onChange }) => (
    <label className="block">
        <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-600">{label}</span>
            <span className="font-mono text-[11px] text-violet-600">{value.toFixed(2)}</span>
        </div>
        <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={value}
            onChange={event => onChange(clampReferenceUnit(Number(event.target.value)))}
            className="mt-1 w-full accent-violet-500"
        />
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{hint}</p>
    </label>
);

const NovelAiReferenceSettings: React.FC<Props> = ({
    characterId,
    value,
    onChange,
    addToast,
}) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [showGallery, setShowGallery] = useState(false);
    const [gallery, setGallery] = useState<GalleryImage[]>([]);

    useEffect(() => {
        if (!showGallery) return;
        DB.getGalleryImages(characterId)
            .then(items => setGallery(items.sort((a, b) => b.timestamp - a.timestamp)))
            .catch(() => setGallery([]));
    }, [characterId, showGallery]);

    const update = (patch: Partial<NovelAiPreciseReferenceConfig>) => {
        if (!value) return;
        onChange({ ...value, ...patch, updatedAt: Date.now() });
    };

    const acceptBlob = async (blob: Blob, name: string) => {
        setBusy(true);
        try {
            const next = await createReferenceConfigFromSource(blob, name, value);
            onChange(next);
            addToast('锁脸参考图已保存到本机', 'success');
        } catch (error: any) {
            addToast(error?.message || '参考图处理失败', 'error');
        } finally {
            setBusy(false);
        }
    };

    const chooseGalleryImage = async (image: GalleryImage) => {
        setBusy(true);
        setShowGallery(false);
        try {
            const next = await createReferenceConfigFromStoredImage(
                image.url,
                `相册图片 ${new Date(image.timestamp).toLocaleString()}`,
                value,
            );
            onChange(next);
            addToast('已复制相册图片作为独立锁脸参考图', 'success');
        } catch (error: any) {
            addToast(error?.message || '相册图片处理失败', 'error');
        } finally {
            setBusy(false);
        }
    };

    const sync = async () => {
        if (!value) return;
        setBusy(true);
        try {
            const result = await ensureNovelAiReferenceUploaded(value);
            addToast(result.uploaded ? '参考图已同步到 NovelAI MCP' : '服务器参考图已经是最新', 'success');
        } catch (error: any) {
            addToast(error?.message || '同步失败', 'error');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        const previous = value;
        onChange(undefined);
        if (previous) {
            void deleteRemoteNovelAiReference(previous).catch(() => {
                // Server is only a cache. Local removal must not be blocked by network failure.
            });
        }
        addToast('已移除锁脸参考图', 'info');
    };

    return (
        <>
            <section className="mt-5 rounded-2xl border border-violet-100 bg-violet-50/50 p-4">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-bold text-slate-700">NovelAI 精密参照</h3>
                        <p className="mt-0.5 text-[10px] text-slate-400">为这个角色保持脸、发型和关键外观</p>
                    </div>
                    <button
                        type="button"
                        disabled={!value || busy}
                        onClick={() => value && update({ enabled: !value.enabled })}
                        className={`shrink-0 appearance-none border-0 bg-transparent p-0 ${!value || busy ? 'opacity-40' : ''}`}
                    >
                        <span className={`flex h-6 w-10 items-center rounded-full p-1 transition-colors ${value?.enabled ? 'bg-violet-500' : 'bg-slate-200'}`}>
                            <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${value?.enabled ? 'translate-x-4' : ''}`} />
                        </span>
                    </button>
                </div>

                {value?.imageRef ? (
                    <div className="mt-3 space-y-3">
                        <div className="overflow-hidden rounded-2xl border border-white bg-black">
                            <BlobImage
                                src={value.imageRef}
                                alt="NovelAI 锁脸参考图"
                                className="mx-auto max-h-64 w-full object-contain"
                            />
                        </div>
                        <p className="truncate text-[10px] text-slate-400">
                            {value.sourceName || '参考图'} · {(value.imageSha256 || '').slice(0, 8)}…
                        </p>

                        <label className="block">
                            <span className="text-[11px] font-bold text-slate-600">参照内容</span>
                            <select
                                value={value.type}
                                onChange={event => update({ type: event.target.value as NovelAiReferenceType })}
                                className="mt-1 w-full rounded-xl border border-violet-100 bg-white px-3 py-2.5 text-xs text-slate-700"
                            >
                                <option value="character">仅角色外观</option>
                                <option value="style">仅画风</option>
                                <option value="character&style">角色 + 画风</option>
                            </select>
                        </label>

                        <Range
                            label="影响强度"
                            value={value.strength}
                            onChange={strength => update({ strength })}
                            hint="越高越受参考图影响；太高可能连姿势和角度也变得相似。"
                        />
                        <Range
                            label="忠实度"
                            value={value.fidelity}
                            onChange={fidelity => update({ fidelity })}
                            hint="越高越重视角色细节；默认 0.85，先别拉满。"
                        />

                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => inputRef.current?.click()}
                                className="rounded-xl bg-white py-2.5 text-[11px] font-bold text-violet-600 disabled:opacity-40"
                            >
                                更换本机图片
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => setShowGallery(true)}
                                className="rounded-xl bg-white py-2.5 text-[11px] font-bold text-violet-600 disabled:opacity-40"
                            >
                                从相册选择
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => void sync()}
                                className="rounded-xl bg-violet-500 py-2.5 text-[11px] font-bold text-white disabled:opacity-40"
                            >
                                {busy ? '处理中…' : '同步到服务器'}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => void remove()}
                                className="rounded-xl bg-rose-50 py-2.5 text-[11px] font-bold text-rose-500 disabled:opacity-40"
                            >
                                移除
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="mt-3 space-y-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => inputRef.current?.click()}
                            className="w-full rounded-xl bg-violet-500 py-3 text-xs font-bold text-white disabled:opacity-40"
                        >
                            {busy ? '正在处理…' : '从本机选择参考图'}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => setShowGallery(true)}
                            className="w-full rounded-xl bg-white py-3 text-xs font-bold text-violet-600 disabled:opacity-40"
                        >
                            从该角色相册选择
                        </button>
                    </div>
                )}

                <input
                    ref={inputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={event => {
                        const file = event.target.files?.[0];
                        event.currentTarget.value = '';
                        if (file) void acceptBlob(file, file.name);
                    }}
                />

                <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                    参考图不会进入聊天 Prompt。第一次生图前会自动同步到你自己的 NovelAI MCP。
                    精密参照只支持 V4.5；API 站若不支持会明确报错，不会偷偷退化。
                </p>
            </section>

            <Modal
                isOpen={showGallery}
                title="选择锁脸参考图"
                onClose={() => setShowGallery(false)}
            >
                {gallery.length ? (
                    <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto">
                        {gallery.map(image => (
                            <button
                                key={image.id}
                                type="button"
                                onClick={() => void chooseGalleryImage(image)}
                                className="aspect-square overflow-hidden rounded-xl bg-slate-100"
                            >
                                <BlobImage
                                    src={image.url}
                                    alt=""
                                    className="h-full w-full object-cover"
                                />
                            </button>
                        ))}
                    </div>
                ) : (
                    <p className="py-8 text-center text-xs text-slate-400">这个角色的相册里还没有图片</p>
                )}
            </Modal>
        </>
    );
};

export default NovelAiReferenceSettings;
