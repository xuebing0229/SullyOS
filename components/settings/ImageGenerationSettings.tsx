import React, { useEffect, useMemo, useState } from 'react';
import {
    fetchBuiltinImageRemoteConfig,
    loadBuiltinImageSettings,
    saveBuiltinImageSettings,
    setPreferredBuiltinImageEngine,
    testBuiltinImageRemoteConfig,
    updateBuiltinImageRemoteConfig,
    type BuiltinImageBinding,
    type BuiltinImageEngineId,
    type BuiltinImageSettings,
    type GptImageRemoteConfig,
    type ImageRemoteConfig,
    type NovelAiRemoteConfig,
} from '../../utils/builtinImageMcp';
import SensitiveTextInput from '../SensitiveTextInput';
import { resetMcpSession, testMcpConnection } from '../../utils/mcpClient';
import {
    applyImageGenerationPreset, createImageGenerationPreset, deleteImageGenerationPreset,
    getActiveImageGenerationPreset, getImageGenerationPresets, renameImageGenerationPreset,
    updateImageGenerationPreset, type ImageGenerationPreset,
} from '../../utils/imageGenerationPresets';

interface Props {
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const Input: React.FC<Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string; hint?: string; sensitive?: boolean }> = ({ label, hint, sensitive, ...props }) => (
    <label className="block">
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider pl-1">{label}</span>
        {sensitive ? (
            <SensitiveTextInput {...props} className={`mt-1 w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-xs text-slate-700 outline-none focus:border-violet-300 ${props.className || ''}`} />
        ) : (
            <input {...props} type="text" className={`mt-1 w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-xs text-slate-700 outline-none focus:border-violet-300 ${props.className || ''}`} />
        )}
        {hint && <span className="mt-1 block pl-1 text-[10px] leading-relaxed text-slate-400">{hint}</span>}
    </label>
);

const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }> = ({ label, children, ...props }) => (
    <label className="block">
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider pl-1">{label}</span>
        <select {...props} className="mt-1 w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-xs text-slate-700 outline-none focus:border-violet-300">
            {children}
        </select>
    </label>
);

const Toggle: React.FC<{ checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
    <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`shrink-0 appearance-none border-0 bg-transparent p-0 ${disabled ? 'opacity-40' : ''}`}
    >
        <span className={`flex h-6 w-10 items-center rounded-full p-1 transition-colors ${checked ? 'bg-violet-500' : 'bg-slate-200'}`}>
            <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : ''}`} />
        </span>
    </button>
);

function isGptConfig(config: ImageRemoteConfig | null): config is GptImageRemoteConfig {
    return Boolean(config && 'mode' in config);
}

function isNovelConfig(config: ImageRemoteConfig | null): config is NovelAiRemoteConfig {
    return Boolean(config && 'profile' in config);
}

const JsonEditor: React.FC<{
    label: string;
    value: Record<string, unknown>;
    onChange: (value: Record<string, unknown>) => void;
}> = ({ label, value, onChange }) => {
    const [text, setText] = useState(() => JSON.stringify(value, null, 2));
    useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
    return (
        <label className="block">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider pl-1">{label}</span>
            <textarea
                value={text}
                onChange={event => {
                    const next = event.target.value;
                    setText(next);
                    try {
                        const parsed = JSON.parse(next);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onChange(parsed);
                    } catch { /* keep editing; server validates on save */ }
                }}
                rows={5}
                spellCheck={false}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 font-mono text-[11px] text-slate-700 outline-none focus:border-violet-300"
            />
        </label>
    );
};

const BindingAdvanced: React.FC<{
    binding: BuiltinImageBinding;
    onChange: (patch: Partial<BuiltinImageBinding>) => void;
}> = ({ binding, onChange }) => {
    const [open, setOpen] = useState(false);
    return (
        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <button type="button" onClick={() => setOpen(value => !value)} className="flex w-full items-center justify-between text-[10px] font-bold text-slate-400">
                <span>服务器连接（一般不用改）</span><span>{open ? '▲' : '▼'}</span>
            </button>
            {open && (
                <div className="mt-3 space-y-3">
                    <Input label="MCP 地址" value={binding.mcpUrl} onChange={event => onChange({ mcpUrl: event.target.value })} />
                    <Input label="配置接口地址" value={binding.controlBaseUrl} onChange={event => onChange({ controlBaseUrl: event.target.value })} />
                    <Input
                        label="MCP Token"
                        sensitive
                        autoComplete="new-password"
                        value={binding.token}
                        onChange={event => onChange({ token: event.target.value })}
                        hint="这是小手机访问你日本服务器的凭据，不是上游 API Key。"
                    />
                </div>
            )}
        </div>
    );
};

const GptForm: React.FC<{ config: GptImageRemoteConfig; onChange: (next: GptImageRemoteConfig) => void }> = ({ config, onChange }) => {
    const patch = (value: Partial<GptImageRemoteConfig>) => onChange({ ...config, ...value });
    const patchCustom = (value: Partial<GptImageRemoteConfig['custom']>) => onChange({ ...config, custom: { ...config.custom, ...value } });
    return (
        <div className="space-y-3">
            <Select label="接口模式" value={config.mode} onChange={event => patch({ mode: event.target.value as GptImageRemoteConfig['mode'] })}>
                <option value="compatible">OpenAI 兼容</option>
                <option value="custom">自定义</option>
            </Select>
            <Input label="API 地址" value={config.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" />
            <Input label="模型" value={config.model} onChange={event => patch({ model: event.target.value })} placeholder="gpt-image-2" />
            <Select label="图片交付" value={config.imageDelivery} onChange={event => patch({ imageDelivery: event.target.value as GptImageRemoteConfig['imageDelivery'] })}>
                <option value="auto">自动</option><option value="direct">直接 URL</option><option value="proxy">服务器中转</option>
            </Select>
            {config.mode === 'custom' && (
                <div className="space-y-3 rounded-xl border border-amber-100 bg-amber-50/50 p-3">
                    <p className="text-[10px] leading-relaxed text-amber-700">只有路径或请求格式不兼容 OpenAI Images API 的站子才需要这里。</p>
                    <Input label="生成路径" value={config.custom.generatePath} onChange={event => patchCustom({ generatePath: event.target.value })} />
                    <div className="grid grid-cols-2 gap-2">
                        <Input label="鉴权 Header" value={config.custom.authHeader} onChange={event => patchCustom({ authHeader: event.target.value })} />
                        <Input label="鉴权前缀" value={config.custom.authPrefix} onChange={event => patchCustom({ authPrefix: event.target.value })} />
                    </div>
                    <Select label="响应格式" value={config.custom.responseMode} onChange={event => patchCustom({ responseMode: event.target.value as GptImageRemoteConfig['custom']['responseMode'] })}>
                        <option value="auto">自动</option><option value="json">JSON</option><option value="image">原始图片</option>
                    </Select>
                    <div className="grid grid-cols-2 gap-2">
                        <Input label="Prompt 字段" value={config.custom.requestFields.prompt} onChange={event => patchCustom({ requestFields: { ...config.custom.requestFields, prompt: event.target.value } })} />
                        <Input label="模型字段" value={config.custom.requestFields.model} onChange={event => patchCustom({ requestFields: { ...config.custom.requestFields, model: event.target.value } })} />
                        <Input label="尺寸字段" value={config.custom.requestFields.size} onChange={event => patchCustom({ requestFields: { ...config.custom.requestFields, size: event.target.value } })} />
                        <Input label="质量字段" value={config.custom.requestFields.quality} onChange={event => patchCustom({ requestFields: { ...config.custom.requestFields, quality: event.target.value } })} />
                        <Input label="背景字段" value={config.custom.requestFields.background} onChange={event => patchCustom({ requestFields: { ...config.custom.requestFields, background: event.target.value } })} />
                        <Input label="格式字段" value={config.custom.requestFields.outputFormat} onChange={event => patchCustom({ requestFields: { ...config.custom.requestFields, outputFormat: event.target.value } })} />
                    </div>
                    <Input
                        label="图片 URL 字段（逗号分隔）"
                        value={config.custom.responseUrlPaths.join(', ')}
                        onChange={event => patchCustom({ responseUrlPaths: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}
                    />
                    <Input
                        label="Base64 字段（逗号分隔）"
                        value={config.custom.responseBase64Paths.join(', ')}
                        onChange={event => patchCustom({ responseBase64Paths: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}
                    />
                    <JsonEditor label="额外请求头 JSON" value={config.custom.extraHeaders} onChange={value => patchCustom({ extraHeaders: value as Record<string, string | number | boolean> })} />
                    <JsonEditor label="额外请求体 JSON" value={config.custom.extraBody} onChange={value => patchCustom({ extraBody: value })} />
                </div>
            )}
        </div>
    );
};

const NovelForm: React.FC<{ config: NovelAiRemoteConfig; onChange: (next: NovelAiRemoteConfig) => void }> = ({ config, onChange }) => {
    const patch = (value: Partial<NovelAiRemoteConfig>) => onChange({ ...config, ...value });
    return (
        <div className="space-y-3">
            <Select label="接口类型" value={config.profile} onChange={event => patch({ profile: event.target.value as NovelAiRemoteConfig['profile'] })}>
                <option value="official">NovelAI 官方</option><option value="standard">普通 API 站</option><option value="custom">自定义</option>
            </Select>
            {config.profile !== 'official' && <Input label="API 地址" value={config.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} />}
            <Select label="图片交付" value={config.imageDelivery} onChange={event => patch({ imageDelivery: event.target.value as NovelAiRemoteConfig['imageDelivery'] })}>
                <option value="auto">自动</option><option value="direct">直接 URL</option><option value="proxy">服务器中转</option>
            </Select>
            {config.profile === 'custom' && (
                <div className="space-y-3 rounded-xl border border-amber-100 bg-amber-50/50 p-3">
                    <Input label="生成路径" value={config.generatePath} onChange={event => patch({ generatePath: event.target.value })} />
                    <div className="grid grid-cols-2 gap-2">
                        <Input label="鉴权 Header" value={config.authHeader} onChange={event => patch({ authHeader: event.target.value })} />
                        <Input label="鉴权前缀" value={config.authPrefix} onChange={event => patch({ authPrefix: event.target.value })} />
                    </div>
                    <Input label="Full 模型" value={config.modelFull} onChange={event => patch({ modelFull: event.target.value })} />
                    <Input label="Curated 模型" value={config.modelCurated} onChange={event => patch({ modelCurated: event.target.value })} />
                    <Select label="响应格式" value={config.responseMode} onChange={event => patch({ responseMode: event.target.value as NovelAiRemoteConfig['responseMode'] })}>
                        <option value="auto">自动</option><option value="json">JSON</option><option value="image">原始图片</option><option value="zip">ZIP</option>
                    </Select>
                </div>
            )}
        </div>
    );
};

const ImagePresetBar: React.FC<{ activePreset: ImageGenerationPreset | null; presets: ImageGenerationPreset[]; busy: boolean; onApply: (preset: ImageGenerationPreset) => void; onCreate: () => void; onUpdate: () => void; onRename: () => void; onDelete: () => void; }> = ({ activePreset, presets, busy, onApply, onCreate, onUpdate, onRename, onDelete }) => (
    <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-3">
        <div className="flex items-center gap-2">
            <select value={activePreset?.id || ''} disabled={busy} onChange={event => { const preset = presets.find(item => item.id === event.target.value); if (preset) onApply(preset); }} className="min-w-0 flex-1 rounded-xl border border-violet-100 bg-white px-3 py-2 text-xs text-slate-700">
                <option value="">当前配置（未绑定预设）</option>
                {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button type="button" disabled={busy} onClick={onCreate} className="shrink-0 rounded-xl bg-violet-500 px-3 py-2 text-[10px] font-bold text-white disabled:opacity-40">保存为预设</button>
        </div>
        {activePreset && <div className="mt-2 grid grid-cols-3 gap-2">
            <button type="button" disabled={busy} onClick={onUpdate} className="rounded-lg bg-white py-2 text-[10px] font-bold text-violet-600">更新</button>
            <button type="button" disabled={busy} onClick={onRename} className="rounded-lg bg-white py-2 text-[10px] font-bold text-slate-600">重命名</button>
            <button type="button" disabled={busy} onClick={onDelete} className="rounded-lg bg-white py-2 text-[10px] font-bold text-rose-500">删除</button>
        </div>}
    </div>
);

const EngineCard: React.FC<{
    id: BuiltinImageEngineId;
    title: string;
    description: string;
    expectedTool: string;
    settings: BuiltinImageSettings;
    setSettings: React.Dispatch<React.SetStateAction<BuiltinImageSettings>>;
    addToast: Props['addToast'];
}> = ({ id, title, description, expectedTool, settings, setSettings, addToast }) => {
    const binding = settings.engines[id];
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [remote, setRemote] = useState<ImageRemoteConfig | null>(null);
    const [presetRevision, setPresetRevision] = useState(0);
    const presets = useMemo(() => getImageGenerationPresets(id), [id, presetRevision]);
    const activePreset = useMemo(() => getActiveImageGenerationPreset(id), [id, presetRevision]);
    const [apiKey, setApiKey] = useState(() => getActiveImageGenerationPreset(id)?.apiKey || '');
    const [status, setStatus] = useState('');

    const updateBinding = (patch: Partial<BuiltinImageBinding>) => {
        setSettings(current => {
            const next = {
                ...current,
                engines: {
                    ...current.engines,
                    [id]: { ...current.engines[id], ...patch, id, updatedAt: Date.now() },
                },
            };
            saveBuiltinImageSettings(next);
            return next;
        });
        resetMcpSession(`builtin_image_${id}`);
    };

    const loadRemote = async () => {
        setBusy(true); setStatus('正在读取服务器配置…');
        try {
            const value = await fetchBuiltinImageRemoteConfig(binding);
            setRemote(value); setStatus('配置已读取');
        } catch (error: any) {
            setStatus(`❌ ${error?.message || String(error)}`);
        } finally { setBusy(false); }
    };

    useEffect(() => {
        const refresh = () => { setPresetRevision(value => value + 1); const active = getActiveImageGenerationPreset(id); if (active) setApiKey(active.apiKey); };
        window.addEventListener('sullyos:image-generation-presets-changed', refresh);
        return () => window.removeEventListener('sullyos:image-generation-presets-changed', refresh);
    }, [id]);

    useEffect(() => {
        if (open && binding.token && !remote && !busy) void loadRemote();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const saveRemote = async () => {
        if (!remote) return;
        setBusy(true); setStatus('正在保存…');
        try {
            const { apiKeyConfigured: _configured, apiKeyHint: _hint, version: _version, revision, ...patch } = remote as any;
            const updated = await updateBuiltinImageRemoteConfig(binding, {
                expectedRevision: revision,
                patch,
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            });
            setRemote(updated); setStatus('✅ 已保存'); addToast(`${title}配置已保存`, 'success');
        } catch (error: any) {
            setStatus(`❌ ${error?.message || String(error)}`);
        } finally { setBusy(false); }
    };

    const testControl = async (real: boolean) => {
        if (!remote) return;
        setBusy(true); setStatus(real ? '正在调用上游生成测试图…' : '正在验证配置…');
        try {
            const { apiKeyConfigured: _configured, apiKeyHint: _hint, version: _version, revision: _revision, ...patch } = remote as any;
            const result = await testBuiltinImageRemoteConfig(binding, real ? 'generate' : 'validate', {
                patch,
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            });
            setStatus(`✅ ${result.message}${result.imageUrl ? `\n${result.imageUrl}` : ''}`);
        } catch (error: any) {
            setStatus(`❌ ${error?.message || String(error)}`);
        } finally { setBusy(false); }
    };

    const ensureRemote = (): ImageRemoteConfig => { if (!remote) throw new Error('请先读取服务器配置'); return remote; };
    const createPreset = () => { try { const name = window.prompt(`给这个${title}配置起个名字`, `${title}预设`); if (name === null) return; createImageGenerationPreset({ name, engineId: id, binding, remoteConfig: ensureRemote(), apiKey }); setPresetRevision(v => v + 1); addToast('生图预设已保存', 'success'); } catch (e: any) { addToast(e?.message || '保存预设失败', 'error'); } };
    const updatePreset = () => { try { if (!activePreset) throw new Error('当前没有选中的预设'); updateImageGenerationPreset(activePreset.id, { binding, remoteConfig: ensureRemote(), apiKey }); setPresetRevision(v => v + 1); addToast('生图预设已更新', 'success'); } catch (e: any) { addToast(e?.message || '更新预设失败', 'error'); } };
    const renamePreset = () => { if (!activePreset) return; const name = window.prompt('重命名生图预设', activePreset.name); if (name === null) return; try { renameImageGenerationPreset(activePreset.id, name); setPresetRevision(v => v + 1); } catch (e: any) { addToast(e?.message || '重命名失败', 'error'); } };
    const removePreset = () => { if (!activePreset) return; deleteImageGenerationPreset(activePreset.id); setPresetRevision(v => v + 1); addToast('生图预设已删除', 'info'); };
    const applyPreset = async (preset: ImageGenerationPreset) => { setBusy(true); setStatus(`正在应用预设「${preset.name}」…`); try { const result = await applyImageGenerationPreset(preset); setSettings(result.settings); setRemote(result.remote); setApiKey(preset.apiKey); setPresetRevision(v => v + 1); setStatus(`✅ 已应用预设「${preset.name}」`); addToast(`已应用${title}预设`, 'success'); } catch (e: any) { setStatus(`❌ ${e?.message || String(e)}`); } finally { setBusy(false); } };

    const setEnabled = async (enabled: boolean) => {
        if (!enabled) { updateBinding({ enabled: false }); return; }
        if (!binding.token.trim()) { addToast('请先展开服务器连接并填写 MCP Token', 'error'); setOpen(true); return; }
        setBusy(true); setStatus('正在连接 MCP 并获取工具…');
        try {
            const server = {
                id: `builtin_image_${id}`,
                name: title,
                url: binding.mcpUrl,
                token: binding.token,
                enabled: true,
                tools: binding.tools,
                updatedAt: Date.now(),
                builtin: true,
            };
            const result = await testMcpConnection(server);
            if (!result.ok) throw new Error(result.message);
            const tools = result.tools || [];
            if (!tools.some(tool => tool.name === expectedTool)) {
                throw new Error(`服务器已连接，但没有发现 ${expectedTool}`);
            }
            updateBinding({ enabled: true, tools });
            setStatus(`✅ 已启用，发现工具 ${expectedTool}`);
        } catch (error: any) {
            updateBinding({ enabled: false });
            setStatus(`❌ ${error?.message || String(error)}`);
        } finally { setBusy(false); }
    };

    return (
        <div className="overflow-hidden rounded-2xl border border-violet-100 bg-white/80">
            <div className="flex items-center gap-3 p-4">
                <button type="button" onClick={() => setOpen(value => !value)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2"><span className="text-sm font-bold text-slate-700">{title}</span><span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${binding.enabled ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>{binding.enabled ? '已启用' : '未启用'}</span></div>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{description}</p>
                </button>
                <Toggle checked={binding.enabled} onChange={value => void setEnabled(value)} disabled={busy} />
            </div>
            {open && (
                <div className="space-y-3 border-t border-violet-50 p-4">
                    <ImagePresetBar activePreset={activePreset} presets={presets} busy={busy} onApply={preset => void applyPreset(preset)} onCreate={createPreset} onUpdate={updatePreset} onRename={renamePreset} onDelete={removePreset} />
                    <BindingAdvanced binding={binding} onChange={updateBinding} />
                    {!remote ? (
                        <button disabled={busy || !binding.token} onClick={() => void loadRemote()} className="w-full rounded-xl bg-violet-500 py-2.5 text-xs font-bold text-white disabled:opacity-40">读取服务器配置</button>
                    ) : (
                        <>
                            {id === 'gpt-image' && isGptConfig(remote) && <GptForm config={remote} onChange={setRemote} />}
                            {id === 'novelai' && isNovelConfig(remote) && <NovelForm config={remote} onChange={setRemote} />}
                            <Input
                                label="API 密钥"
                                sensitive
                                autoComplete="new-password"
                                value={apiKey}
                                onChange={event => setApiKey(event.target.value)}
                                placeholder={remote.apiKeyConfigured ? `已配置：${remote.apiKeyHint || '••••'}（留空不更换）` : '尚未配置'}
                                hint="密钥可保存到生图预设，并随完整/纯文字备份恢复。"
                            />
                            <div className="grid grid-cols-2 gap-2">
                                <button disabled={busy} onClick={() => void testControl(false)} className="rounded-xl border border-violet-200 bg-violet-50 py-2.5 text-xs font-bold text-violet-600 disabled:opacity-40">验证配置</button>
                                <button disabled={busy} onClick={() => void saveRemote()} className="rounded-xl bg-violet-500 py-2.5 text-xs font-bold text-white disabled:opacity-40">保存</button>
                            </div>
                            <button disabled={busy} onClick={() => void testControl(true)} className="w-full rounded-xl border border-amber-200 bg-amber-50 py-2.5 text-[11px] font-bold text-amber-700 disabled:opacity-40">实际生图测试（会调用一次上游）</button>
                        </>
                    )}
                    {status && <div className={`whitespace-pre-wrap break-all rounded-xl px-3 py-2 text-[10px] leading-relaxed ${status.startsWith('❌') ? 'bg-rose-50 text-rose-600' : status.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-500'}`}>{status}</div>}
                </div>
            )}
        </div>
    );
};

export const ImageGenerationSettings: React.FC<Props> = ({ addToast }) => {
    const [settings, setSettings] = useState<BuiltinImageSettings>(() => loadBuiltinImageSettings());
    const enabledCount = useMemo(() => Object.values(settings.engines).filter(engine => engine.enabled).length, [settings]);
    return (
        <div className="space-y-3">
            <div className="rounded-2xl border border-violet-100 bg-violet-50/60 p-3">
                <p className="text-xs font-bold text-slate-700">默认生图模式</p>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">选择后会一直使用，直到你在这里更换；生成时不再临时询问，也不会自动切换到另一引擎。</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                    {(['gpt-image', 'novelai'] as const).map(id => {
                        const selected = settings.preferredEngine === id;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setSettings(setPreferredBuiltinImageEngine(id))}
                                className={`rounded-xl px-3 py-2.5 text-xs font-bold transition-all ${selected ? 'bg-violet-500 text-white shadow-sm' : 'bg-white text-slate-500 border border-violet-100'}`}
                            >
                                {id === 'gpt-image' ? 'GPT 生图' : 'NovelAI 生图'}
                                {selected ? ' · 当前' : ''}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-xs font-bold text-slate-600">内置生图引擎</p>
                    <p className="mt-0.5 text-[10px] text-slate-400">两套工具分别配置；实际生成固定使用上方选中的默认模式。</p>
                </div>
                <span className="rounded-full bg-violet-100 px-2 py-1 text-[10px] font-bold text-violet-600">{enabledCount}/2 已启用</span>
            </div>
            <EngineCard
                id="gpt-image"
                title="GPT 生图"
                description="自然语言、写实、海报、物品、风景和通用图片。兼容 OpenAI 官方与大多数兼容站。"
                expectedTool="generate_image"
                settings={settings}
                setSettings={setSettings}
                addToast={addToast}
            />
            <EngineCard
                id="novelai"
                title="NovelAI 生图"
                description="二次元、正负面标签、Seed、Steps、Guidance 与 NovelAI V4 Prompt。"
                expectedTool="novelai_generate_image"
                settings={settings}
                setSettings={setSettings}
                addToast={addToast}
            />
        </div>
    );
};

export default ImageGenerationSettings;
