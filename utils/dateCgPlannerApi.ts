import type { APIConfig, ApiPreset, CharacterProfile } from '../types';
import { findApiPresetForConfig } from './apiPresetRouteIdentity';
import { getApiPresetModelEntries, getApiPresetStorySystemCompatibility } from './apiPresetModels';

/**
 * 见面 CG 的规划模型和角色的正文模型完全独立。
 * 未配置时保留原先跟随主聊天的行为；显式选择后不允许悄悄回退，
 * 否则主模型不支持 tools 时问题会看起来像“偶发”。
 */
export const resolveDateCgPlannerApiConfig = (
    char: CharacterProfile,
    fallbackApi: APIConfig,
    presets: ApiPreset[],
): APIConfig => {
    const presetId = (char.dateCgPlannerApiPresetId || '').trim();
    if (!presetId) return fallbackApi;
    const preset = presets.find(item => item.id === presetId);
    if (!preset) throw new Error('见面 CG 规划器的 API 预设已不存在，请在见面设置里重新选择。');

    const model = (char.dateCgPlannerModel || '').trim() || preset.config.model;
    if (!getApiPresetModelEntries(preset).some(entry => entry.model === model)) {
        throw new Error(`见面 CG 规划器模型「${model}」已不在所选 API 预设中，请重新选择模型。`);
    }
    return {
        ...fallbackApi,
        ...preset.config,
        model,
        stream: false,
    };
};

export const resolveDateCgPlannerSystemCompatibility = (
    char: CharacterProfile,
    fallbackApi: APIConfig,
    presets: ApiPreset[],
): boolean => {
    const presetId = (char.dateCgPlannerApiPresetId || '').trim();
    const preset = presetId
        ? presets.find(item => item.id === presetId)
        : findApiPresetForConfig(presets, fallbackApi);
    if (!preset) return false;
    const model = presetId
        ? ((char.dateCgPlannerModel || '').trim() || preset.config.model)
        : fallbackApi.model;
    return getApiPresetStorySystemCompatibility(preset, model);
};
