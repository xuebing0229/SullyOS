import {
    BUILTIN_IMAGE_MCP_REQUEST_TIMEOUT_MS,
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
    type McpServerConfig,
    type McpToolDef,
} from './mcpClient';
import {
    exportVibeReferenceLibrary,
    importVibeReferenceLibrary,
    type VibeReferenceLibrary,
} from './vibeReference';

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

export interface ImageGenerationPriceAddon {
    enabled: boolean;
    pricePerRequestYuan: string;
}

export interface ImageGenerationPricing {
    enabled: boolean;
    basePricePerRequestYuan: string;
    addons: {
        characterReference: ImageGenerationPriceAddon;
        vibeReference: ImageGenerationPriceAddon;
    };
}

export const EMPTY_IMAGE_GENERATION_PRICING: ImageGenerationPricing = {
    enabled: false,
    basePricePerRequestYuan: '',
    addons: {
        characterReference: { enabled: false, pricePerRequestYuan: '' },
        vibeReference: { enabled: false, pricePerRequestYuan: '' },
    },
};

export interface ImageGenerationPreset {
    id: string;
    name: string;
    engineId: BuiltinImageEngineId;
    binding: ImagePresetBinding;
    remoteConfig: StoredImageRemoteConfig;
    apiKey: string;
    /** 用户手填：这个预设适合画什么，供角色在同一次工具调用里自主选择。 */
    purpose: string;
    pricing: ImageGenerationPricing;
    /** Whether main chat may choose the character reference for a NovelAI request. */
    allowCharacterReference: boolean;
    createdAt: number;
    updatedAt: number;
}

export type ImageGenerationPresetSelectionMode = 'manual' | 'character-auto';

export interface ImageGenerationPresetState {
    version: 1;
    presets: ImageGenerationPreset[];
    activePresetIds: Partial<Record<BuiltinImageEngineId, string>>;
    selectionMode: ImageGenerationPresetSelectionMode;
}

export interface ImageGenerationBackupLocal {
    version: 1;
    builtinSettings: BuiltinImageSettings;
    presetState: ImageGenerationPresetState;
    mcpLocal?: Record<string, string>;
    /** Full backups only: metadata plus blobref pointers for the reusable Vibe library. */
    vibeLibrary?: VibeReferenceLibrary;
}

const EMPTY_STATE: ImageGenerationPresetState = { version: 1, presets: [], activePresetIds: {}, selectionMode: 'manual' };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export const normalizeImageGenerationPricing = (value: unknown): ImageGenerationPricing => {
    const raw = value && typeof value === 'object' ? value as any : {};
    const addons = raw.addons && typeof raw.addons === 'object' ? raw.addons : {};
    const normalizeAddon = (addon: any): ImageGenerationPriceAddon => ({
        enabled: addon?.enabled === true,
        pricePerRequestYuan: typeof addon?.pricePerRequestYuan === 'string' ? addon.pricePerRequestYuan : '',
    });
    return {
        enabled: raw.enabled === true,
        basePricePerRequestYuan: typeof raw.basePricePerRequestYuan === 'string' ? raw.basePricePerRequestYuan : '',
        addons: {
            characterReference: normalizeAddon(addons.characterReference),
            vibeReference: normalizeAddon(addons.vibeReference),
        },
    };
};

const isValidYuanPrice = (value: string): boolean => /^\d+(?:\.\d{0,6})?$/.test(value.trim());
const validateImageGenerationPricing = (pricing: ImageGenerationPricing): void => {
    if (!pricing.enabled) return;
    if (!isValidYuanPrice(pricing.basePricePerRequestYuan)) throw new Error('请填写有效的生图基础单次价格');
    if (pricing.addons.characterReference.enabled && !isValidYuanPrice(pricing.addons.characterReference.pricePerRequestYuan)) {
        throw new Error('请填写有效的角色参考图附加价');
    }
    if (pricing.addons.vibeReference.enabled && !isValidYuanPrice(pricing.addons.vibeReference.pricePerRequestYuan)) {
        throw new Error('请填写有效的 Vibe 参考附加价');
    }
};

const normalizeName = (name: string): string => {
    const value = name.trim();
    if (!value) throw new Error('预设名称不能为空');
    return value.slice(0, 80);
};

const normalizePurpose = (purpose: unknown): string =>
    typeof purpose === 'string'
        ? purpose.trim().slice(0, 600)
        : '';

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
        purpose: normalizePurpose(raw.purpose),
        pricing: normalizeImageGenerationPricing(raw.pricing),
        // Missing means an old preset. Preserve the behavior those presets had.
        allowCharacterReference: raw.allowCharacterReference !== false,
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
        const selectionMode: ImageGenerationPresetSelectionMode =
            parsed?.selectionMode === 'character-auto'
                ? 'character-auto'
                : 'manual';
        return { version: 1, presets, activePresetIds, selectionMode };
    } catch {
        return clone(EMPTY_STATE);
    }
}

export function saveImageGenerationPresetState(state: ImageGenerationPresetState): void {
    localStorage.setItem(IMAGE_PRESET_STATE_KEY, JSON.stringify({
        version: 1,
        presets: state.presets,
        activePresetIds: state.activePresetIds,
        selectionMode: state.selectionMode,
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

export function getImageGenerationSelectionMode(): ImageGenerationPresetSelectionMode {
    return loadImageGenerationPresetState().selectionMode;
}

export function setImageGenerationSelectionMode(
    selectionMode: ImageGenerationPresetSelectionMode,
): ImageGenerationPresetState {
    const state = loadImageGenerationPresetState();
    state.selectionMode = selectionMode;
    saveImageGenerationPresetState(state);
    return state;
}

const isCharacterAutoPresetRuntimeReady = (
    preset: ImageGenerationPreset,
): boolean => Boolean(
    preset.binding.enabled
    && preset.binding.mcpUrl.trim()
    && preset.binding.controlBaseUrl.trim()
    && preset.binding.token.trim()
    && preset.binding.tools.length > 0
    && preset.apiKey.trim()
);

export function getCharacterAutoImageGenerationPresets(): ImageGenerationPreset[] {
    return loadImageGenerationPresetState().presets.filter(isCharacterAutoPresetRuntimeReady);
}

export function isCharacterAutoImagePresetSelectionEnabled(): boolean {
    return getImageGenerationSelectionMode() === 'character-auto'
        && getCharacterAutoImageGenerationPresets().length > 0;
}

export function getCharacterAutoImageMcpServers(): McpServerConfig[] {
    if (getImageGenerationSelectionMode() !== 'character-auto') return [];
    return getCharacterAutoImageGenerationPresets().map(preset => ({
        id: `builtin_image_preset_${preset.id}`,
        name: `生图预设「${preset.name}」`,
        url: preset.binding.mcpUrl,
        controlBaseUrl: preset.binding.controlBaseUrl,
        token: preset.binding.token,
        enabled: true,
        tools: clone(preset.binding.tools),
        updatedAt: preset.updatedAt,
        builtin: true,
        requestTimeoutMs: BUILTIN_IMAGE_MCP_REQUEST_TIMEOUT_MS,
        imagePresetId: preset.id,
        imagePresetPurpose: preset.purpose,
        imagePresetEngineId: preset.engineId,
        imagePresetAllowCharacterReference: preset.allowCharacterReference,
    }));
}

/** No active/legacy preset keeps the pre-existing opt-in-per-request behavior. */
export function isCharacterReferenceAllowedForActivePreset(): boolean {
    if (getImageGenerationSelectionMode() === 'character-auto') {
        return getCharacterAutoImageGenerationPresets()
            .filter(item => item.engineId === 'novelai')
            .some(item => item.allowCharacterReference !== false);
    }
    return getActiveImageGenerationPreset('novelai')?.allowCharacterReference !== false;
}

export function createImageGenerationPreset(input: {
    name: string;
    engineId: BuiltinImageEngineId;
    binding: BuiltinImageBinding;
    remoteConfig: ImageRemoteConfig;
    apiKey: string;
    purpose?: string;
    pricing?: ImageGenerationPricing;
    allowCharacterReference?: boolean;
}): ImageGenerationPreset {
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error('请先输入 API Key，再保存生图预设');
    const now = Date.now();
    const pricing = normalizeImageGenerationPricing(input.pricing);
    validateImageGenerationPricing(pricing);
    const preset: ImageGenerationPreset = {
        id: `imgpreset_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: normalizeName(input.name),
        engineId: input.engineId,
        binding: normalizeBinding(input.binding),
        remoteConfig: stripImageRemoteRuntimeFields(input.remoteConfig),
        apiKey,
        purpose: normalizePurpose(input.purpose),
        pricing,
        allowCharacterReference: input.allowCharacterReference !== false,
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
    purpose?: string;
    pricing?: ImageGenerationPricing;
    allowCharacterReference?: boolean;
}): ImageGenerationPreset {
    const state = loadImageGenerationPresetState();
    const index = state.presets.findIndex(item => item.id === id);
    if (index < 0) throw new Error('生图预设不存在');
    const previous = state.presets[index];
    const nextKey = input.apiKey.trim() || previous.apiKey;
    if (!nextKey) throw new Error('当前没有可保存的 API Key');
    const pricing = normalizeImageGenerationPricing(input.pricing ?? previous.pricing);
    validateImageGenerationPricing(pricing);
    const updated: ImageGenerationPreset = {
        ...previous,
        binding: normalizeBinding(input.binding),
        remoteConfig: stripImageRemoteRuntimeFields(input.remoteConfig),
        apiKey: nextKey,
        purpose: input.purpose === undefined ? previous.purpose : normalizePurpose(input.purpose),
        pricing,
        allowCharacterReference: input.allowCharacterReference ?? previous.allowCharacterReference,
        updatedAt: Date.now(),
    };
    state.presets[index] = updated;
    saveImageGenerationPresetState(state);
    return updated;
}

export function updateImageGenerationPresetPurpose(id: string, purpose: string): ImageGenerationPreset {
    const state = loadImageGenerationPresetState();
    const index = state.presets.findIndex(item => item.id === id);
    if (index < 0) throw new Error('生图预设不存在');
    const updated = {
        ...state.presets[index],
        purpose: normalizePurpose(purpose),
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

export async function applyImageGenerationPresetById(id: string): Promise<{
    settings: BuiltinImageSettings;
    remote: ImageRemoteConfig;
}> {
    const preset = loadImageGenerationPresetState().presets.find(item => item.id === id);
    if (!preset) throw new Error('角色选择的生图预设不存在');
    if (!isCharacterAutoPresetRuntimeReady(preset)) throw new Error(`生图预设「${preset.name}」当前配置不完整`);
    return applyImageGenerationPreset(preset);
}

export function exportImageGenerationLocal(includeVibeLibrary = true): ImageGenerationBackupLocal {
    return {
        version: 1,
        builtinSettings: clone(loadBuiltinImageSettings()),
        presetState: clone(loadImageGenerationPresetState()),
        mcpLocal: exportMcpLocal(),
        vibeLibrary: includeVibeLibrary ? exportVibeReferenceLibrary() : undefined,
    };
}

export type ImageGenerationBackupMode = 'text_only' | 'media_only' | 'full';

export function exportImageGenerationLocalForMode(
    mode: ImageGenerationBackupMode,
): ImageGenerationBackupLocal | undefined {
    return mode === 'full' || mode === 'text_only'
        ? exportImageGenerationLocal(mode === 'full')
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
        const selectionMode: ImageGenerationPresetSelectionMode =
            data.presetState.selectionMode === 'character-auto'
                ? 'character-auto'
                : 'manual';
        saveImageGenerationPresetState({ version: 1, presets, activePresetIds, selectionMode });
    }
    if (data.mcpLocal) importMcpLocal(data.mcpLocal);
    if (data.vibeLibrary) importVibeReferenceLibrary(data.vibeLibrary);
    resetMcpSession('builtin_image_gpt-image');
    resetMcpSession('builtin_image_novelai');
}
