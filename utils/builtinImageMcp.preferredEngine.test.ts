import { beforeEach, describe, expect, it } from 'vitest';
import {
    BUILTIN_IMAGE_SETTINGS_KEY,
    getBuiltinImageMcpServers,
    loadBuiltinImageSettings,
    updateBuiltinImageBinding,
} from './builtinImageMcp';

const gptTool = {
    name: 'generate_image',
    description: 'Generate an image',
    inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
    },
};
const novelTool = {
    name: 'novelai_generate_image',
    description: 'Generate a NovelAI image',
    inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
    },
};
const writeRaw = (value: unknown) => {
    localStorage.setItem(BUILTIN_IMAGE_SETTINGS_KEY, JSON.stringify(value));
};

describe('builtin image preferred engine migration', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('migrates legacy GPT config with no preferredEngine', () => {
        writeRaw({
            version: 1,
            engines: {
                'gpt-image': {
                    id: 'gpt-image', enabled: true,
                    mcpUrl: 'https://example.test/mcp',
                    controlBaseUrl: 'https://example.test/gpt-image',
                    token: 'token', tools: [gptTool], updatedAt: 1,
                },
                novelai: {
                    id: 'novelai', enabled: false,
                    mcpUrl: 'https://example.test/novelai/mcp',
                    controlBaseUrl: 'https://example.test/novelai',
                    token: '', tools: [], updatedAt: 0,
                },
            },
        });
        const settings = loadBuiltinImageSettings();
        expect(settings.preferredEngine).toBe('gpt-image');
        const persisted = JSON.parse(
            localStorage.getItem(BUILTIN_IMAGE_SETTINGS_KEY)!,
        );
        expect(persisted.preferredEngine).toBe('gpt-image');
        const servers = getBuiltinImageMcpServers();
        expect(servers).toHaveLength(1);
        expect(servers[0].id).toBe('builtin_image_gpt-image');
        expect(servers[0].tools?.[0]?.name).toBe('generate_image');
    });

    it('migrates legacy NovelAI config when only NovelAI is usable', () => {
        writeRaw({
            version: 1,
            engines: {
                'gpt-image': { id: 'gpt-image', enabled: false, tools: [] },
                novelai: {
                    id: 'novelai', enabled: true,
                    mcpUrl: 'https://example.test/novelai/mcp',
                    controlBaseUrl: 'https://example.test/novelai',
                    token: 'token', tools: [novelTool], updatedAt: 1,
                },
            },
        });
        expect(loadBuiltinImageSettings().preferredEngine).toBe('novelai');
        const servers = getBuiltinImageMcpServers();
        expect(servers).toHaveLength(1);
        expect(servers[0].id).toBe('builtin_image_novelai');
        expect(servers[0].tools?.[0]?.name).toBe('novelai_generate_image');
    });

    it('uses deterministic GPT-first migration when both legacy engines are usable', () => {
        writeRaw({
            version: 1,
            engines: {
                'gpt-image': { id: 'gpt-image', enabled: true, tools: [gptTool] },
                novelai: { id: 'novelai', enabled: true, tools: [novelTool] },
            },
        });
        expect(loadBuiltinImageSettings().preferredEngine).toBe('gpt-image');
    });

    it('does not overwrite an explicit valid preferredEngine', () => {
        writeRaw({
            version: 1,
            preferredEngine: 'novelai',
            engines: {
                'gpt-image': { id: 'gpt-image', enabled: true, tools: [gptTool] },
                novelai: { id: 'novelai', enabled: true, tools: [novelTool] },
            },
        });
        expect(loadBuiltinImageSettings().preferredEngine).toBe('novelai');
        expect(getBuiltinImageMcpServers()[0].id).toBe('builtin_image_novelai');
    });

    it('does not silently switch away from an explicitly selected disabled engine', () => {
        writeRaw({
            version: 1,
            preferredEngine: 'gpt-image',
            engines: {
                'gpt-image': { id: 'gpt-image', enabled: false, tools: [gptTool] },
                novelai: { id: 'novelai', enabled: true, tools: [novelTool] },
            },
        });
        const servers = getBuiltinImageMcpServers();
        expect(servers).toHaveLength(1);
        expect(servers[0].id).toBe('builtin_image_gpt-image');
        expect(servers[0].enabled).toBe(false);
    });

    it('keeps preferredEngine null when no engine is enabled', () => {
        writeRaw({
            version: 1,
            engines: {
                'gpt-image': { id: 'gpt-image', enabled: false, tools: [] },
                novelai: { id: 'novelai', enabled: false, tools: [] },
            },
        });
        expect(loadBuiltinImageSettings().preferredEngine).toBeNull();
        expect(getBuiltinImageMcpServers()).toEqual([]);
    });

    it('selects the first successfully enabled engine for fresh configs', () => {
        updateBuiltinImageBinding('novelai', {
            enabled: true, token: 'token', tools: [novelTool],
        });
        expect(loadBuiltinImageSettings().preferredEngine).toBe('novelai');
        expect(getBuiltinImageMcpServers()[0].id).toBe('builtin_image_novelai');
    });
});
