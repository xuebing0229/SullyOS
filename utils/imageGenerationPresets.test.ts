import { beforeEach, describe, expect, it } from 'vitest';
import {
    createImageGenerationPreset,
    exportImageGenerationLocal,
    exportImageGenerationLocalForMode,
    getActiveImageGenerationPreset,
    importImageGenerationLocal,
    loadImageGenerationPresetState,
} from './imageGenerationPresets';
import { loadBuiltinImageSettings } from './builtinImageMcp';

describe('image generation presets', () => {
    beforeEach(() => localStorage.clear());

    it('stores GPT API key and MCP token without runtime-only remote fields', () => {
        const settings = loadBuiltinImageSettings();
        createImageGenerationPreset({
            name: 'GPT 站子',
            engineId: 'gpt-image',
            binding: { ...settings.engines['gpt-image'], token: 'mcp-secret' },
            apiKey: 'upstream-secret',
            remoteConfig: {
                version: 1,
                revision: 3,
                mode: 'compatible',
                baseUrl: 'https://example.test/v1',
                model: 'gpt-image-2',
                imageDelivery: 'auto',
                custom: {
                    generatePath: '/images/generations', authHeader: 'Authorization', authPrefix: 'Bearer ', responseMode: 'auto',
                    requestFields: { prompt: 'prompt', model: 'model', size: 'size', quality: 'quality', background: 'background', outputFormat: 'output_format' },
                    responseUrlPaths: ['data.0.url'], responseBase64Paths: ['data.0.b64_json'], extraHeaders: {}, extraBody: {},
                },
                apiKeyConfigured: true,
                apiKeyHint: '****',
            },
        });
        const active = getActiveImageGenerationPreset('gpt-image');
        expect(active?.apiKey).toBe('upstream-secret');
        expect(active?.binding.token).toBe('mcp-secret');
        expect(active?.remoteConfig).not.toHaveProperty('revision');
        expect(active?.remoteConfig).not.toHaveProperty('apiKeyHint');
    });

    it('round trips presets, active ids, builtin token and generic MCP secrets', () => {
        const settings = loadBuiltinImageSettings();
        localStorage.setItem('aetheros.mcp.servers', JSON.stringify([{ id: 'x', token: 'bearer-secret', headers: { 'X-Key': 'header-secret' }, proxyKey: 'proxy-secret' }]));
        createImageGenerationPreset({
            name: 'NovelAI 官方', engineId: 'novelai',
            binding: { ...settings.engines.novelai, token: 'novel-mcp-token' },
            apiKey: 'novel-upstream-key',
            remoteConfig: {
                version: 1, revision: 5, profile: 'official', baseUrl: 'https://api.novelai.net', generatePath: '/ai/generate-image',
                authHeader: 'Authorization', authPrefix: 'Bearer ', modelFull: 'nai-diffusion-4-full', modelCurated: 'nai-diffusion-4-curated-preview',
                responseMode: 'zip', imageDelivery: 'auto', promptLanguagePolicy: 'english-only', apiKeyConfigured: true, apiKeyHint: '****',
            },
        });
        const exported = exportImageGenerationLocal();
        expect(exported.builtinSettings.preferredEngine).toBeNull();
        exported.builtinSettings.preferredEngine = 'novelai';
        localStorage.clear();
        importImageGenerationLocal(exported);
        const state = loadImageGenerationPresetState();
        expect(state.presets[0].apiKey).toBe('novel-upstream-key');
        expect(state.presets[0].binding.token).toBe('novel-mcp-token');
        expect(state.presets[0].pricing.enabled).toBe(false);
        expect(state.activePresetIds.novelai).toBe(state.presets[0].id);
        expect(loadBuiltinImageSettings().preferredEngine).toBe('novelai');
        expect(localStorage.getItem('aetheros.mcp.servers')).toContain('proxy-secret');
    });
    it('backs up per-request image pricing and add-on pricing with the preset', () => {
        const settings = loadBuiltinImageSettings();
        createImageGenerationPreset({
            name: '计价线路', engineId: 'novelai', binding: settings.engines.novelai, apiKey: 'secret',
            remoteConfig: {
                version: 1, revision: 1, profile: 'custom', baseUrl: 'https://example.test/v1', generatePath: '/generate', modelsPath: '/models',
                authHeader: 'Authorization', authPrefix: 'Bearer', modelFull: 'full-id', modelCurated: 'curated-id', responseMode: 'json', imageDelivery: 'auto', promptLanguagePolicy: 'allow', apiKeyConfigured: true, apiKeyHint: '***',
            },
            pricing: {
                enabled: true, basePricePerRequestYuan: '0.25',
                addons: {
                    characterReference: { enabled: true, pricePerRequestYuan: '0.10' },
                    vibeReference: { enabled: true, pricePerRequestYuan: '0.05' },
                },
            },
        });
        const exported = exportImageGenerationLocalForMode('text_only')!;
        expect(exported.presetState.presets[0].pricing).toMatchObject({
            enabled: true, basePricePerRequestYuan: '0.25',
            addons: { characterReference: { pricePerRequestYuan: '0.10' }, vibeReference: { pricePerRequestYuan: '0.05' } },
        });
    });
    it('rejects an enabled pricing preset with a missing price', () => {
        const settings = loadBuiltinImageSettings();
        expect(() => createImageGenerationPreset({
            name: '坏价格', engineId: 'novelai', binding: settings.engines.novelai, apiKey: 'secret',
            remoteConfig: {
                version: 1, revision: 1, profile: 'custom', baseUrl: 'https://example.test', generatePath: '/generate',
                authHeader: 'Authorization', authPrefix: 'Bearer', modelFull: 'full', modelCurated: 'curated', responseMode: 'json', imageDelivery: 'auto', promptLanguagePolicy: 'allow', apiKeyConfigured: true, apiKeyHint: '***',
            },
            pricing: { enabled: true, basePricePerRequestYuan: '', addons: { characterReference: { enabled: false, pricePerRequestYuan: '' }, vibeReference: { enabled: false, pricePerRequestYuan: '' } } },
        })).toThrow('基础单次价格');
    });
    it('includes secrets in full/text backups and excludes them from media-only backups', () => {
        const settings = loadBuiltinImageSettings();
        createImageGenerationPreset({
            name: '模式测试', engineId: 'gpt-image', binding: { ...settings.engines['gpt-image'], token: 'mode-mcp-secret' }, apiKey: 'mode-api-secret',
            remoteConfig: {
                version: 1, revision: 1, mode: 'compatible', baseUrl: 'https://example.test/v1', model: 'gpt-image-1', imageDelivery: 'auto',
                custom: { generatePath: '/images/generations', authHeader: 'Authorization', authPrefix: 'Bearer ', responseMode: 'auto', requestFields: { prompt: 'prompt', model: 'model', size: 'size', quality: 'quality', background: 'background', outputFormat: 'output_format' }, responseUrlPaths: [], responseBase64Paths: [], extraHeaders: {}, extraBody: {} }, apiKeyConfigured: true, apiKeyHint: '***',
            },
        });
        expect(exportImageGenerationLocalForMode('full')?.presetState.presets[0].apiKey).toBe('mode-api-secret');
        expect(exportImageGenerationLocalForMode('text_only')?.presetState.presets[0].binding.token).toBe('mode-mcp-secret');
        expect(exportImageGenerationLocalForMode('media_only')).toBeUndefined();
    });

});
