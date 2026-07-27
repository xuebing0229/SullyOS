import type { McpServerConfig, McpToolDef } from './mcpClient';

export type BuiltinImageEngineId = 'gpt-image' | 'novelai';

export interface BuiltinImageBinding {
    id: BuiltinImageEngineId;
    enabled: boolean;
    mcpUrl: string;
    controlBaseUrl: string;
    token: string;
    tools: McpToolDef[];
    updatedAt: number;
}

export interface BuiltinImageSettings {
    version: 1;
    engines: Record<BuiltinImageEngineId, BuiltinImageBinding>;
}

export interface GptImageRemoteConfig {
    version: 1;
    revision: number;
    mode: 'compatible' | 'custom';
    baseUrl: string;
    model: string;
    imageDelivery: 'auto' | 'direct' | 'proxy';
    custom: {
        generatePath: string;
        authHeader: string;
        authPrefix: string;
        responseMode: 'auto' | 'json' | 'image';
        requestFields: {
            prompt: string;
            model: string;
            size: string;
            quality: string;
            background: string;
            outputFormat: string;
        };
        responseUrlPaths: string[];
        responseBase64Paths: string[];
        extraHeaders: Record<string, string | number | boolean>;
        extraBody: Record<string, unknown>;
    };
    apiKeyConfigured: boolean;
    apiKeyHint: string | null;
}

export interface NovelAiRemoteConfig {
    version: 1;
    revision: number;
    profile: 'official' | 'standard' | 'custom';
    baseUrl: string;
    generatePath: string;
    authHeader: string;
    authPrefix: string;
    modelFull: string;
    modelCurated: string;
    responseMode: 'auto' | 'json' | 'image' | 'zip';
    imageDelivery: 'auto' | 'direct' | 'proxy';
    promptLanguagePolicy: 'allow' | 'english-only';
    apiKeyConfigured: boolean;
    apiKeyHint: string | null;
}

export type ImageRemoteConfig = GptImageRemoteConfig | NovelAiRemoteConfig;

const SETTINGS_KEY = 'aetheros.imageGeneration.builtin.v1';
export const BUILTIN_IMAGE_MCP_REQUEST_TIMEOUT_MS = 240_000;

const DEFAULTS: BuiltinImageSettings = {
    version: 1,
    engines: {
        'gpt-image': {
            id: 'gpt-image',
            enabled: false,
            mcpUrl: 'https://ag.apixb.top/mcp',
            controlBaseUrl: 'https://ag.apixb.top/gpt-image',
            token: '',
            tools: [],
            updatedAt: 0,
        },
        novelai: {
            id: 'novelai',
            enabled: false,
            mcpUrl: 'https://ag.apixb.top/novelai/mcp',
            controlBaseUrl: 'https://ag.apixb.top/novelai',
            token: '',
            tools: [],
            updatedAt: 0,
        },
    },
};

const cloneDefaults = (): BuiltinImageSettings => JSON.parse(JSON.stringify(DEFAULTS));

export function loadBuiltinImageSettings(): BuiltinImageSettings {
    const fallback = cloneDefaults();
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== 1 || typeof parsed.engines !== 'object') return fallback;
        for (const id of ['gpt-image', 'novelai'] as BuiltinImageEngineId[]) {
            const source = parsed.engines[id] || {};
            fallback.engines[id] = {
                ...fallback.engines[id],
                ...source,
                id,
                enabled: source.enabled === true,
                token: typeof source.token === 'string' ? source.token : '',
                tools: Array.isArray(source.tools) ? source.tools : [],
                updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
            };
        }
        return fallback;
    } catch {
        return fallback;
    }
}

export function saveBuiltinImageSettings(settings: BuiltinImageSettings): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sullyos:builtin-image-mcp-changed'));
    }
}

export function updateBuiltinImageBinding(
    id: BuiltinImageEngineId,
    patch: Partial<BuiltinImageBinding>,
): BuiltinImageSettings {
    const current = loadBuiltinImageSettings();
    current.engines[id] = {
        ...current.engines[id],
        ...patch,
        id,
        updatedAt: Date.now(),
    };
    saveBuiltinImageSettings(current);
    return current;
}

export function getBuiltinImageMcpServers(): McpServerConfig[] {
    const settings = loadBuiltinImageSettings();
    const names: Record<BuiltinImageEngineId, string> = {
        'gpt-image': 'GPT 生图',
        novelai: 'NovelAI 生图',
    };
    return (Object.keys(settings.engines) as BuiltinImageEngineId[]).map(id => {
        const binding = settings.engines[id];
        return {
            id: `builtin_image_${id}`,
            name: names[id],
            url: binding.mcpUrl,
            controlBaseUrl: binding.controlBaseUrl,
            token: binding.token,
            enabled: binding.enabled,
            tools: binding.tools,
            updatedAt: binding.updatedAt,
            builtin: true,
            requestTimeoutMs: BUILTIN_IMAGE_MCP_REQUEST_TIMEOUT_MS,
        } satisfies McpServerConfig;
    });
}

function controlUrl(binding: BuiltinImageBinding, path: string): string {
    return `${binding.controlBaseUrl.trim().replace(/\/+$/, '')}${path}`;
}

async function readJsonResponse(response: Response): Promise<any> {
    const text = await response.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    if (!response.ok) {
        const message = parsed?.message || parsed?.error || text.slice(0, 300) || `HTTP ${response.status}`;
        throw new Error(String(message));
    }
    return parsed;
}

async function controlRequest(
    binding: BuiltinImageBinding,
    path: string,
    init: RequestInit = {},
): Promise<any> {
    if (!binding.token.trim()) throw new Error('请先填写生图 MCP Token');
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${binding.token.trim()}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
        response = await fetch(controlUrl(binding, path), { ...init, headers });
    } catch (error: any) {
        throw new Error(`无法连接生图服务：${error?.message || String(error)}。请检查地址与 CORS。`);
    }
    return readJsonResponse(response);
}

export async function fetchBuiltinImageRemoteConfig(
    binding: BuiltinImageBinding,
): Promise<ImageRemoteConfig> {
    return controlRequest(binding, '/config');
}

export interface UpdateRemoteConfigPayload {
    expectedRevision?: number;
    patch?: Record<string, unknown>;
    apiKey?: string;
    clearApiKey?: boolean;
}

export async function updateBuiltinImageRemoteConfig(
    binding: BuiltinImageBinding,
    payload: UpdateRemoteConfigPayload,
): Promise<ImageRemoteConfig> {
    return controlRequest(binding, '/config', {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export async function testBuiltinImageRemoteConfig(
    binding: BuiltinImageBinding,
    mode: 'validate' | 'generate' = 'validate',
    draft?: UpdateRemoteConfigPayload,
): Promise<{ ok: boolean; message: string; imageUrl?: string }> {
    return controlRequest(binding, '/config/test', {
        method: 'POST',
        body: JSON.stringify({ ...(draft || {}), mode }),
    });
}

/**
 * 内置生图 binding 会随 SullyOS full / text_only 备份导出。
 * 用户已明确允许 MCP Token 与生图 API Key 进入私人备份。
 * 仍禁止把密钥写入聊天、Prompt、日志、Git 或错误文本。
 */
export function clearBuiltinImageSettings(): void {
    localStorage.removeItem(SETTINGS_KEY);
    window.dispatchEvent(new CustomEvent('sullyos:builtin-image-mcp-changed'));
}
