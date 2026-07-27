import type { ApiPricing } from '../types';
import {
    fetchBuiltinImageRemoteConfig,
    loadBuiltinImageSettings,
    saveBuiltinImageSettings,
    updateBuiltinImageRemoteConfig,
    type BuiltinImageBinding,
    type BuiltinImageEngineId,
    type BuiltinImageSettings,
    type GptImageRemoteConfig,
    type ImageRemoteConfig,
    type NovelAiRemoteConfig,
} from './builtinImageMcp';
import {
    importMcpLocal,
    exportMcpLocal,
    resetMcpSession,
    type McpToolDef,
} from './mcpClient';

export const IMAGE_PRESET_STATE_KEY = 'aetheros.imageGeneration.presets.v1';

export interface ImagePresetBinding {
    mcpUrl: string;
    controlBaseUrl: string;
    token: string;
    enabled: boolean;
    tools: McpToolDef[];
}

export type StoredGptImageRemoteConfig = Omit<GptImageRemoteConfig, 'revision' | 'apiKeyConfigured' | 'apiKeyHint'>;
export type StoredNovelAiRemoteConfig = Omit<NovelAiRemoteConfig, 'revision' | 'apiKeyConfigured' | 'apiKeyHint'>;
export type StoredImageRemoteConfig = StoredGptImageRemoteConfig | StoredNovelAiRemoteConfig;

export interface ImageGenerationPreset {
    id: string;
    name: string;
    engineId: BuiltinImageEngineId;
    binding: ImagePresetBinding;
    remoteConfig: StoredImageRemoteConfig;
    apiKey: string;
    pricing?: ApiPricing;
    createdAt: number;
    updatedAt: number;
}

export interface ImageGenerationPresetState {
    version: 1;
    presets: ImageGenerationPreset[];
    activePresetIds: Partial<Record<BuiltinImageEngineId, string>>;
}

export interface ImageGenerationBackupLocal {
    version: 1;
    builtinSettings: BuiltinImageSettings;
    presetState: ImageGenerationPresetState;
    mcpLocal?: Record<string, string>;
}

const EMPTY_STATE: ImageGenerationPresetState = { version: 1, presets: [], activePresetIds: {} };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const normalizeName = (name: string): string => {
    const value = name.trim();
    if (!value) throw new Error('预设名称不能为空');
    return value.slice(0, 80);
};

const normalizeBinding = (binding: BuiltinImageBinding): ImagePresetBinding => ({
    mcpUrl: String(binding.mcpUrl || '').trim(),
    controlBaseUrl: String(binding.controlBaseUrl || '').trim(),
    token: String(binding.token || ''),
    enabled: binding.enabled === true,
    tools: Array.isArray(binding.tools) ? clone(binding.tools) : [],
});

export function stripImageRemoteRuntimeFields(remote: ImageRemoteConfig): StoredImageRemoteConfig {
    const { revision: _revision, apiKeyConfigured: _configured, apiKeyHint: _hint, ...stored } = remote as any;
    return clone(stored) as StoredImageRemoteConfig;
}

const isEngineId = (value: unknown): value is BuiltinImageEngineId => value === 'gpt-image' || value === 'novelai';

const sanitizePreset = (value: unknown): ImageGenerationPreset | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as any;
    if (!isEngineId(raw.engineId) || !raw.remoteConfig || typeof raw.remoteConfig !== 'object') return null;
    const now = Date.now();
    const binding = raw.binding || {};
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `imgpreset_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : '未命名预设',
        engineId: raw.engineId,
        binding: {
            mcpUrl: String(binding.mcpUrl || ''),
            controlBaseUrl: String(binding.controlBaseUrl || ''),
            token: String(binding.token || ''),
            enabled: binding.enabled === true,
            tools: Array.isArray(binding.tools) ? clone(binding.tools) : [],
        },
        remoteConfig: clone(raw.remoteConfig),
        apiKey: String(raw.apiKey || ''),
        pricing: raw.pricing,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
    };
};

export function loadImageGenerationPresetState(): ImageGenerationPresetState {
    try {
        const raw = localStorage.getItem(IMAGE_PRESET_STATE_KEY);
        if (!raw) return clone(EMPTY_STATE);
        const parsed = JSON.parse(raw);
        const presets = Array.isArray(parsed?.presets)
            ? parsed.presets.map(sanitizePreset).filter(Boolean) as ImageGenerationPreset[]
            : [];
        const ids = new Set(presets.map(item => item.id));
        const activePresetIds: ImageGenerationPresetState['activePresetIds'] = {};
        for (const engineId of ['gpt-image', 'novelai'] as BuiltinImageEngineId[]) {
            const id = parsed?.activePresetIds?.[engineId];
            if (typeof id === 'string' && ids.has(id) && presets.some(item => item.id === id && item.engineId === engineId)) {
                activePresetIds[engineId] = id;
            }
        }
        return { version: 1, presets, activePresetIds };
    } catch {
        return clone(EMPTY_STATE);
    }
}

export function saveImageGenerationPresetState(state: ImageGenerationPresetState): void {
    localStorage.setItem(IMAGE_PRESET_STATE_KEY, JSON.stringify({
        version: 1,
        presets: state.presets,
        activePresetIds: state.activePresetIds,
    }));
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sullyos:image-generation-presets-changed'));
}

export function getImageGenerationPresets(engineId?: BuiltinImageEngineId): ImageGenerationPreset[] {
    const items = loadImageGenerationPresetState().presets;
    return engineId ? items.filter(item => item.engineId === engineId) : items;
}

export function getActiveImageGenerationPreset(engineId: BuiltinImageEngineId): ImageGenerationPreset | null {
    const state = loadImageGenerationPresetState();
    const id = state.activePresetIds[engineId];
    return id ? state.presets.find(item => item.id === id && item.engineId === engineId) || null : null;
}

export function createImageGenerationPreset(input: {
    name: string;
    engineId: BuiltinImageEngineId;
    binding: BuiltinImageBinding;
    remoteConfig: ImageRemoteConfig;
    apiKey: string;
    pricing?: ApiPricing;
}): ImageGenerationPreset {
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error('请先输入 API Key，再保存生图预设');
    const now = Date.now();
    const preset: ImageGenerationPreset = {
        id: `imgpreset_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: normalizeName(input.name),
        engineId: input.engineId,
        binding: normalizeBinding(input.binding),
        remoteConfig: stripImageRemoteRuntimeFields(input.remoteConfig),
        apiKey,
        pricing: input.pricing,
        createdAt: now,
        updatedAt: now,
    };
    const state = loadImageGenerationPresetState();
    state.presets.push(preset);
    state.activePresetIds[input.engineId] = preset.id;
    saveImageGenerationPresetState(state);
    return preset;
}

export function updateImageGenerationPreset(id: string, input: {
    binding: BuiltinImageBinding;
    remoteConfig: ImageRemoteConfig;
    apiKey: string;
    pricing?: ApiPricing;
}): ImageGenerationPreset {
    const state = loadImageGenerationPresetState();
    const index = state.presets.findIndex(item => item.id === id);
    if (index < 0) throw new Error('生图预设不存在');
    const previous = state.presets[index];
    const nextKey = input.apiKey.trim() || previous.apiKey;
    if (!nextKey) throw new Error('当前没有可保存的 API Key');
    const updated: ImageGenerationPreset = {
        ...previous,
        binding: normalizeBinding(input.binding),
        remoteConfig: stripImageRemoteRuntimeFields(input.remoteConfig),
        apiKey: nextKey,
        pricing: input.pricing ?? previous.pricing,
        updatedAt: Date.now(),
    };
    state.presets[index] = updated;
    saveImageGenerationPresetState(state);
    return updated;
}

export function renameImageGenerationPreset(id: string, name: string): void {
    const state = loadImageGenerationPresetState();
    const index = state.presets.findIndex(item => item.id === id);
    if (index < 0) throw new Error('生图预设不存在');
    state.presets[index] = { ...state.presets[index], name: normalizeName(name), updatedAt: Date.now() };
    saveImageGenerationPresetState(state);
}

export function deleteImageGenerationPreset(id: string): void {
    const state = loadImageGenerationPresetState();
    const target = state.presets.find(item => item.id === id);
    if (!target) return;
    state.presets = state.presets.filter(item => item.id !== id);
    if (state.activePresetIds[target.engineId] === id) delete state.activePresetIds[target.engineId];
    saveImageGenerationPresetState(state);
}

const mergeBindingIntoSettings = (
    settings: BuiltinImageSettings,
    engineId: BuiltinImageEngineId,
    preset: ImageGenerationPreset,
): BuiltinImageSettings => ({
    ...settings,
    engines: {
        ...settings.engines,
        [engineId]: {
            ...settings.engines[engineId],
            id: engineId,
            ...clone(preset.binding),
            updatedAt: Date.now(),
        },
    },
});

export async function applyImageGenerationPreset(preset: ImageGenerationPreset): Promise<{
    settings: BuiltinImageSettings;
    remote: ImageRemoteConfig;
}> {
    const temporarySettings = mergeBindingIntoSettings(loadBuiltinImageSettings(), preset.engineId, preset);
    const temporaryBinding = temporarySettings.engines[preset.engineId];
    const currentRemote = await fetchBuiltinImageRemoteConfig(temporaryBinding);
    const remote = await updateBuiltinImageRemoteConfig(temporaryBinding, {
        expectedRevision: currentRemote.revision,
        patch: clone(preset.remoteConfig) as Record<string, unknown>,
        apiKey: preset.apiKey,
    });
    saveBuiltinImageSettings(temporarySettings);
    resetMcpSession(`builtin_image_${preset.engineId}`);
    const state = loadImageGenerationPresetState();
    state.activePresetIds[preset.engineId] = preset.id;
    saveImageGenerationPresetState(state);
    return { settings: temporarySettings, remote };
}

export function exportImageGenerationLocal(): ImageGenerationBackupLocal {
    return {
        version: 1,
        builtinSettings: clone(loadBuiltinImageSettings()),
        presetState: clone(loadImageGenerationPresetState()),
        mcpLocal: exportMcpLocal(),
    };
}

export type ImageGenerationBackupMode = 'text_only' | 'media_only' | 'full';

export function exportImageGenerationLocalForMode(
    mode: ImageGenerationBackupMode,
): ImageGenerationBackupLocal | undefined {
    return mode === 'full' || mode === 'text_only'
        ? exportImageGenerationLocal()
        : undefined;
}

export function importImageGenerationLocal(data: ImageGenerationBackupLocal | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    if (data.builtinSettings?.version === 1 && data.builtinSettings.engines) {
        saveBuiltinImageSettings(clone(data.builtinSettings));
    }
    if (data.presetState?.version === 1) {
        const presets = Array.isArray(data.presetState.presets)
            ? data.presetState.presets.map(sanitizePreset).filter(Boolean) as ImageGenerationPreset[]
            : [];
        const ids = new Set(presets.map(item => item.id));
        const activePresetIds: ImageGenerationPresetState['activePresetIds'] = {};
        for (const engineId of ['gpt-image', 'novelai'] as BuiltinImageEngineId[]) {
            const id = data.presetState.activePresetIds?.[engineId];
            if (typeof id === 'string' && ids.has(id) && presets.some(item => item.id === id && item.engineId === engineId)) {
                activePresetIds[engineId] = id;
            }
        }
        saveImageGenerationPresetState({ version: 1, presets, activePresetIds });
    }
    if (data.mcpLocal) importMcpLocal(data.mcpLocal);
    resetMcpSession('builtin_image_gpt-image');
    resetMcpSession('builtin_image_novelai');
}
