import { describe, expect, it } from 'vitest';
import type { APIConfig, ApiPreset, CharacterProfile } from '../types';
import { resolveDateCgPlannerApiConfig, resolveDateCgPlannerSystemCompatibility } from './dateCgPlannerApi';

const chat = { baseUrl: 'https://writer.example/v1', apiKey: 'writer-key', model: 'writer-no-tools', stream: true } as APIConfig;
const preset = {
    id: 'cg-planner',
    name: 'CG 专用',
    config: { baseUrl: 'https://tools.example/v1', apiKey: 'tools-key', model: 'planner-default', stream: true },
    models: [
        { model: 'planner-default', storySystemCompatibility: false },
        { model: 'planner-fast', storySystemCompatibility: true },
    ],
} as ApiPreset;
const char = (fields: Record<string, unknown> = {}) =>
    ({ id: 'character-1', name: '角色', ...fields }) as CharacterProfile;

describe('见面 CG 独立规划模型', () => {
    it('旧角色没设置时仍用当前正文 API', () => {
        expect(resolveDateCgPlannerApiConfig(char(), chat, [preset])).toBe(chat);
        expect(resolveDateCgPlannerSystemCompatibility(char(), chat, [preset])).toBe(false);
    });
    it('指定预设和模型后切换整套 endpoint/凭据，不动原正文配置', () => {
        const role = char({ dateCgPlannerApiPresetId: 'cg-planner', dateCgPlannerModel: 'planner-fast' });
        expect(resolveDateCgPlannerApiConfig(role, chat, [preset])).toMatchObject({
            baseUrl: 'https://tools.example/v1',
            apiKey: 'tools-key',
            model: 'planner-fast',
            stream: false,
        });
        expect(chat.model).toBe('writer-no-tools');
        expect(resolveDateCgPlannerSystemCompatibility(role, chat, [preset])).toBe(true);
    });
    it('预设默认模型可用，删除预设/已移除模型时明确报错而不是切回主模型', () => {
        expect(resolveDateCgPlannerApiConfig(char({ dateCgPlannerApiPresetId: 'cg-planner' }), chat, [preset]).model).toBe('planner-default');
        expect(() => resolveDateCgPlannerApiConfig(char({ dateCgPlannerApiPresetId: 'missing' }), chat, [preset])).toThrow('预设已不存在');
        expect(() => resolveDateCgPlannerApiConfig(char({ dateCgPlannerApiPresetId: 'cg-planner', dateCgPlannerModel: 'removed' }), chat, [preset])).toThrow('已不在所选 API 预设');
    });
});
