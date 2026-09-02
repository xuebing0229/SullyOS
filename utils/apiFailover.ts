import {
    BrokenCircuitError,
    ConsecutiveBreaker,
    circuitBreaker,
    handleWhen,
} from 'cockatiel';

import type { APIConfig, ApiPreset } from '../types';
import { analyzeApiFailoverGroup } from './apiFailoverGroupAnalysis';
import { findApiPresetForConfig } from './apiPresetRouteIdentity';
import type { ApiCallMeta } from './apiCallLog';
import { safeFetchJson, type StreamHooks } from './safeApi';
import {
    API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS,
    clearAllApiRouteCooldowns,
    clearApiRouteCooldown,
    formatApiRouteCooldownRemaining,
    getApiRouteCooldown,
    markApiRouteCooldown,
} from './apiFailoverRouteCooldown';

export const API_FAILOVER_STORAGE_KEY = 'os_api_failover_groups_v1';
const API_PRESETS_STORAGE_KEY = 'os_api_presets';

export type ApiFailoverScope = 'chat' | 'story' | 'emotion';

export interface ApiFailoverMember {
    presetId: string;
    /** Selected model inside the preset. Legacy entries omit this and use preset.config.model. */
    model?: string;
    enabled: boolean;
    /**
     * 主聊天线路愿意等待“首次有效输出”的时间。0 / undefined = 不单独限制。
     * 超时必须 abort 当前请求后才能切下一条，避免后台继续生成导致重复计费。
     */
    firstByteTimeoutMs?: number;
}

export interface ApiFailoverPolicy {
    /** Total calls for one route, including the first call. */
    routeMaxAttempts: number;
    /** Hard timeout for each HTTP attempt. */
    timeoutMs: number;
    /** Open the circuit after this many handled failures in a row. */
    consecutiveFailureThreshold: number;
    /** Wait this long before Cockatiel allows a half-open probe. */
    cooldownMs: number;
    /** V1 safety rail: do not silently switch model families. */
    strictSameModel: boolean;
}

export interface ApiFailoverGroup {
    id: string;
    name: string;
    scope: ApiFailoverScope;
    enabled: boolean;
    members: ApiFailoverMember[];
    policy: ApiFailoverPolicy;
    updatedAt: number;
}

export interface ResolvedApiRoute {
    presetId: string;
    presetName: string;
    api: APIConfig;
    routeIndex: number;
    firstByteTimeoutMs?: number;
}

export interface ApiExecutionPlan {
    mode: 'direct' | 'failover';
    scope: ApiFailoverScope;
    primaryApi: APIConfig;
    routes: ResolvedApiRoute[];
    group?: ApiFailoverGroup;
    cacheIdentity: string;
    failoverInactiveReason?: 'not_enough_routes' | 'no_valid_routes';
}

export type ApiFailureKind =
    | 'cancelled'
    | 'stream_committed'
    | 'timeout'
    | 'network'
    | 'rate_limit'
    | 'server'
    | 'auth'
    | 'not_found'
    | 'bad_request'
    | 'safety'
    | 'gateway_parse'
    | 'circuit_open'
    | 'route_cooldown'
    | 'unknown';

export interface ClassifiedApiError {
    kind: ApiFailureKind;
    message: string;
    status?: number;
    retrySameRoute: boolean;
    failoverEligible: boolean;
    circuitFailure: boolean;
    cooldownUntil?: number;
    remainingMs?: number;
}

export interface ApiFailoverAttempt {
    requestId: string;
    groupId?: string;
    groupName?: string;
    presetId: string;
    presetName: string;
    routeIndex: number;
    routeCount: number;
    attempt: number;
    phase: 'start' | 'success' | 'failure' | 'skipped';
    startedAt: number;
    durationMs?: number;
    classification?: ClassifiedApiError;
}

export interface ApiFailoverRunResult<T> {
    value: T;
    route: ResolvedApiRoute;
    attempts: ApiFailoverAttempt[];
    requestId: string;
}

export interface ApiFailoverExecuteContext {
    requestId: string;
    routeIndex: number;
    routeCount: number;
    attempt: number;
    signal: AbortSignal;
    markStreamStarted: () => void;
}

export interface RunApiFailoverOptions<T> {
    plan: ApiExecutionPlan;
    signal?: AbortSignal;
    execute: (
        route: ResolvedApiRoute,
        context: ApiFailoverExecuteContext,
    ) => Promise<T>;
    onAttempt?: (attempt: ApiFailoverAttempt) => void;
}

export const DEFAULT_API_FAILOVER_POLICY: ApiFailoverPolicy = {
    routeMaxAttempts: 1,
    timeoutMs: 240_000,
    consecutiveFailureThreshold: 1,
    cooldownMs: API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS,
    strictSameModel: true,
};

export function createDefaultApiFailoverGroup(
    scope: ApiFailoverScope,
): ApiFailoverGroup {
    return {
        id: `failover_${scope}`,
        name:
            scope === 'chat'
                ? '主聊天'
                : scope === 'story'
                    ? '剧情'
                    : '情绪评估',
        scope,
        enabled: false,
        members: [],
        policy: {
            ...DEFAULT_API_FAILOVER_POLICY,
            // 主聊天带工具协议，默认限制同模型家族；剧情和情绪都是普通 completion，
            // 允许用户按自己的模型偏好混合备用线路。
            strictSameModel: scope === 'chat',
        },
        updatedAt: Date.now(),
    };
}

function finiteInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeApiFailoverGroup(
    input: Partial<ApiFailoverGroup> | null | undefined,
    scope: ApiFailoverScope,
): ApiFailoverGroup {
    const fallback = createDefaultApiFailoverGroup(scope);
    const seen = new Set<string>();
    const members: ApiFailoverMember[] = [];

    for (const item of Array.isArray(input?.members) ? input!.members! : []) {
        const presetId = String(item?.presetId || '').trim();
        const model = String(item?.model || '').trim();
        const identity = `${presetId}\u0000${model}`;
        if (!presetId || seen.has(identity)) continue;
        seen.add(identity);
        const firstByteTimeoutMs = scope !== 'emotion'
            ? finiteInt(
                item?.firstByteTimeoutMs,
                0,
                0,
                300_000,
            )
            : 0;
        members.push({
            presetId,
            ...(model ? { model } : {}),
            enabled: item?.enabled !== false,
            ...(firstByteTimeoutMs > 0
                ? { firstByteTimeoutMs }
                : {}),
        });
    }

    return {
        id: String(input?.id || fallback.id),
        name: String(input?.name || fallback.name).trim() || fallback.name,
        scope,
        enabled: Boolean(input?.enabled),
        members,
        policy: {
            routeMaxAttempts: 1,
            timeoutMs: finiteInt(
                input?.policy?.timeoutMs,
                DEFAULT_API_FAILOVER_POLICY.timeoutMs,
                30_000,
                600_000,
            ),
            consecutiveFailureThreshold: 1,
            cooldownMs: API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS,
            // 剧情/情绪不使用主聊天工具协议，读取时强制允许跨模型回退。
            strictSameModel: scope === 'chat'
                ? input?.policy?.strictSameModel
                    ?? DEFAULT_API_FAILOVER_POLICY.strictSameModel
                : false,
        },
        updatedAt: Number(input?.updatedAt) || Date.now(),
    };
}

export function loadApiFailoverGroups(): ApiFailoverGroup[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const parsed = JSON.parse(
            localStorage.getItem(API_FAILOVER_STORAGE_KEY) || '[]',
        );
        if (!Array.isArray(parsed)) return [];
        return (['chat', 'story', 'emotion'] as ApiFailoverScope[])
            .map(scope => {
                const found = parsed.find(item => item?.scope === scope);
                return found
                    ? normalizeApiFailoverGroup(found, scope)
                    : null;
            })
            .filter(Boolean) as ApiFailoverGroup[];
    } catch {
        return [];
    }
}

export function saveApiFailoverGroups(groups: ApiFailoverGroup[]): void {
    if (typeof localStorage === 'undefined') return;
    const normalized = (['chat', 'story', 'emotion'] as ApiFailoverScope[])
        .map(scope => {
            const found = groups.find(group => group.scope === scope);
            return normalizeApiFailoverGroup(
                found || createDefaultApiFailoverGroup(scope),
                scope,
            );
        });
    localStorage.setItem(
        API_FAILOVER_STORAGE_KEY,
        JSON.stringify(normalized),
    );
    resetApiFailoverRuntime();
}

export function loadApiPresetsForFailover(): ApiPreset[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const parsed = JSON.parse(
            localStorage.getItem(API_PRESETS_STORAGE_KEY) || '[]',
        );
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function routeIdentity(route: ResolvedApiRoute): string {
    return [
        route.presetId,
        route.api.baseUrl.trim().replace(/\/+$/, ''),
        route.api.model.trim(),
        route.api.stream ? 'stream' : 'nonstream',
    ].join('|');
}

export function resolveApiExecutionPlanWithData(
    scope: ApiFailoverScope,
    fallbackApi: APIConfig,
    groups: ApiFailoverGroup[],
    presets: ApiPreset[],
    allowFailover = true,
): ApiExecutionPlan {
    const directPreset =
        findApiPresetForConfig(
            presets,
            fallbackApi,
        );
    const directRoute: ResolvedApiRoute = {
        presetId:
            directPreset?.id
            || '__direct__',
        presetName:
            directPreset?.name
            || '当前 API',
        api: fallbackApi,
        routeIndex: 0,
    };

    if (!allowFailover) {
        return {
            mode: 'direct',
            scope,
            primaryApi: fallbackApi,
            routes: [directRoute],
            cacheIdentity: [
                'direct',
                directRoute.presetId,
                fallbackApi.baseUrl?.trim().replace(/\/+$/, ''),
                fallbackApi.model,
            ].join('|'),
        };
    }

    const configuredGroup = groups.find(
        group => group.scope === scope,
    );
    const rawGroup =
        scope === 'story'
            ? configuredGroup
            : configuredGroup?.enabled
                ? configuredGroup
                : undefined;
    if (!rawGroup) {
        return {
            mode: 'direct',
            scope,
            primaryApi: fallbackApi,
            routes: [directRoute],
            cacheIdentity: [
                'direct',
                directRoute.presetId,
                fallbackApi.baseUrl?.trim().replace(/\/+$/, ''),
                fallbackApi.model,
            ].join('|'),
        };
    }

    const group = normalizeApiFailoverGroup(rawGroup, scope);
    const analysis = analyzeApiFailoverGroup(group, presets);

    // 剧情线路与主聊天解耦：只要配置了第一线路，即使“回退”开关关闭，
    // 剧情也固定使用自己的第一线路；没有配置时才继续沿用当前 API。
    if (scope === 'story' && !group.enabled) {
        const selected = analysis.routes[0] || directRoute;
        return {
            mode: 'direct',
            scope,
            primaryApi: selected.api,
            routes: [{ ...selected, routeIndex: 0 }],
            group,
            cacheIdentity: [
                'direct-story-route-v1',
                selected.presetId,
                selected.api.baseUrl?.trim().replace(/\/+$/, ''),
                selected.api.model,
            ].join('|'),
        };
    }

    if (!analysis.canEnable) {
        const selected = analysis.routes[0] || directRoute;
        return {
            mode: 'direct',
            scope,
            primaryApi: selected.api,
            routes: [{ ...selected, routeIndex: 0 }],
            group,
            failoverInactiveReason: analysis.reason,
            cacheIdentity: [
                'direct-failover-inactive-v1',
                selected.presetId,
                selected.api.baseUrl?.trim().replace(/\/+$/, ''),
                selected.api.model,
            ].join('|'),
        };
    }

    const reindexed = analysis.routes.map((route, index) => ({
        ...route,
        routeIndex: index,
    }));

    const cacheIdentity = [
        'failover-v1',
        group.id,
        group.updatedAt,
        group.policy.strictSameModel ? 'strict-model' : 'mixed-model',
        ...reindexed.map(routeIdentity),
    ].join('|');

    return {
        mode: 'failover',
        scope,
        primaryApi: reindexed[0].api,
        routes: reindexed,
        group,
        cacheIdentity,
    };
}

export function resolveApiExecutionPlan(
    scope: ApiFailoverScope,
    fallbackApi: APIConfig,
    allowFailover = true,
): ApiExecutionPlan {
    return resolveApiExecutionPlanWithData(
        scope,
        fallbackApi,
        loadApiFailoverGroups(),
        loadApiPresetsForFailover(),
        allowFailover,
    );
}

function statusFromError(error: unknown): number | undefined {
    const direct = Number((error as any)?.status);
    if (Number.isFinite(direct) && direct >= 100 && direct <= 599) {
        return direct;
    }

    const message = String((error as any)?.message || error || '');
    const match = message.match(
        /(?:API Error|HTTP|status(?:Code)?[:=\s])\s*([1-5]\d\d)/i,
    );
    return match ? Number(match[1]) : undefined;
}

const SAFETY_RE =
    /safety|moderation|content[_ -]?policy|blocked\s+(?:prompt|content)|sensitive\s+words?|policy\s+violation/i;
const MODEL_MISSING_RE =
    /model[^.\n]*(?:not found|does not exist|unsupported|unavailable|unknown)|unknown\s+model/i;
const GATEWAY_PARSE_RE =
    /API返回了HTML|API返回了空响应|API返回了无效JSON|html rather than json|empty response|invalid json/i;
const TIMEOUT_RE =
    /timeout|timed out|超时/i;
const NETWORK_RE =
    /failed to fetch|network(?:error| request failed)?|fetch failed|connection|econn|dns|socket|load failed/i;

export function classifyApiError(
    error: unknown,
    context: {
        externalSignalAborted?: boolean;
        streamStarted?: boolean;
    } = {},
): ClassifiedApiError {
    const message = String((error as any)?.message || error || 'API 请求失败');
    const status = statusFromError(error);

    if (context.externalSignalAborted) {
        return {
            kind: 'cancelled',
            message,
            status,
            retrySameRoute: false,
            failoverEligible: false,
            circuitFailure: false,
        };
    }

    if (context.streamStarted) {
        return {
            kind: 'stream_committed',
            message,
            status,
            retrySameRoute: false,
            failoverEligible: false,
            circuitFailure: false,
        };
    }

    if (SAFETY_RE.test(message)) {
        return {
            kind: 'safety',
            message,
            status,
            retrySameRoute: false,
            failoverEligible: false,
            circuitFailure: false,
        };
    }

    const isAbort =
        (error as any)?.name === 'AbortError'
        || /aborted/i.test(message);
    if (TIMEOUT_RE.test(message) || isAbort) {
        return {
            kind: 'timeout',
            message,
            status,
            retrySameRoute: true,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    if (
        (error as any)?.name === 'TypeError'
        || NETWORK_RE.test(message)
    ) {
        return {
            kind: 'network',
            message,
            status,
            retrySameRoute: true,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    if (status === 429) {
        return {
            kind: 'rate_limit',
            message,
            status,
            retrySameRoute: false,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    if (
        status === 408
        || status === 425
        || (status != null && status >= 500)
    ) {
        return {
            kind: 'server',
            message,
            status,
            retrySameRoute: true,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    if (status === 401 || status === 403) {
        return {
            kind: 'auth',
            message,
            status,
            retrySameRoute: false,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    if (status === 404 || MODEL_MISSING_RE.test(message)) {
        return {
            kind: 'not_found',
            message,
            status,
            retrySameRoute: false,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    if (GATEWAY_PARSE_RE.test(message)) {
        return {
            kind: 'gateway_parse',
            message,
            status,
            retrySameRoute: true,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    if (status != null && status >= 400) {
        return {
            kind: 'bad_request',
            message,
            status,
            retrySameRoute: false,
            failoverEligible: true,
            circuitFailure: true,
        };
    }

    // 故障转移的语义就是“这条没拿到可用结果就试下一条”。
    // 只有用户主动取消、内容安全拦截、或流已经真正开始输出时才不能切。
    return {
        kind: 'unknown',
        message,
        status,
        retrySameRoute: false,
        failoverEligible: true,
        circuitFailure: true,
    };
}

export class ApiRouteError extends Error {
    readonly classification: ClassifiedApiError;
    readonly presetId: string;
    readonly presetName: string;
    readonly causeValue: unknown;

    constructor(
        route: ResolvedApiRoute,
        classification: ClassifiedApiError,
        causeValue: unknown,
    ) {
        super(classification.message);
        this.name = 'ApiRouteError';
        this.classification = classification;
        this.presetId = route.presetId;
        this.presetName = route.presetName;
        this.causeValue = causeValue;
    }
}

export class ApiFailoverExhaustedError extends Error {
    readonly attempts: ApiFailoverAttempt[];

    constructor(attempts: ApiFailoverAttempt[]) {
        const failures = attempts
            .filter(item =>
                item.phase === 'failure'
                || item.phase === 'skipped')
            .map(item => {
                const suffix = item.classification?.kind === 'route_cooldown'
                    ? item.classification.message || '线路冷却中'
                    : item.classification?.status
                        ? `HTTP ${item.classification.status}`
                        : item.classification?.kind || '失败';
                return `${item.presetName}：${suffix}`;
            });

        super(
            failures.length
                ? `所有 API 线路均不可用：${failures.join(' → ')}`
                : '所有 API 线路均不可用',
        );
        this.name = 'ApiFailoverExhaustedError';
        this.attempts = attempts;
    }
}

type BreakerPolicy = ReturnType<typeof circuitBreaker>;

const breakerCache = new Map<
    string,
    { signature: string; breaker: BreakerPolicy }
>();

function breakerKey(
    scope: ApiFailoverScope,
    route: ResolvedApiRoute,
): string {
    return [
        scope,
        route.presetId,
        route.api.model.trim(),
    ].join(':');
}

function getRouteBreaker(
    plan: ApiExecutionPlan,
    route: ResolvedApiRoute,
): BreakerPolicy {
    const policy = plan.group?.policy || DEFAULT_API_FAILOVER_POLICY;
    const key = breakerKey(plan.scope, route);
    const signature = [
        route.api.baseUrl.trim().replace(/\/+$/, ''),
        route.api.model,
        policy.consecutiveFailureThreshold,
        policy.cooldownMs,
    ].join('|');

    const existing = breakerCache.get(key);
    if (existing?.signature === signature) return existing.breaker;

    const handled = handleWhen(
        (error: unknown) =>
            error instanceof ApiRouteError
            && error.classification.circuitFailure,
    );
    const breaker = circuitBreaker(handled, {
        halfOpenAfter: policy.cooldownMs,
        breaker: new ConsecutiveBreaker(
            policy.consecutiveFailureThreshold,
        ),
    });
    breakerCache.set(key, { signature, breaker });
    return breaker;
}

export function resetApiFailoverRuntime(): void {
    breakerCache.clear();
}

export function clearApiFailoverRouteCooldowns(): void {
    breakerCache.clear();
    clearAllApiRouteCooldowns();
}

function createRequestId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return `failover_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 10)}`;
    }
}

function emitAttempt(
    attempts: ApiFailoverAttempt[],
    attempt: ApiFailoverAttempt,
    callback?: (attempt: ApiFailoverAttempt) => void,
): void {
    attempts.push(attempt);
    try {
        callback?.(attempt);
    } catch {
        // Telemetry must not affect the request.
    }
}

export async function runApiFailover<T>(
    options: RunApiFailoverOptions<T>,
): Promise<ApiFailoverRunResult<T>> {
    if (options.plan.mode !== 'failover') {
        throw new Error('runApiFailover requires a failover plan');
    }
    if (options.plan.routes.length === 0) {
        throw new Error('API 故障转移组没有可用线路');
    }

    const requestId = createRequestId();
    const attempts: ApiFailoverAttempt[] = [];
    const routeCount = options.plan.routes.length;

    for (const route of options.plan.routes) {
        const activeCooldown = getApiRouteCooldown(
            options.plan.scope,
            route,
        );
        if (activeCooldown) {
            const now = Date.now();
            emitAttempt(attempts, {
                requestId,
                groupId: options.plan.group?.id,
                groupName: options.plan.group?.name,
                presetId: route.presetId,
                presetName: route.presetName,
                routeIndex: route.routeIndex,
                routeCount,
                attempt: 0,
                phase: 'skipped',
                startedAt: now,
                durationMs: 0,
                classification: {
                    kind: 'route_cooldown',
                    message: `线路失败后冷却中，剩余 ${formatApiRouteCooldownRemaining(activeCooldown.blockedUntil, now)}`,
                    status: activeCooldown.status,
                    retrySameRoute: false,
                    failoverEligible: true,
                    circuitFailure: false,
                    cooldownUntil: activeCooldown.blockedUntil,
                    remainingMs: Math.max(
                        0,
                        activeCooldown.blockedUntil - now,
                    ),
                },
            }, options.onAttempt);
            continue;
        }

        const breaker = getRouteBreaker(options.plan, route);
        const startedAt = Date.now();
        const attemptNumber = 1;
        const signal = options.signal ?? new AbortController().signal;
        let streamStarted = false;

        emitAttempt(attempts, {
            requestId,
            groupId: options.plan.group?.id,
            groupName: options.plan.group?.name,
            presetId: route.presetId,
            presetName: route.presetName,
            routeIndex: route.routeIndex,
            routeCount,
            attempt: attemptNumber,
            phase: 'start',
            startedAt,
        }, options.onAttempt);

        try {
            const value = await breaker.execute(
                async () => {
                    try {
                        return await options.execute(route, {
                            requestId,
                            routeIndex: route.routeIndex,
                            routeCount,
                            attempt: attemptNumber,
                            signal,
                            markStreamStarted: () => {
                                streamStarted = true;
                            },
                        });
                    } catch (error) {
                        if (error instanceof ApiRouteError) {
                            throw error;
                        }
                        throw new ApiRouteError(
                            route,
                            classifyApiError(error, {
                                externalSignalAborted:
                                    Boolean(options.signal?.aborted),
                                streamStarted,
                            }),
                            error,
                        );
                    }
                },
                signal,
            );

            clearApiRouteCooldown(options.plan.scope, route);
            emitAttempt(attempts, {
                requestId,
                groupId: options.plan.group?.id,
                groupName: options.plan.group?.name,
                presetId: route.presetId,
                presetName: route.presetName,
                routeIndex: route.routeIndex,
                routeCount,
                attempt: attemptNumber,
                phase: 'success',
                startedAt,
                durationMs: Date.now() - startedAt,
            }, options.onAttempt);

            return {
                value,
                route,
                attempts,
                requestId,
            };
        } catch (error) {
            if (error instanceof BrokenCircuitError) {
                const now = Date.now();
                emitAttempt(attempts, {
                    requestId,
                    groupId: options.plan.group?.id,
                    groupName: options.plan.group?.name,
                    presetId: route.presetId,
                    presetName: route.presetName,
                    routeIndex: route.routeIndex,
                    routeCount,
                    attempt: 0,
                    phase: 'skipped',
                    startedAt: now,
                    durationMs: 0,
                    classification: {
                        kind: 'circuit_open',
                        message: '线路冷却中',
                        retrySameRoute: false,
                        failoverEligible: true,
                        circuitFailure: false,
                    },
                }, options.onAttempt);
                continue;
            }

            const wrapped = error instanceof ApiRouteError
                ? error
                : new ApiRouteError(
                    route,
                    classifyApiError(error, {
                        externalSignalAborted:
                            Boolean(options.signal?.aborted),
                        streamStarted,
                    }),
                    error,
                );

            if (wrapped.classification.circuitFailure) {
                markApiRouteCooldown(
                    options.plan.scope,
                    route,
                    wrapped.classification,
                );
            }

            emitAttempt(attempts, {
                requestId,
                groupId: options.plan.group?.id,
                groupName: options.plan.group?.name,
                presetId: route.presetId,
                presetName: route.presetName,
                routeIndex: route.routeIndex,
                routeCount,
                attempt: attemptNumber,
                phase: 'failure',
                startedAt,
                durationMs: Date.now() - startedAt,
                classification: wrapped.classification,
            }, options.onAttempt);

            if (wrapped.classification.failoverEligible) {
                continue;
            }
            throw wrapped;
        }
    }

    throw new ApiFailoverExhaustedError(attempts);
}

function cloneBody<T>(body: T): T {
    if (typeof structuredClone === 'function') {
        return structuredClone(body);
    }
    return JSON.parse(JSON.stringify(body));
}

function bodyForRoute(
    baseBody: Record<string, any>,
    api: APIConfig,
    forceStream = false,
): Record<string, any> {
    const body = cloneBody(baseBody);
    body.model = api.model;

    if (
        Object.prototype.hasOwnProperty.call(body, 'temperature')
        && api.temperature != null
    ) {
        body.temperature = api.temperature;
    }

    if (forceStream) {
        body.stream = true;
    } else if (api.stream != null) {
        body.stream = Boolean(api.stream);
    }

    if (body.stream) {
        body.stream_options = {
            ...(body.stream_options || {}),
            include_usage: true,
        };
    } else {
        delete body.stream_options;
    }

    return body;
}

function wrapStreamHooks(
    hooks: StreamHooks | undefined,
    markStreamStarted: () => void,
    markFirstResponse: () => void,
    streamExpected: boolean,
    commitMode: 'activity' | 'content' = 'activity',
): StreamHooks {
    return {
        // 非流式接口没有 token delta；首个响应体字节就是它能提供的最早响应信号。
        // 流式接口不能用这个（SSE heartbeat 也会有字节），要等真正模型 activity。
        onFirstBodyByte: () => {
            if (!streamExpected) markFirstResponse();
            hooks?.onFirstBodyByte?.();
        },
        onFirstActivity: () => {
            if (commitMode === 'activity') {
                markFirstResponse();
                markStreamStarted();
            }
            hooks?.onFirstActivity?.();
        },
        onFirstDelta: () => {
            if (commitMode === 'content') {
                // 某些长文本场景把“首字”定义为第一段可见正文，而不是 reasoning/tool activity。
                // 一旦真正吐出正文，就把这条线路视为已承诺：后续中断不再切线，避免重复生成。
                markFirstResponse();
                markStreamStarted();
            }
            hooks?.onFirstDelta?.();
        },
        onDelta: (delta, fullText) => {
            hooks?.onDelta?.(delta, fullText);
        },
        onReasoningDelta: (delta, fullReasoning) => {
            hooks?.onReasoningDelta?.(
                delta,
                fullReasoning,
            );
        },
    };
}

export interface ExecuteOpenAiChatPlanOptions {
    plan: ApiExecutionPlan;
    body: Record<string, any>;
    meta?: ApiCallMeta;
    streamHooks?: StreamHooks;
    signal?: AbortSignal;
    /** Existing behavior when no failover group is enabled. */
    directMaxRetries?: number;
    directTimeoutMs?: number;
    /**
     * 直连流式请求不启用“首字超时”。剧情剧场用它区分“真的网络断了”和“模型只是很慢”：
     * 单线路时宁可继续等，也不要客户端先判死后让用户重复发请求。
     */
    disableDirectFirstVisibleTimeout?: boolean;
    /** 强制本次 completion 走 stream:true，不受 API 预设的 stream 开关覆盖。 */
    forceStream?: boolean;
    /** 流式故障转移何时视为“已经开始输出，不能再切线路”。默认 activity；content = 第一段可见正文。 */
    streamCommitMode?: 'activity' | 'content';
    onAttempt?: (attempt: ApiFailoverAttempt) => void;
}

export async function executeOpenAiChatPlan(
    options: ExecuteOpenAiChatPlanOptions,
): Promise<ApiFailoverRunResult<any>> {
    if (options.plan.mode === 'direct') {
        const route = options.plan.routes[0];
        const body = bodyForRoute(options.body, route.api, options.forceStream === true);
        const baseUrl = route.api.baseUrl
            .trim()
            .replace(/\/+$/, '');
        const startedAt = Date.now();
        const directMeta: ApiCallMeta = {
            ...(options.meta || {}),
            ...(route.presetId !== '__direct__'
                ? {
                    apiPresetId:
                        route.presetId,
                    apiPresetName:
                        route.presetName,
                }
                : {}),
        };

        // 流式正文不能再把“240 秒请求超时”当整轮总时长。
        // 直连线路只在首个可见正文前使用 watchdog；一旦开始持续出字，就允许一直写到 finish_reason/[DONE]。
        const routeAbort = new AbortController();
        const forwardAbort = () => {
            if (!routeAbort.signal.aborted) {
                routeAbort.abort((options.signal as any)?.reason);
            }
        };
        if (options.signal?.aborted) forwardAbort();
        else options.signal?.addEventListener('abort', forwardAbort, { once: true });

        const firstVisibleTimeoutMs = body.stream && !options.disableDirectFirstVisibleTimeout
            ? Math.max(
                1,
                route.firstByteTimeoutMs
                    || options.directTimeoutMs
                    || options.plan.group?.policy.timeoutMs
                    || DEFAULT_API_FAILOVER_POLICY.timeoutMs,
            )
            : 0;
        let firstVisibleTimer: ReturnType<typeof setTimeout> | null = null;
        let firstVisibleTimedOut = false;
        const markFirstResponse = () => {
            if (firstVisibleTimer) {
                clearTimeout(firstVisibleTimer);
                firstVisibleTimer = null;
            }
        };
        if (body.stream && firstVisibleTimeoutMs > 0) {
            firstVisibleTimer = setTimeout(() => {
                firstVisibleTimedOut = true;
                if (!routeAbort.signal.aborted) {
                    routeAbort.abort(
                        new Error(`first visible timeout ${firstVisibleTimeoutMs}ms`),
                    );
                }
            }, firstVisibleTimeoutMs);
        }

        try {
            const value = await safeFetchJson(
                `${baseUrl}/chat/completions`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization:
                            `Bearer ${route.api.apiKey || 'sk-none'}`,
                    },
                    body: JSON.stringify(body),
                    signal: routeAbort.signal,
                },
                options.directMaxRetries ?? 2,
                // 非流式沿用旧总超时；流式由首字 watchdog 管“启动”，正文开始后不设总时长上限。
                body.stream ? 0 : (options.directTimeoutMs ?? 0),
                directMeta,
                body.stream
                    ? wrapStreamHooks(
                        options.streamHooks,
                        () => {},
                        markFirstResponse,
                        true,
                        options.streamCommitMode || 'activity',
                    )
                    : options.streamHooks,
            );
            const requestId = createRequestId();
            return {
                value,
                route,
                requestId,
                attempts: [{
                    requestId,
                    presetId: route.presetId,
                    presetName: route.presetName,
                    routeIndex: 0,
                    routeCount: 1,
                    attempt: 1,
                    phase: 'success',
                    startedAt,
                    durationMs: Date.now() - startedAt,
                }],
            };
        } catch (error) {
            if (firstVisibleTimedOut) {
                throw new Error(
                    `首字等待超时（${Math.round(firstVisibleTimeoutMs / 1000)} 秒），已停止当前线路`,
                );
            }
            throw error;
        } finally {
            markFirstResponse();
            options.signal?.removeEventListener('abort', forwardAbort);
        }
    }

    return runApiFailover({
        plan: options.plan,
        signal: options.signal,
        onAttempt: options.onAttempt,
        execute: async (route, context) => {
            const body = bodyForRoute(
                options.body,
                route.api,
                options.forceStream === true,
            );
            const baseUrl = route.api.baseUrl
                .trim()
                .replace(/\/+$/, '');

            const meta = {
                ...(options.meta || {}),
                apiPresetId:
                    route.presetId,
                apiPresetName:
                    route.presetName,
                failoverRequestId: context.requestId,
                failoverGroupId: options.plan.group?.id,
                failoverGroupName: options.plan.group?.name,
                failoverRouteIndex: context.routeIndex,
                failoverRouteCount: context.routeCount,
                failoverAttempt: context.attempt,
                failoverPresetId: route.presetId,
            } as ApiCallMeta;

            const routeAbort = new AbortController();
            const forwardAbort = () => {
                if (!routeAbort.signal.aborted) {
                    routeAbort.abort((context.signal as any).reason);
                }
            };
            if (context.signal.aborted) forwardAbort();
            else context.signal.addEventListener('abort', forwardAbort, { once: true });

            const firstByteTimeoutMs = Math.max(0, route.firstByteTimeoutMs || 0);
            let firstResponseTimer: ReturnType<typeof setTimeout> | null = null;
            let firstResponseTimedOut = false;
            const markFirstResponse = () => {
                if (firstResponseTimer) {
                    clearTimeout(firstResponseTimer);
                    firstResponseTimer = null;
                }
            };
            if (firstByteTimeoutMs > 0) {
                firstResponseTimer = setTimeout(() => {
                    firstResponseTimedOut = true;
                    // 关键：先真正取消当前 fetch/reader，再让 runApiFailover 进入下一条。
                    // 不能只 Promise.race，否则旧请求会在后台继续生成并可能重复扣费。
                    if (!routeAbort.signal.aborted) {
                        routeAbort.abort(
                            new Error(`first byte timeout ${firstByteTimeoutMs}ms`),
                        );
                    }
                }, firstByteTimeoutMs);
            }

            try {
                return await safeFetchJson(
                    `${baseUrl}/chat/completions`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization:
                                `Bearer ${route.api.apiKey || 'sk-none'}`,
                        },
                        body: JSON.stringify(body),
                        signal: routeAbort.signal,
                    },
                    0,
                    // 流式正文的 timeoutMs 不能是整轮总时长；首字前已有 firstResponseTimer。
                    // 正文一旦开始，就让 fetch 自己持续读到正常结束，避免长篇在固定秒数被腰斩。
                    body.stream
                        ? 0
                        : (options.plan.group?.policy.timeoutMs
                            ?? DEFAULT_API_FAILOVER_POLICY.timeoutMs),
                    meta,
                    wrapStreamHooks(
                        options.streamHooks,
                        context.markStreamStarted,
                        markFirstResponse,
                        Boolean(body.stream),
                        options.streamCommitMode || 'activity',
                    ),
                );
            } catch (error) {
                if (firstResponseTimedOut) {
                    throw new Error(
                        `首字等待超时（${Math.round(firstByteTimeoutMs / 1000)} 秒），已停止当前线路`,
                    );
                }
                throw error;
            } finally {
                markFirstResponse();
                context.signal.removeEventListener('abort', forwardAbort);
            }
        },
    });
}
