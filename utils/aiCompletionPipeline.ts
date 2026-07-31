import type { ApiCallMeta } from './apiCallLog';
import { recordApiCall } from './apiCallLog';
import {
    executeOpenAiChatPlan,
    type ApiExecutionPlan,
    type ApiFailoverRunResult,
} from './apiFailover';
import {
    runAiRequest,
    type AiRequestSource,
} from './aiRequestManager';
import {
    CHAT_RESPONSE_CACHE_VERSION,
    shouldPersistChatCompletion,
} from './chatResponseCachePolicy';
import { extractAssistantText } from './emotionApply';
import type { StreamHooks } from './safeApi';

/**
 * 这两个 promptVersion 只描述“请求材料/编排协议”的版本。
 * 真正用于废弃旧缓存的是 runAiRequest 的 version 字段。
 */
export const CHAT_PIPELINE_PROMPT_VERSION =
    'chat-prompt-v2-upstream-6c07fdef';
export const EMOTION_PIPELINE_PROMPT_VERSION =
    'emotion-prompt-v2-upstream-6c07fdef';

/**
 * 情绪结果必须按“当前用户消息 + 当前助手回复”识别。
 * 不要只按 prompt 文本做模糊缓存，避免跨轮复用旧情绪。
 */
export const EMOTION_RESPONSE_CACHE_VERSION =
    'emotion-response-cache-v2-round-aware';

export interface AiCompletionPipelineResult<T = any> {
    value: T;
    source: AiRequestSource;
    networkRequest: boolean;
    cacheKey: string;
    durationMs: number;
    /** 仅实际联网时存在；缓存命中不需要也不应伪造线路。 */
    route?: ApiFailoverRunResult<T>['route'];
}

export interface CachedChatCompletionOptions {
    plan: ApiExecutionPlan;
    body: Record<string, any>;
    meta: ApiCallMeta;
    streamHooks?: StreamHooks;
    signal?: AbortSignal;
    directMaxRetries?: number;
    forceRefresh?: boolean;
    bypassCache?: boolean;
    knownTextToolNames?: string[];
}

export interface EmotionRoundIdentity {
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
}

export interface CachedEmotionCompletionOptions {
    plan: ApiExecutionPlan;
    body: Record<string, any>;
    meta: ApiCallMeta;
    round?: EmotionRoundIdentity;
    signal?: AbortSignal;
    directMaxRetries?: number;
    forceRefresh?: boolean;
    bypassCache?: boolean;
}

function endpointForPlan(plan: ApiExecutionPlan): string {
    const baseUrl = String(plan.primaryApi.baseUrl || '')
        .trim()
        .replace(/\/+$/, '');
    return `${baseUrl}/chat/completions`;
}

function requestCharLength(body: Record<string, any>): number {
    try {
        return JSON.stringify(body).length;
    } catch {
        return 0;
    }
}

/**
 * safeFetchJson / OSContext 只会看到真实 HTTP。
 * 本地 IndexedDB 命中与内存并发复用没有 HTTP，因此必须在这里补一条 ¥0 日志。
 */
function recordLocalReuse(input: {
    plan: ApiExecutionPlan;
    body: Record<string, any>;
    value: any;
    meta: ApiCallMeta;
    source: AiRequestSource;
    durationMs: number;
    cacheKey: string;
}): void {
    recordApiCall({
        url: endpointForPlan(input.plan),
        body: input.body,
        ok: true,
        response: input.value,
        durationMs: Math.round(input.durationMs),
        source: input.source,
        cacheHit: true,
        networkRequest: false,
        requestHash: input.cacheKey,
        requestChars: requestCharLength(input.body),
        meta: input.meta,
    });
}

/**
 * 主聊天统一管线：
 *   精确缓存 / 同请求并发去重
 *       -> 有序 API 故障转移
 *       -> safeFetchJson
 *       -> 全局调用日志与费用账本
 *
 * 注意：工具调用结果不得进入持久缓存。
 * shouldPersistChatCompletion 同时拦截原生 tool_calls 和已知正文兼容调用。
 */
export async function executeCachedChatCompletion(
    options: CachedChatCompletionOptions,
): Promise<AiCompletionPipelineResult<any>> {
    let networkResult: ApiFailoverRunResult<any> | undefined;

    const managed = await runAiRequest({
        kind: 'chat',
        version: CHAT_RESPONSE_CACHE_VERSION,
        request: {
            provider: options.plan.cacheIdentity,
            body: options.body,
            promptVersion: CHAT_PIPELINE_PROMPT_VERSION,
        },
        provider: options.plan.cacheIdentity,
        model: String(
            options.body.model
            || options.plan.primaryApi.model
            || '',
        ),
        promptVersion: CHAT_PIPELINE_PROMPT_VERSION,
        forceRefresh: Boolean(options.forceRefresh),
        bypass: Boolean(options.bypassCache),
        metadata: {
            charId: options.meta.charId,
            purpose: options.meta.purpose || '聊天回复',
        },
        shouldCache: response => shouldPersistChatCompletion(
            response,
            {
                knownTextToolNames:
                    options.knownTextToolNames || [],
            },
        ),
        execute: async () => {
            networkResult = await executeOpenAiChatPlan({
                plan: options.plan,
                body: options.body,
                meta: options.meta,
                streamHooks: options.streamHooks,
                signal: options.signal,
                directMaxRetries:
                    options.directMaxRetries ?? 2,
            });
            return networkResult.value;
        },
    });

    if (!managed.networkRequest) {
        recordLocalReuse({
            plan: options.plan,
            body: options.body,
            value: managed.value,
            meta: options.meta,
            source: managed.source,
            durationMs: managed.durationMs,
            cacheKey: managed.key,
        });
    }

    return {
        value: managed.value,
        source: managed.source,
        networkRequest: managed.networkRequest,
        cacheKey: managed.key,
        durationMs: managed.durationMs,
        route: networkResult?.route,
    };
}

/**
 * 本地情绪评估统一管线。
 *
 * Instant Push 的 worker 评估不走本机 IndexedDB，继续保持原逻辑；
 * 本函数只用于客户端本地评估、post-push 在线补评估等路径。
 */
export async function executeCachedEmotionCompletion(
    options: CachedEmotionCompletionOptions,
): Promise<AiCompletionPipelineResult<any>> {
    let networkResult: ApiFailoverRunResult<any> | undefined;

    const managed = await runAiRequest({
        kind: 'emotion',
        version: EMOTION_RESPONSE_CACHE_VERSION,
        request: {
            provider: options.plan.cacheIdentity,
            round: options.round || null,
            body: options.body,
            promptVersion: EMOTION_PIPELINE_PROMPT_VERSION,
        },
        provider: options.plan.cacheIdentity,
        model: String(
            options.body.model
            || options.plan.primaryApi.model
            || '',
        ),
        promptVersion: EMOTION_PIPELINE_PROMPT_VERSION,
        forceRefresh: Boolean(options.forceRefresh),
        bypass: Boolean(options.bypassCache),
        metadata: {
            charId: options.meta.charId,
            purpose: options.meta.purpose || '情绪评估',
            conversationId: options.round?.conversationId,
            userMessageId: options.round?.userMessageId,
            assistantMessageId:
                options.round?.assistantMessageId,
        },
        shouldCache: response =>
            Boolean(
                extractAssistantText(
                    response?.choices?.[0]?.message,
                ).trim(),
            ),
        execute: async () => {
            networkResult = await executeOpenAiChatPlan({
                plan: options.plan,
                body: options.body,
                meta: options.meta,
                signal: options.signal,
                directMaxRetries:
                    options.directMaxRetries ?? 2,
            });
            return networkResult.value;
        },
    });

    if (!managed.networkRequest) {
        recordLocalReuse({
            plan: options.plan,
            body: options.body,
            value: managed.value,
            meta: options.meta,
            source: managed.source,
            durationMs: managed.durationMs,
            cacheKey: managed.key,
        });
    }

    return {
        value: managed.value,
        source: managed.source,
        networkRequest: managed.networkRequest,
        cacheKey: managed.key,
        durationMs: managed.durationMs,
        route: networkResult?.route,
    };
}
