import type { APIConfig, ApiPreset } from '../types';
import { apiPresetHasModel } from './apiPresetModels';

export type ApiPresetMatchReason =
    | 'preset_not_found'
    | 'preset_ambiguous';

export interface ApiPresetRouteMatchInput {
    baseUrl: string;
    model: string;
    preferredPresetId?: string | null;
    apiKey?: string;
}

export interface ApiPresetRouteMatchResult {
    preset?: ApiPreset;
    reason?: ApiPresetMatchReason;
    candidatePresetIds: string[];
    matchedBy?: 'preferred_id' | 'credential' | 'single_route';
}

const normalizeBaseUrl = (value: string): string =>
    String(value || '').trim().replace(/\/+$/, '');

const normalizeModel = (value: string): string =>
    String(value || '').trim();

const normalizedCredential = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const presetMatchesRoute = (
    preset: ApiPreset,
    input: Pick<ApiPresetRouteMatchInput, 'baseUrl' | 'model'>,
): boolean =>
    normalizeBaseUrl(preset.config?.baseUrl || '')
        === normalizeBaseUrl(input.baseUrl)
    && apiPresetHasModel(preset, normalizeModel(input.model));

/**
 * 用一次真实请求的完整线路身份匹配计费预设。
 *
 * 匹配顺序：
 * 1. 调用链显式携带的 presetId；
 * 2. 本次 Authorization Bearer 对应的 API Key；
 * 3. baseUrl + model 唯一候选。
 *
 * Key 只在内存里参与等值比较，不写进日志、错误或返回值。
 */
export function matchApiPresetRoute(
    presets: ApiPreset[],
    input: ApiPresetRouteMatchInput,
): ApiPresetRouteMatchResult {
    const routeMatches = presets.filter(
        preset => presetMatchesRoute(preset, input),
    );
    const candidatePresetIds = routeMatches.map(preset => preset.id);
    const preferredPresetId = String(input.preferredPresetId || '').trim();
    const apiKey = normalizedCredential(input.apiKey);

    if (preferredPresetId) {
        const preferred = routeMatches.find(
            preset => preset.id === preferredPresetId,
        );
        if (
            preferred
            && (
                !apiKey
                || normalizedCredential(preferred.config?.apiKey) === apiKey
            )
        ) {
            return {
                preset: preferred,
                candidatePresetIds,
                matchedBy: 'preferred_id',
            };
        }
    }

    if (apiKey) {
        const credentialMatches = routeMatches.filter(
            preset =>
                normalizedCredential(preset.config?.apiKey)
                    === apiKey,
        );

        if (preferredPresetId) {
            const preferredCredential = credentialMatches.find(
                preset => preset.id === preferredPresetId,
            );
            if (preferredCredential) {
                return {
                    preset: preferredCredential,
                    candidatePresetIds:
                        credentialMatches.map(preset => preset.id),
                    matchedBy: 'preferred_id',
                };
            }
        }

        if (credentialMatches.length === 1) {
            return {
                preset: credentialMatches[0],
                candidatePresetIds:
                    credentialMatches.map(preset => preset.id),
                matchedBy: 'credential',
            };
        }

        if (credentialMatches.length > 1) {
            return {
                reason: 'preset_ambiguous',
                candidatePresetIds:
                    credentialMatches.map(preset => preset.id),
            };
        }
    }

    if (routeMatches.length === 1) {
        return {
            preset: routeMatches[0],
            candidatePresetIds,
            matchedBy: 'single_route',
        };
    }

    if (routeMatches.length > 1) {
        return {
            reason: 'preset_ambiguous',
            candidatePresetIds,
        };
    }

    return {
        reason: 'preset_not_found',
        candidatePresetIds: [],
    };
}

/**
 * 从 fetch HeadersInit 中读取 Bearer 凭证。
 * 仅返回给当前同步计费匹配过程使用，调用方不得持久化。
 */
export function extractBearerCredential(
    headers: HeadersInit | undefined,
): string | undefined {
    if (!headers) return undefined;

    let authorization = '';

    try {
        if (
            typeof Headers !== 'undefined'
            && headers instanceof Headers
        ) {
            authorization =
                headers.get('authorization') || '';
        } else if (Array.isArray(headers)) {
            const pair = headers.find(
                ([name]) =>
                    String(name).toLowerCase()
                        === 'authorization',
            );
            authorization = pair
                ? String(pair[1] || '')
                : '';
        } else {
            const record = headers as Record<string, unknown>;
            const key = Object.keys(record).find(
                name =>
                    name.toLowerCase()
                        === 'authorization',
            );
            authorization = key
                ? String(record[key] || '')
                : '';
        }
    } catch {
        return undefined;
    }

    const match = authorization.match(
        /^\s*Bearer\s+(.+?)\s*$/i,
    );
    const credential = match?.[1]?.trim();
    return credential || undefined;
}

export function findApiPresetForConfig(
    presets: ApiPreset[],
    api: APIConfig,
    preferredPresetId?: string | null,
): ApiPreset | undefined {
    return matchApiPresetRoute(
        presets,
        {
            baseUrl: api.baseUrl,
            model: api.model,
            apiKey: api.apiKey,
            preferredPresetId,
        },
    ).preset;
}
