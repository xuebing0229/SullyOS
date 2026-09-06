import type { APIConfig, ApiPreset } from '../types';
import type {
    ApiFailoverGroup,
    ApiFailoverMember,
    ResolvedApiRoute,
} from './apiFailover';
import { isSameCoreModel } from './apiCallLog';
import { normalizeApiPreset } from './apiConfigNormalize';
import { apiPresetHasModel } from './apiPresetModels';

export type ApiFailoverMemberIssue =
    | 'disabled'
    | 'missing_preset'
    | 'missing_model'
    | 'invalid_config'
    | 'duplicate_route'
    | 'incompatible_model';

export interface ApiFailoverMemberAnalysis {
    member: ApiFailoverMember;
    preset?: ApiPreset;
    model?: string;
    issue?: ApiFailoverMemberIssue;
    compatible: boolean;
    route?: ResolvedApiRoute;
}

export interface ApiFailoverGroupAnalysis {
    members: ApiFailoverMemberAnalysis[];
    routes: ResolvedApiRoute[];
    validRouteCount: number;
    compatibleRouteCount: number;
    canEnable: boolean;
    reason?: 'no_valid_routes' | 'not_enough_routes';
}

function validApiConfig(
    config: APIConfig | null | undefined,
): boolean {
    return Boolean(
        config?.baseUrl?.trim()
        && config?.model?.trim(),
    );
}

function selectedModel(
    member: ApiFailoverMember,
    preset: ApiPreset,
): string {
    return String(member.model || preset.config.model || '').trim();
}

export function analyzeApiFailoverGroup(
    group: ApiFailoverGroup,
    presets: ApiPreset[],
): ApiFailoverGroupAnalysis {
    // 线路解析是保存预设进入聊天/剧情执行链的统一边界。这里必须先做与设置页相同的
    // 归一化，不能把 localStorage 里的历史/脏凭据原样塞给后台 Story Worker。
    // 尤其 apiKey 可能带有复制粘贴产生的零宽字符/BOM/首尾空白；前台当前配置已经
    // 归一化时可正常调用，而剧情线路若继续读 raw preset，就会表现成上游 Invalid token。
    const presetMap = new Map(
        presets.map(preset => {
            const normalized = normalizeApiPreset(preset);
            return [normalized.id, normalized] as const;
        }),
    );
    const members: ApiFailoverMemberAnalysis[] = [];
    const valid: Array<{
        member: ApiFailoverMember;
        preset: ApiPreset;
        model: string;
    }> = [];
    const seenRoutes = new Set<string>();

    for (const member of group.members) {
        if (!member.enabled) {
            members.push({
                member,
                issue: 'disabled',
                compatible: false,
            });
            continue;
        }

        const preset = presetMap.get(member.presetId);
        if (!preset) {
            members.push({
                member,
                issue: 'missing_preset',
                compatible: false,
            });
            continue;
        }

        const model = selectedModel(member, preset);
        const api = {
            ...preset.config,
            model,
        };

        if (!validApiConfig(api)) {
            members.push({
                member,
                preset,
                model,
                issue: 'invalid_config',
                compatible: false,
            });
            continue;
        }

        if (member.model && !apiPresetHasModel(preset, model)) {
            members.push({
                member,
                preset,
                model,
                issue: 'missing_model',
                compatible: false,
            });
            continue;
        }

        const routeIdentity = `${preset.id}\u0000${model}`;
        if (seenRoutes.has(routeIdentity)) {
            members.push({
                member,
                preset,
                model,
                issue: 'duplicate_route',
                compatible: false,
            });
            continue;
        }
        seenRoutes.add(routeIdentity);

        valid.push({ member, preset, model });
        members.push({
            member,
            preset,
            model,
            compatible: true,
        });
    }

    const anchor = valid[0]?.model || '';
    const routes: ResolvedApiRoute[] = [];

    for (const entry of members) {
        if (!entry.preset || !entry.model || entry.issue) continue;

        const compatible =
            !group.policy.strictSameModel
            || routes.length === 0
            || isSameCoreModel(
                anchor,
                entry.model,
            );

        if (!compatible) {
            entry.compatible = false;
            entry.issue = 'incompatible_model';
            continue;
        }

        const route: ResolvedApiRoute = {
            presetId: entry.preset.id,
            presetName:
                entry.preset.name || '未命名预设',
            api: {
                ...entry.preset.config,
                model: entry.model,
            },
            routeIndex: routes.length,
            ...(entry.member.firstByteTimeoutMs
                ? { firstByteTimeoutMs: entry.member.firstByteTimeoutMs }
                : {}),
        };
        entry.route = route;
        routes.push(route);
    }

    const reason = routes.length === 0
        ? 'no_valid_routes'
        : routes.length < 2
            ? 'not_enough_routes'
            : undefined;

    return {
        members,
        routes,
        validRouteCount: valid.length,
        compatibleRouteCount: routes.length,
        canEnable: routes.length >= 2,
        reason,
    };
}

export function apiFailoverIssueLabel(
    issue: ApiFailoverMemberIssue | undefined,
): string {
    switch (issue) {
        case 'missing_preset':
            return '预设已缺失';
        case 'missing_model':
            return '这个模型已不在预设中';
        case 'invalid_config':
            return 'URL 或模型未填写';
        case 'duplicate_route':
            return '这条预设 + 模型已重复';
        case 'incompatible_model':
            return '与第一线路模型不兼容';
        case 'disabled':
            return '已停用';
        default:
            return '';
    }
}
