import type { APIConfig, ApiPreset } from '../types';
import type {
    ApiFailoverGroup,
    ApiFailoverMember,
    ResolvedApiRoute,
} from './apiFailover';
import { isSameCoreModel } from './apiCallLog';

export type ApiFailoverMemberIssue =
    | 'disabled'
    | 'missing_preset'
    | 'invalid_config'
    | 'incompatible_model';

export interface ApiFailoverMemberAnalysis {
    member: ApiFailoverMember;
    preset?: ApiPreset;
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

export function analyzeApiFailoverGroup(
    group: ApiFailoverGroup,
    presets: ApiPreset[],
): ApiFailoverGroupAnalysis {
    const presetMap = new Map(
        presets.map(preset => [preset.id, preset]),
    );
    const members: ApiFailoverMemberAnalysis[] = [];
    const valid: Array<{
        member: ApiFailoverMember;
        preset: ApiPreset;
    }> = [];

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

        if (!validApiConfig(preset.config)) {
            members.push({
                member,
                preset,
                issue: 'invalid_config',
                compatible: false,
            });
            continue;
        }

        valid.push({ member, preset });
        members.push({
            member,
            preset,
            compatible: true,
        });
    }

    const anchor = valid[0]?.preset.config.model || '';
    const routes: ResolvedApiRoute[] = [];

    for (const entry of members) {
        if (!entry.preset || entry.issue) continue;

        const compatible =
            !group.policy.strictSameModel
            || routes.length === 0
            || isSameCoreModel(
                anchor,
                entry.preset.config.model,
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
            api: entry.preset.config,
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
        case 'invalid_config':
            return 'URL 或模型未填写';
        case 'incompatible_model':
            return '与第一线路模型不兼容';
        case 'disabled':
            return '已停用';
        default:
            return '';
    }
}
