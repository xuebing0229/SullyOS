import type { ApiExecutionPlan } from './apiFailover';
import { ActiveMsgClient } from './activeMsgClient';
import {
    cloudApiCallLogId,
    recordCloudApiCall,
    settleCloudApiCall,
} from './apiCallLog';

const STORAGE_KEY = 'sully_story_cloud_pending_v1';
const POLL_MS = 1_000;
const HTTP_TIMEOUT_MS = 20_000;
const CAPABILITY_CACHE_MS = 60_000;

export interface PendingCloudStoryJob {
    jobId: string;
    clientRequestId: string;
    ownerKey: string;
    title: string;
    createdAt: number;
    meta?: Record<string, any>;
}

interface CloudStoryJob {
    jobId: string;
    clientRequestId: string;
    ownerKey: string;
    title: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    partialContent?: string;
    response?: any;
    error?: string;
    attempts?: Array<Record<string, any>>;
    promptTokens?: number;
    completionTokens?: number;
    reasoningChars?: number;
    visibleChars?: number;
    createdAt?: number;
    updatedAt?: number;
    startedAt?: number;
    completedAt?: number;
}

interface WorkerConfig {
    workerUrl: string;
    userId: string;
    serverToken?: string;
}

let capabilityCache: {
    key: string;
    at: number;
    available: boolean;
} | null = null;

const now = (): number => Date.now();

const randomPart = (): string => {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID().replace(/-/g, '');
        }
    } catch { /* fall through */ }
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
};

const makeJobId = (): string =>
    `storycloud_${now().toString(36)}_${randomPart()}`;

const makeClientRequestId = (): string =>
    `storyreq_${now().toString(36)}_${randomPart()}`;

const normalizeWorkerUrl = (value: string): string =>
    String(value || '').trim().replace(/\/+$/, '');

const readPendingMap = (): Record<string, PendingCloudStoryJob> => {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch {
        return {};
    }
};

const writePendingMap = (value: Record<string, PendingCloudStoryJob>): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch { /* best effort */ }
};

export const getPendingCloudStoryJob = (
    ownerKey: string,
): PendingCloudStoryJob | null => {
    const pending = readPendingMap()[ownerKey];
    return pending?.jobId && pending?.clientRequestId ? pending : null;
};

const savePendingCloudStoryJob = (pending: PendingCloudStoryJob): void => {
    const map = readPendingMap();
    map[pending.ownerKey] = pending;
    writePendingMap(map);
};

/**
 * 只清客户端“待接回”指针，不删除远端 job。
 * 和后台生图一样，terminal job 留给服务端 7 天 retention；这样 App 在“拿到完整正文→
 * IndexedDB 落楼层”之间被杀，重进还能把同一份结果接回来。
 */
export const clearPendingCloudStoryJob = async (
    ownerKey: string,
): Promise<void> => {
    const map = readPendingMap();
    if (!map[ownerKey]) return;
    delete map[ownerKey];
    writePendingMap(map);
};

const resolveWorkerConfig = (): WorkerConfig | null => {
    try {
        const config = ActiveMsgClient.getGlobalConfig();
        const workerUrl = normalizeWorkerUrl(config.workerUrl || '');
        const userId = String(config.userId || '').trim();
        if (!/^https?:\/\//i.test(workerUrl) || !userId) return null;
        return {
            workerUrl,
            userId,
            serverToken: String(config.serverToken || '').trim() || undefined,
        };
    } catch {
        return null;
    }
};

const fetchJson = async (
    config: WorkerConfig,
    path: string,
    init: RequestInit = {},
): Promise<{ response: Response; body: any }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const headers = new Headers(init.headers || {});
        headers.set('Accept', 'application/json');
        headers.set('X-User-Id', config.userId);
        if (config.serverToken) headers.set('X-Client-Token', config.serverToken);
        if (init.body !== undefined) headers.set('Content-Type', 'application/json');
        const response = await fetch(
            `${config.workerUrl}${path.startsWith('/') ? path : `/${path}`}`,
            {
                ...init,
                headers,
                cache: 'no-store',
                signal: controller.signal,
            },
        );
        const text = await response.text();
        let body: any = null;
        if (text) {
            try { body = JSON.parse(text); }
            catch { body = { error: text.slice(0, 500) }; }
        }
        return { response, body };
    } finally {
        clearTimeout(timeout);
    }
};

export const isCloudStoryJobsAvailable = async (): Promise<boolean> => {
    const config = resolveWorkerConfig();
    if (!config) return false;
    const key = `${config.workerUrl}\u0000${config.userId}`;
    if (
        capabilityCache
        && capabilityCache.key === key
        && capabilityCache.available === true
        && now() - capabilityCache.at < CAPABILITY_CACHE_MS
    ) return true;

    try {
        const { response, body } = await fetchJson(config, '/config-check');

        if (response.ok && body?.success !== false) {
            const available = body?.data?.storyJobs === true
                && body?.data?.storyTick === true;
            // 只缓存“明确支持”。明确不支持不能长期钉死：Worker 可能刚在另一条链路更新完成。
            if (available) capabilityCache = { key, at: now(), available: true };
            return available;
        }

        // 4xx / 明确配置缺失表示这台 Worker 当前确实不能接 Story Jobs。
        // 5xx / Deno 502 / 临时上游故障只说明“这次探测失败”，不能因此退回已知会被后台掐死的 native SSE。
        const explicitUnsupported =
            (response.status >= 400 && response.status < 500)
            || body?.error?.code === 'WORKER_CONFIG_MISSING';
        if (explicitUnsupported) return false;

        console.warn('[StoryTheater] cloud story capability probe inconclusive; trying cloud transport anyway', {
            status: response.status,
            workerHost: (() => {
                try { return new URL(config.workerUrl).host; }
                catch { return config.workerUrl; }
            })(),
        });
        return true;
    } catch (error) {
        // “探测不到”不是“不支持”。即时聊天已经踩过同一类坑：网络抖一下不能把能力判死。
        // 这里宁可真正尝试一次云端 job，让提交路径给出明确错误/不确定态，也绝不静默回退 native SSE。
        console.warn('[StoryTheater] cloud story capability probe failed; trying cloud transport anyway', error);
        return true;
    }
};

const getRemoteJobById = async (
    config: WorkerConfig,
    jobId: string,
): Promise<CloudStoryJob | null> => {
    const { response, body } = await fetchJson(
        config,
        `/story-jobs/${encodeURIComponent(jobId)}`,
    );
    if (!response.ok) {
        throw new Error(
            body?.error?.message
            || body?.error
            || `剧情云端任务查询失败（HTTP ${response.status}）`,
        );
    }
    return body?.job || null;
};

const getRemoteJobByClientId = async (
    config: WorkerConfig,
    clientRequestId: string,
): Promise<CloudStoryJob | null> => {
    const { response, body } = await fetchJson(
        config,
        `/story-jobs/by-client/${encodeURIComponent(clientRequestId)}`,
    );
    if (!response.ok) {
        throw new Error(
            body?.error?.message
            || body?.error
            || `剧情云端任务查询失败（HTTP ${response.status}）`,
        );
    }
    return body?.job || null;
};

const sleepUntilPollOrVisible = (): Promise<void> =>
    new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibility);
            }
            resolve();
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') finish();
        };
        const timer = setTimeout(finish, POLL_MS);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility, { once: true });
        }
    });

const cloudDiagnostics = (
    job: CloudStoryJob | null,
    config: WorkerConfig,
): Record<string, unknown> => ({
    jobId: job?.jobId,
    clientRequestId: job?.clientRequestId,
    status: job?.status,
    workerHost: (() => {
        try { return new URL(config.workerUrl).host; }
        catch { return config.workerUrl; }
    })(),
    promptTokens: job?.promptTokens,
    completionTokens: job?.completionTokens,
    reasoningChars: job?.reasoningChars,
    visibleChars: job?.visibleChars,
    createdAt: job?.createdAt,
    startedAt: job?.startedAt,
    updatedAt: job?.updatedAt,
    completedAt: job?.completedAt,
    attempts: job?.attempts,
});

const resolveSuccessfulRoute = (
    job: CloudStoryJob,
    plan: ApiExecutionPlan,
) => {
    const attempts = Array.isArray(job.attempts) ? job.attempts : [];
    const success = attempts.find(attempt => attempt?.ok === true);
    const index = Number(success?.routeIndex);
    return Number.isInteger(index) && index >= 0 && index < plan.routes.length
        ? plan.routes[index]
        : plan.routes[0];
};

const toCloudError = (
    message: string,
    job: CloudStoryJob | null,
    config: WorkerConfig,
    options: {
        terminal?: boolean;
        submissionUncertain?: boolean;
        knownResponse?: boolean;
    } = {},
): Error => {
    const error: any = new Error(message);
    error.partialContent = String(job?.partialContent || '');
    error.cloudStoryDiagnostics = cloudDiagnostics(job, config);
    error.cloudStoryTerminal = options.terminal === true;
    error.cloudStorySubmissionUncertain = options.submissionUncertain === true;
    error.cloudStoryKnownResponse = options.knownResponse === true;
    return error;
};

export interface ExecuteCloudStoryOptions {
    ownerKey: string;
    title: string;
    plan: ApiExecutionPlan;
    body: Record<string, any>;
    meta?: Record<string, any>;
    onPromptTokens?: (tokens: number) => void;
    onStreamText?: (fullText: string) => void;
}

export const executeStoryCompletionInCloudBackground = async (
    options: ExecuteCloudStoryOptions,
): Promise<any> => {
    const config = resolveWorkerConfig();
    if (!config) throw new Error('主动消息 Worker 尚未配置，不能使用剧情云端后台任务');

    let pending = getPendingCloudStoryJob(options.ownerKey);
    const recoveringExistingPending = Boolean(pending);
    if (!pending) {
        pending = {
            jobId: makeJobId(),
            clientRequestId: makeClientRequestId(),
            ownerKey: options.ownerKey,
            title: options.title,
            createdAt: now(),
            meta: options.meta,
        };
        // 与后台生图同一原则：POST 之前先把 clientRequestId 留在本地。
        // 即使响应在路上丢了，回来后也先 by-client 查，绝不造第二个模型请求。
        savePendingCloudStoryJob(pending);
    }

    const firstRoute = options.plan.routes[0];
    const logId = cloudApiCallLogId(pending.clientRequestId);
    let job: CloudStoryJob | null = null;

    // 恢复时优先按 jobId / clientRequestId 找已有任务；只有服务端明确说不存在才允许 POST。
    let lookupFailed = false;
    try {
        job = await getRemoteJobById(config, pending.jobId);
        if (!job) job = await getRemoteJobByClientId(config, pending.clientRequestId);
    } catch {
        // 查询本身断网时不能据此判断“任务不存在”。
        lookupFailed = true;
    }

    if (!job && recoveringExistingPending && lookupFailed) {
        // 旧 pending 最危险：它可能已经在 Worker 里生成，只是手机此刻查不到。
        // 绝不因为一次 GET 失败就再 POST；直接进入下面的恢复轮询。
    } else if (!job) {
        const spec = {
            jobId: pending.jobId,
            clientRequestId: pending.clientRequestId,
            ownerKey: pending.ownerKey,
            title: pending.title,
            mode: options.plan.mode,
            routes: options.plan.routes.map(route => ({
                presetId: route.presetId,
                presetName: route.presetName,
                baseUrl: route.api.baseUrl,
                apiKey: route.api.apiKey,
                model: route.api.model,
                ...(typeof route.api.temperature === 'number'
                    ? { temperature: route.api.temperature }
                    : {}),
                ...(route.firstByteTimeoutMs
                    ? { firstByteTimeoutMs: route.firstByteTimeoutMs }
                    : {}),
            })),
            baseBody: {
                ...options.body,
                stream: true,
            },
        };

        try {
            const { response, body } = await fetchJson(config, '/story-jobs', {
                method: 'POST',
                body: JSON.stringify(spec),
            });
            if (!response.ok) {
                const code = String(body?.error?.code || '');
                const responseJob = body?.job || null;
                if (response.status === 404 || code === 'INSTANT_TICK_STORY_MISSING') {
                    capabilityCache = null;
                }
                // 这是 Worker 明确回来的 HTTP 结论，不是“POST 响应在路上丢了”。
                // 有 job（例如旧 Worker 缺执行能力）就保留 pending 等更新后接回；
                // 没 job 的 4xx/5xx 则明确没有可接回任务，清掉本地指针。
                if (!responseJob) {
                    await clearPendingCloudStoryJob(options.ownerKey);
                }
                throw toCloudError(
                    body?.error?.message
                    || body?.error
                    || `剧情云端任务提交失败（HTTP ${response.status}）`,
                    responseJob,
                    config,
                    {
                        terminal: !responseJob,
                        knownResponse: true,
                    },
                );
            }
            job = body?.job || null;
        } catch (submitError: any) {
            if (submitError?.cloudStoryKnownResponse === true) throw submitError;
            // POST 的响应丢了 ≠ POST 没到。和后台生图一样只用同一个 clientRequestId 查账，
            // 不自动再 POST 一遍。
            for (let attempt = 0; attempt < 4 && !job; attempt += 1) {
                await sleepUntilPollOrVisible();
                try {
                    job = await getRemoteJobByClientId(config, pending.clientRequestId);
                } catch { /* 下一次再查 */ }
            }
            if (!job) {
                throw toCloudError(
                    `剧情云端任务提交结果不确定：${submitError?.message || submitError}。为避免重复扣费，本轮不会自动重发；恢复网络后会继续按同一 clientRequestId 查找。`,
                    null,
                    config,
                    { submissionUncertain: true },
                );
            }
        }

    }

    // 无论是刚提交还是进程重启后重新发现的 job，都用同一个 id 补上 API 调用记录。
    // DB 按 id 合并；重复写不会产生第二笔费用记录。
    if (job && firstRoute) {
        recordCloudApiCall({
            id: logId,
            route: 'cloud-story-job',
            baseUrl: firstRoute.api.baseUrl,
            model: firstRoute.api.model,
            messages: options.body.messages,
            meta: {
                appId: 'date',
                appName: '剧情剧场',
                purpose: '剧情续写',
                apiPresetId: firstRoute.presetId,
                apiPresetName: firstRoute.presetName,
            },
        });
    }

    let lastPartial = '';
    while (true) {
        if (!job) {
            await sleepUntilPollOrVisible();
            try {
                job = await getRemoteJobById(config, pending.jobId);
                if (!job) job = await getRemoteJobByClientId(config, pending.clientRequestId);
            } catch {
                continue;
            }
            if (!job) continue;
        }

        const partial = String(job.partialContent || '');
        if (partial && partial !== lastPartial) {
            lastPartial = partial;
            options.onStreamText?.(partial);
        }

        if (job.status === 'succeeded') {
            const successfulRoute = resolveSuccessfulRoute(job, options.plan);
            if (successfulRoute) {
                recordCloudApiCall({
                    id: logId,
                    route: 'cloud-story-job',
                    baseUrl: successfulRoute.api.baseUrl,
                    model: successfulRoute.api.model,
                    messages: options.body.messages,
                    timestamp: pending.createdAt,
                    meta: {
                        appId: 'date',
                        appName: '剧情剧场',
                        purpose: '剧情续写',
                        apiPresetId: successfulRoute.presetId,
                        apiPresetName: successfulRoute.presetName,
                    },
                });
            }
            const promptTokens = Number(job.promptTokens);
            const completionTokens = Number(job.completionTokens);
            if (Number.isFinite(promptTokens) && promptTokens > 0) {
                options.onPromptTokens?.(promptTokens);
            }
            settleCloudApiCall({
                id: logId,
                ok: true,
                promptTokens: Number.isFinite(promptTokens) ? promptTokens : undefined,
                completionTokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
            });
            if (!job.response) {
                throw toCloudError('剧情云端任务完成了，但没有保存响应正文', job, config, { terminal: true });
            }
            return job.response;
        }

        if (job.status === 'failed' || job.status === 'cancelled') {
            settleCloudApiCall({ id: logId, ok: false });
            throw toCloudError(
                job.error || (job.status === 'cancelled' ? '剧情云端任务已取消' : '剧情云端任务失败'),
                job,
                config,
                { terminal: true },
            );
        }

        await sleepUntilPollOrVisible();
        try {
            job = await getRemoteJobById(config, pending.jobId);
        } catch {
            // 手机后台时这条短轮询断掉无所谓；真正 LLM 流在 Worker/DO 里。
            // 回前台后继续查同一个 job。
        }
    }
};
