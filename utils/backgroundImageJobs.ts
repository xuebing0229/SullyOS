import { App } from '@capacitor/app';

import type {
    CharacterProfile,
    Message,
} from '../types';
import { DB } from './db';
import { ActiveMsgClient } from './activeMsgClient';
import type {
    BuiltinImageEngineId,
} from './builtinImageMcp';
import {
    callMcpTool,
    type McpServerConfig,
    type McpToolResult,
} from './mcpClient';
import {
    persistMcpGeneratedImages,
} from './mcpImagePersistence';
import { parseImageToolClientOptions, type AfterGenerateAction } from './imageToolPostAction';
import { sanitizeMcpOutcomeText } from './mcpSingleShotFlow';
import { captureImageGenerationBilling, type ImageGenerationBillingCapture } from './imageGenerationBilling';

export const BACKGROUND_IMAGE_JOB_EVENT =
    'sullyos:background-image-job-event';

const STORAGE_KEY =
    'aetheros.imageGeneration.backgroundJobs.v1';

const MAX_LOCAL_JOBS = 100;
const TERMINAL_RETENTION_MS =
    7 * 24 * 60 * 60 * 1000;
const FOREGROUND_POLL_MS = 4_000;
const HTTP_TIMEOUT_MS = 12_000;
const MAX_SUBMIT_ATTEMPTS = 10;
// 连续状态查询失败不能无限假装“还在生成”。
// 12 次在快速失败时约 48 秒；若每次都等满 12s timeout，则约 3 分钟以上。
// 真正的 queued/running 状态不会计入这里，只有查询本身失败才累计。
const MAX_RECONCILE_FAILURES = 12;

export type LocalBackgroundImageJobStatus =
    | 'submitting'
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled';

export interface LocalBackgroundImageJob {
    id: string;
    clientRequestId: string;
    remoteJobId?: string;

    engineId: BuiltinImageEngineId;
    serverId: string;
    serverName: string;
    controlBaseUrl: string;
    token: string;

    charId: string;
    /** 普通聊天沿用 chat；剧情剧场的图片要挂回指定正文楼层，不能当普通聊天图片落库。 */
    ownerType?: 'chat' | 'story-theater';
    storyTheaterTarget?: {
        entryId: string;
        messageId: number;
        title: string;
    };
    toolName: string;
    toolArgs: Record<string, any>;
    afterGenerateAction: AfterGenerateAction;
    inspectStatus?: 'pending' | 'running' | 'done' | 'failed';
    inspectError?: string;

    status: LocalBackgroundImageJobStatus;
    createdAt: number;
    updatedAt: number;
    lastCheckedAt?: number;
    submitAttempts: number;
    /** 云端剧情 handoff 由 Worker 独占首发权；客户端只查状态，永不自动补交。 */
    workerOwnsSubmission?: boolean;
    resultAppliedAt?: number;
    lastError?: string;
    imageBillingCapture?: ImageGenerationBillingCapture;
}

interface LocalState {
    version: 1;
    jobs: LocalBackgroundImageJob[];
}


export interface BackgroundImageJobsBackup {
    version: 1;
    exportedAt: number;
    jobs: LocalBackgroundImageJob[];
}

interface RemoteImageJob {
    id: string;
    clientRequestId: string;
    toolName: string;
    status:
        | 'queued'
        | 'running'
        | 'succeeded'
        | 'failed'
        | 'cancelled';
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    completedAt?: number;
    result?: {
        structuredContent?: any;
        content?: any[];
        [key: string]: any;
    };
    error?: {
        code?: string;
        message?: string;
    };
}

interface MonitorOptions {
    onCompleted?: (
        job: LocalBackgroundImageJob,
    ) => void;
    onFailed?: (
        job: LocalBackgroundImageJob,
    ) => void;
}

class JobHttpError extends Error {
    status: number;
    body: any;

    constructor(
        status: number,
        message: string,
        body?: any,
    ) {
        super(message);
        this.name = 'JobHttpError';
        this.status = status;
        this.body = body;
    }
}

const clone = <T,>(value: T): T =>
    JSON.parse(JSON.stringify(value));

const now = (): number => Date.now();

const randomPart = (): string => {
    try {
        if (
            typeof crypto !== 'undefined'
            && typeof crypto.randomUUID
                === 'function'
        ) {
            return crypto
                .randomUUID()
                .replace(/-/g, '');
        }
    } catch {
        // fall through
    }

    return (
        Math.random().toString(36).slice(2)
        + Math.random().toString(36).slice(2)
    );
};

const makeLocalId = (): string =>
    `bgimg_${now().toString(36)}_${randomPart()}`;

const makeClientRequestId = (): string =>
    `sully_bgimg_${now().toString(36)}_${randomPart()}`;

const normalizeBaseUrl = (
    value: string,
): string =>
    value.trim().replace(/\/+$/, '');

const engineIdFromServer = (
    server: McpServerConfig,
): BuiltinImageEngineId | null => {
    if (
        server.imagePresetEngineId === 'gpt-image'
        || server.imagePresetEngineId === 'novelai'
    ) return server.imagePresetEngineId;

    if (
        server.id ===
        'builtin_image_gpt-image'
    ) return 'gpt-image';

    if (
        server.id ===
        'builtin_image_novelai'
    ) return 'novelai';

    return null;
};

const expectedToolForEngine = (
    engineId: BuiltinImageEngineId,
): string =>
    engineId === 'gpt-image'
        ? 'generate_image'
        : 'novelai_generate_image';

export const isBackgroundImageToolCall = (
    server: McpServerConfig,
    toolName: string,
): boolean => {
    const engineId =
        engineIdFromServer(server);

    return Boolean(
        engineId
        && server.builtin === true
        && server.controlBaseUrl
        && toolName ===
            expectedToolForEngine(engineId),
    );
};

const sanitizeLoadedJob = (
    value: unknown,
): LocalBackgroundImageJob | null => {
    if (
        !value
        || typeof value !== 'object'
    ) return null;

    const raw = value as any;

    if (
        raw.engineId !== 'gpt-image'
        && raw.engineId !== 'novelai'
    ) return null;

    if (
        typeof raw.id !== 'string'
        || typeof raw.clientRequestId !== 'string'
        || typeof raw.serverId !== 'string'
        || typeof raw.serverName !== 'string'
        || typeof raw.controlBaseUrl !== 'string'
        || typeof raw.token !== 'string'
        || typeof raw.charId !== 'string'
        || typeof raw.toolName !== 'string'
        || !raw.toolArgs
        || typeof raw.toolArgs !== 'object'
        || Array.isArray(raw.toolArgs)
        || typeof raw.status !== 'string'
        || !Number.isFinite(raw.createdAt)
        || !Number.isFinite(raw.updatedAt)
    ) return null;

    return {
        id: raw.id,
        clientRequestId:
            raw.clientRequestId,
        remoteJobId:
            typeof raw.remoteJobId === 'string'
                ? raw.remoteJobId
                : undefined,
        engineId: raw.engineId,
        serverId: raw.serverId,
        serverName: raw.serverName,
        controlBaseUrl:
            normalizeBaseUrl(
                raw.controlBaseUrl,
            ),
        token: raw.token,
        charId: raw.charId,
        ownerType: raw.ownerType === 'story-theater' ? 'story-theater' : 'chat',
        storyTheaterTarget: raw.ownerType === 'story-theater'
            && raw.storyTheaterTarget
            && typeof raw.storyTheaterTarget.entryId === 'string'
            && Number.isFinite(raw.storyTheaterTarget.messageId)
            && typeof raw.storyTheaterTarget.title === 'string'
            ? {
                entryId: raw.storyTheaterTarget.entryId,
                messageId: Number(raw.storyTheaterTarget.messageId),
                title: raw.storyTheaterTarget.title,
            }
            : undefined,
        toolName: raw.toolName,
        toolArgs: clone(raw.toolArgs),
        afterGenerateAction: raw.afterGenerateAction === 'inspect' ? 'inspect' : 'none',
        inspectStatus: ['pending', 'running', 'done', 'failed'].includes(raw.inspectStatus)
            ? raw.inspectStatus
            : undefined,
        inspectError: typeof raw.inspectError === 'string' ? raw.inspectError : undefined,
        status: raw.status,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        lastCheckedAt:
            Number.isFinite(raw.lastCheckedAt)
                ? raw.lastCheckedAt
                : undefined,
        submitAttempts:
            Number.isFinite(raw.submitAttempts)
                ? Math.max(0, raw.submitAttempts)
                : 0,
        // 兼容 2.3.204：旧版的 submitNotBefore 只会出现在云端剧情 adopt 任务上。
        workerOwnsSubmission:
            raw.workerOwnsSubmission === true
            || (raw.ownerType === 'story-theater' && Number.isFinite(raw.submitNotBefore)),
        resultAppliedAt:
            Number.isFinite(raw.resultAppliedAt)
                ? raw.resultAppliedAt
                : undefined,
        lastError:
            typeof raw.lastError === 'string'
                ? raw.lastError
                : undefined,
        imageBillingCapture: raw.imageBillingCapture && typeof raw.imageBillingCapture === 'object'
            ? clone(raw.imageBillingCapture)
            : undefined,
    };
};

const readState = (): LocalState => {
    try {
        const raw =
            localStorage.getItem(STORAGE_KEY);

        if (!raw) {
            return { version: 1, jobs: [] };
        }

        const parsed = JSON.parse(raw);
        const jobs = Array.isArray(parsed?.jobs)
            ? parsed.jobs
                .map(sanitizeLoadedJob)
                .filter(Boolean) as LocalBackgroundImageJob[]
            : [];

        return { version: 1, jobs };
    } catch {
        return { version: 1, jobs: [] };
    }
};

const writeState = (
    state: LocalState,
): void => {
    const cutoff =
        now() - TERMINAL_RETENTION_MS;

    const jobs = state.jobs
        .filter(job => {
            if (
                !job.resultAppliedAt
                && job.status !== 'failed'
                && job.status !== 'cancelled'
            ) return true;

            return job.updatedAt >= cutoff;
        })
        .sort(
            (a, b) =>
                b.createdAt - a.createdAt,
        )
        .slice(0, MAX_LOCAL_JOBS);

    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
            version: 1,
            jobs,
        }),
    );
};

const restoreStateWithoutPruning = (state: LocalState): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clone(state)));
};

const upsertJob = (
    job: LocalBackgroundImageJob,
): void => {
    const state = readState();
    const index = state.jobs.findIndex(
        item => item.id === job.id,
    );

    if (index >= 0) {
        state.jobs[index] = clone(job);
    } else {
        state.jobs.push(clone(job));
    }

    writeState(state);
};

const updateJob = (
    id: string,
    patch: Partial<LocalBackgroundImageJob>,
): LocalBackgroundImageJob | null => {
    const state = readState();
    const index = state.jobs.findIndex(
        item => item.id === id,
    );

    if (index < 0) return null;

    const updated = {
        ...state.jobs[index],
        ...patch,
        updatedAt: now(),
    };

    state.jobs[index] = updated;
    writeState(state);
    return updated;
};

const removeJob = (id: string): void => {
    const state = readState();
    state.jobs = state.jobs.filter(job => job.id !== id);
    writeState(state);
};

const getUnfinishedJobs = ():
LocalBackgroundImageJob[] =>
    readState().jobs
        .filter(job =>
            !job.resultAppliedAt
            && job.status !== 'failed'
            && job.status !== 'cancelled',
        )
        .sort(
            (a, b) =>
                a.createdAt - b.createdAt,
        );

const parseResponseBody = async (
    response: Response,
): Promise<any> => {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { message: text.slice(0, 500) };
    }
};

const fetchJson = async (
    url: string,
    token: string,
    init: RequestInit = {},
): Promise<any> => {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        HTTP_TIMEOUT_MS,
    );

    try {
        const headers =
            new Headers(init.headers || {});
        headers.set('Accept', 'application/json');
        headers.set(
            'Authorization',
            `Bearer ${token}`,
        );
        if (init.body !== undefined) {
            headers.set(
                'Content-Type',
                'application/json',
            );
        }

        const response = await fetch(
            url,
            {
                ...init,
                headers,
                cache: 'no-store',
                signal: controller.signal,
            },
        );

        const body =
            await parseResponseBody(response);

        if (!response.ok) {
            throw new JobHttpError(
                response.status,
                String(
                    body?.message
                    || body?.error
                    || `HTTP ${response.status}`,
                ),
                body,
            );
        }

        return body;
    } finally {
        clearTimeout(timeout);
    }
};

const isPermanentSubmitError = (
    error: unknown,
): boolean =>
    error instanceof JobHttpError
    && [
        400,
        401,
        403,
        409,
        422,
    ].includes(error.status);

const isUnsupportedJobsEndpointError = (
    error: unknown,
): boolean =>
    error instanceof JobHttpError
    && [404, 405, 501].includes(error.status);

const isRemoteJobNotFoundError = (
    error: unknown,
): boolean =>
    error instanceof JobHttpError
    && error.status === 404
    && error.body?.error === 'job_not_found';

const submitRemoteJob = async (
    job: LocalBackgroundImageJob,
): Promise<RemoteImageJob> => {
    const body = await fetchJson(
        `${normalizeBaseUrl(job.controlBaseUrl)}/jobs`,
        job.token,
        {
            method: 'POST',
            body: JSON.stringify({
                clientRequestId:
                    job.clientRequestId,
                toolName:
                    job.toolName,
                arguments:
                    job.toolArgs,
            }),
        },
    );

    if (
        !body?.job
        || typeof body.job.id !== 'string'
    ) {
        throw new Error(
            '后台生图服务返回了无效任务',
        );
    }

    return body.job;
};

const findRemoteJobByClientId =
async (
    job: LocalBackgroundImageJob,
): Promise<RemoteImageJob | null> => {
    try {
        const body = await fetchJson(
            `${normalizeBaseUrl(job.controlBaseUrl)}`
            + `/jobs/by-client/`
            + encodeURIComponent(
                job.clientRequestId,
            ),
            job.token,
        );

        return body?.job || null;
    } catch (error) {
        if (isRemoteJobNotFoundError(error)) return null;
        throw error;
    }
};

const getRemoteJobById = async (
    job: LocalBackgroundImageJob,
): Promise<RemoteImageJob | null> => {
    if (!job.remoteJobId) return null;

    try {
        const body = await fetchJson(
            `${normalizeBaseUrl(job.controlBaseUrl)}`
            + `/jobs/`
            + encodeURIComponent(
                job.remoteJobId,
            ),
            job.token,
        );

        return body?.job || null;
    } catch (error) {
        if (isRemoteJobNotFoundError(error)) return null;
        throw error;
    }
};

interface WorkerStoryImageHandoffState {
    state?: 'submitted' | 'failed' | 'skipped';
    remoteJobId?: string;
    error?: string;
    uncertain?: boolean;
}

const getWorkerStoryImageHandoff = async (
    job: LocalBackgroundImageJob,
): Promise<WorkerStoryImageHandoffState | null> => {
    if (!job.workerOwnsSubmission) return null;
    const imageClientRequestId = String(job.clientRequestId || '');
    if (!imageClientRequestId.startsWith('storyimg_')) return null;
    const storyClientRequestId = imageClientRequestId.slice('storyimg_'.length);
    if (!storyClientRequestId) return null;

    try {
        const config = await ActiveMsgClient.getGlobalConfig();
        const workerUrl = String(config.workerUrl || '').trim().replace(/\/+$/, '');
        const userId = String(config.userId || '').trim();
        if (!/^https?:\/\//i.test(workerUrl) || !userId) return null;

        const headers = new Headers({
            Accept: 'application/json',
            'X-User-Id': userId,
        });
        const serverToken = String(config.serverToken || '').trim();
        if (serverToken) headers.set('X-Client-Token', serverToken);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        try {
            const response = await fetch(
                `${workerUrl}/story-jobs/by-client/${encodeURIComponent(storyClientRequestId)}`,
                {
                    method: 'GET',
                    headers,
                    cache: 'no-store',
                    signal: controller.signal,
                },
            );
            if (!response.ok) return null;
            const body = await response.json().catch(() => null);
            const handoff = body?.job?.response?._sullyStoryImageHandoff;
            return handoff && typeof handoff === 'object'
                ? handoff as WorkerStoryImageHandoffState
                : null;
        } finally {
            clearTimeout(timeout);
        }
    } catch {
        // 这里只是补充 Worker 的最终 handoff 诊断；查询失败不应制造第二张图，也不应误判图片失败。
        return null;
    }
};

const remoteStatusToLocal = (
    status: RemoteImageJob['status'],
): LocalBackgroundImageJobStatus =>
    status === 'running'
        ? 'running'
        : status === 'succeeded'
            ? 'succeeded'
            : status === 'failed'
                ? 'failed'
                : status === 'cancelled'
                    ? 'cancelled'
                    : 'queued';

const dispatchJobEvent = (
    type: 'completed' | 'failed' | 'updated' | 'dismissed',
    job: LocalBackgroundImageJob,
): void => {
    if (
        typeof window === 'undefined'
        || typeof CustomEvent === 'undefined'
    ) return;
    window.dispatchEvent(
        new CustomEvent(
            BACKGROUND_IMAGE_JOB_EVENT,
            {
                detail: {
                    type,
                    charId: job.charId,
                    localJobId: job.id,
                    remoteJobId:
                        job.remoteJobId,
                    clientRequestId: job.clientRequestId,
                    afterGenerateAction: job.afterGenerateAction,
                    inspectStatus: job.inspectStatus,
                    ownerType: job.ownerType || 'chat',
                    storyTheaterTarget: job.storyTheaterTarget,
                },
            },
        ),
    );
};

const hasFailureMessage = (
    messages: Message[],
    job: LocalBackgroundImageJob,
): boolean => messages.some(message =>
    message.metadata?.backgroundImageJobFailure === true
    && (
        message.metadata?.backgroundImageLocalJobId === job.id
        || message.metadata?.backgroundImageClientRequestId === job.clientRequestId
        || (
            job.remoteJobId
            && message.metadata?.backgroundImageJobId === job.remoteJobId
        )
    ),
);

export const persistBackgroundImageFailureMessage = async (
    job: LocalBackgroundImageJob,
): Promise<boolean> => {
    if (job.ownerType === 'story-theater') return false;
    const recent = await DB.getRecentMessagesByCharId(job.charId, 200);
    if (hasFailureMessage(recent, job)) return false;

    const detail = sanitizeMcpOutcomeText(
        job.lastError || '后台生图任务失败',
    ) || '后台生图任务失败';
    await DB.saveMessage({
        charId: job.charId,
        role: 'system',
        type: 'text',
        content: `[生图失败] ${detail}`,
        metadata: {
            backgroundImageJobFailure: true,
            backgroundImageLocalJobId: job.id,
            backgroundImageJobId: job.remoteJobId,
            backgroundImageClientRequestId: job.clientRequestId,
        },
    } as any);
    return true;
};

const markMonitoredJobFailed = async (
    jobId: string,
    error: unknown,
    options: MonitorOptions,
    patch: Partial<LocalBackgroundImageJob> = {},
): Promise<LocalBackgroundImageJob | null> => {
    const detail = sanitizeMcpOutcomeText(error)
        || '后台生图任务失败';
    const failed = updateJob(jobId, {
        ...patch,
        status: 'failed',
        lastError: detail,
    });
    if (!failed) return null;
    dispatchJobEvent('failed', failed);
    options.onFailed?.(failed);
    return failed;
};

const hasAlreadyPersisted = (
    messages: Message[],
    localJob: LocalBackgroundImageJob,
    remoteJob: RemoteImageJob,
): boolean =>
    messages.some(message =>
        message.metadata
            ?.backgroundImageJobId
            === remoteJob.id
        || message.metadata
            ?.backgroundImageClientRequestId
            === localJob.clientRequestId,
    );
const buildMcpResultFromRemoteJob = (
    remoteJob: RemoteImageJob,
): McpToolResult => {
    const result = remoteJob.result || {};
    const content = Array.isArray(result.content) ? result.content : [];
    const rawText = content
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
        .trim();
    return {
        success: true,
        data: result.structuredContent ?? result,
        structuredContent: result.structuredContent,
        content,
        rawText,
        rawResult: result,
    };
};

const applySucceededJob = async (
    localJob: LocalBackgroundImageJob,
    remoteJob: RemoteImageJob,
): Promise<void> => {
    const recentMessages = await DB.getMessagesByCharId(
        localJob.charId,
        true,
    );

    if (
        hasAlreadyPersisted(
            recentMessages,
            localJob,
            remoteJob,
        )
    ) {
        const updated = updateJob(
            localJob.id,
            {
                remoteJobId: remoteJob.id,
                status: 'succeeded',
                resultAppliedAt: now(),
                lastError: undefined,
            },
        );
        if (updated) dispatchJobEvent('completed', updated);
        return;
    }

    const mcpResult = buildMcpResultFromRemoteJob(remoteJob);

    if (
        localJob.ownerType === 'story-theater'
        && localJob.storyTheaterTarget
    ) {
        const target = recentMessages.find(
            message =>
                message.id
                === localJob.storyTheaterTarget!.messageId,
        );
        if (!target || target.role !== 'assistant') {
            throw new Error(
                '剧情配图完成了，但对应的正文楼层已不存在',
            );
        }

        // meeting-cg 只把二进制 + 相册记录落库，不额外制造普通聊天图片消息。
        // persistMcpGeneratedImages 实际只需要 owner 的 id/name；剧情线程本身就是独立 owner。
        const galleryOwner = {
            id: localJob.charId,
            name:
                localJob.storyTheaterTarget.title
                || '剧情剧场',
        } as CharacterProfile;

        const outcome = await persistMcpGeneratedImages({
            result: mcpResult,
            char: galleryOwner,
            server: {
                id: localJob.serverId,
                name: localJob.serverName,
            },
            toolName: localJob.toolName,
            toolArgs: localJob.toolArgs,
            recentMessages,
            ownerType: 'meeting-cg',
            allowTemporaryUrlFallback: false,
            extraGallerySourceMeta: {
                source: 'story-theater',
                theaterId:
                    localJob.storyTheaterTarget.entryId,
                theaterTitle:
                    localJob.storyTheaterTarget.title,
                backgroundImageJobId:
                    remoteJob.id,
                backgroundImageClientRequestId:
                    localJob.clientRequestId,
            },
            imageBillingCapture:
                localJob.imageBillingCapture,
        });

        const asset = outcome.assets[0];
        if (!asset) {
            throw new Error(
                outcome.errors[0]
                || '后台任务完成，但没有找到可挂回剧情的图片结果',
            );
        }

        await DB.updateMessageMetadata(
            target.id,
            previous => ({
                ...previous,
                backgroundImageJobId:
                    remoteJob.id,
                backgroundImageClientRequestId:
                    localJob.clientRequestId,
                backgroundGenerated: true,
                theaterImage: {
                    imageRef: asset.blobRef,
                    galleryImageId:
                        asset.galleryImageId,
                    prompt: asset.prompt,
                    engine: asset.engine,
                    generatedAt:
                        asset.createdAt,
                },
            }),
        );

        const updated = updateJob(
            localJob.id,
            {
                remoteJobId: remoteJob.id,
                status: 'succeeded',
                resultAppliedAt: now(),
                lastError: undefined,
            },
        );
        if (updated) dispatchJobEvent('completed', updated);
        return;
    }

    const characters = await DB.getAllCharacters();
    const character = characters.find(
        item => item.id === localJob.charId,
    );
    if (!character) {
        throw new Error('后台图片对应的角色已不存在');
    }

    const outcome = await persistMcpGeneratedImages({
        result: mcpResult,
        char: character as CharacterProfile,
        server: {
            id: localJob.serverId,
            name: localJob.serverName,
        },
        toolName: localJob.toolName,
        toolArgs: localJob.toolArgs,
        recentMessages,
        extraMessageMetadata: {
            backgroundImageJobId:
                remoteJob.id,
            backgroundImageClientRequestId:
                localJob.clientRequestId,
            backgroundGenerated: true,
        },
        extraGallerySourceMeta: {
            backgroundImageJobId:
                remoteJob.id,
            backgroundImageClientRequestId:
                localJob.clientRequestId,
        },
        imageBillingCapture:
            localJob.imageBillingCapture,
    });

    if (
        outcome.persisted <= 0
        && outcome.temporary <= 0
    ) {
        throw new Error(
            outcome.errors[0]
            || '后台任务完成，但没有找到图片结果',
        );
    }

    const updated = updateJob(
        localJob.id,
        {
            remoteJobId: remoteJob.id,
            status: 'succeeded',
            resultAppliedAt: now(),
            lastError: undefined,
        },
    );
    if (updated) dispatchJobEvent('completed', updated);
};

// 只统计“查询任务状态本身失败”的连续次数；一次成功查询立刻清零。
// 不写进备份，避免用户切屏/重启后因为旧错误计数直接误判失败。
const reconcileFailureCounts = new Map<string, number>();

const reconcileOne = async (
    localJob: LocalBackgroundImageJob,
    options: MonitorOptions,
): Promise<void> => {
    let remoteJob: RemoteImageJob | null = null;

    try {
        if (localJob.remoteJobId) {
            remoteJob = await getRemoteJobById(localJob);
        }

        if (!remoteJob) {
            remoteJob = await findRemoteJobByClientId(localJob);
        }

        if (!remoteJob) {
            if (localJob.workerOwnsSubmission) {
                // 云端剧情自动配图只有 Worker 能首发。手机永远只查账，不再用任何固定时间猜测
                // “Worker 可能挂了”然后补 POST。Worker 明确失败时，从 story job 的最终 handoff
                // 把失败同步回来；用户需要重试时手动点“重新生成”。
                const storyHandoff = await getWorkerStoryImageHandoff(localJob);
                if (storyHandoff?.state === 'failed') {
                    await markMonitoredJobFailed(
                        localJob.id,
                        storyHandoff.error || '剧情后台自动配图提交失败',
                        options,
                    );
                    return;
                }
                if (storyHandoff?.state === 'submitted' && storyHandoff.remoteJobId) {
                    const linked = updateJob(localJob.id, {
                        remoteJobId: storyHandoff.remoteJobId,
                        status: 'queued',
                        lastCheckedAt: now(),
                        lastError: undefined,
                    });
                    if (linked) remoteJob = await getRemoteJobById(linked);
                }
                if (!remoteJob) {
                    updateJob(localJob.id, {
                        status: 'submitting',
                        lastCheckedAt: now(),
                        lastError: undefined,
                    });
                    return;
                }
            }

            if (localJob.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
                await markMonitoredJobFailed(
                    localJob.id,
                    '后台生图任务多次提交失败',
                    options,
                );
                return;
            }

            const attempted = updateJob(localJob.id, {
                status: 'submitting',
                submitAttempts: localJob.submitAttempts + 1,
                lastCheckedAt: now(),
            });
            if (!attempted) return;

            try {
                remoteJob = await submitRemoteJob(attempted);
            } catch (error) {
                if (
                    isPermanentSubmitError(error)
                    || isUnsupportedJobsEndpointError(error)
                ) {
                    await markMonitoredJobFailed(
                        localJob.id,
                        isUnsupportedJobsEndpointError(error)
                            ? '当前生图服务不支持后台任务接口 /jobs，请更新服务端或重新发起直连生图。'
                            : error,
                        options,
                    );
                    return;
                }
                throw error;
            }
        }

        // 能拿到一次真实远端状态，就说明状态通道恢复了；清掉此前的连续查询失败计数。
        reconcileFailureCounts.delete(localJob.id);

        const updated = updateJob(localJob.id, {
            remoteJobId: remoteJob.id,
            status: remoteStatusToLocal(remoteJob.status),
            lastCheckedAt: now(),
            lastError: remoteJob.error?.message,
        });
        if (!updated) return;

        dispatchJobEvent('updated', updated);

        if (remoteJob.status === 'succeeded') {
            const saving = updateJob(updated.id, {
                status: 'succeeded',
                lastCheckedAt: now(),
            }) || updated;
            dispatchJobEvent('updated', saving);
            try {
                await applySucceededJob(saving, remoteJob);
            } catch (error) {
                await markMonitoredJobFailed(
                    updated.id,
                    error,
                    options,
                    { remoteJobId: remoteJob.id },
                );
                return;
            }

            const completed = readState().jobs.find(
                item => item.id === updated.id,
            );
            if (completed) options.onCompleted?.(completed);
            return;
        }

        if (
            remoteJob.status === 'failed'
            || remoteJob.status === 'cancelled'
        ) {
            await markMonitoredJobFailed(
                updated.id,
                remoteJob.error?.message
                    || (remoteJob.status === 'cancelled'
                        ? '后台生图任务已取消'
                        : '后台生图任务失败'),
                options,
                { remoteJobId: remoteJob.id },
            );
        }
    } catch (error) {
        if (isUnsupportedJobsEndpointError(error)) {
            reconcileFailureCounts.delete(localJob.id);
            await markMonitoredJobFailed(
                localJob.id,
                '当前生图服务不支持后台任务接口 /jobs，请更新服务端或重新发起直连生图。',
                options,
            );
            return;
        }

        const failureCount = (reconcileFailureCounts.get(localJob.id) || 0) + 1;
        reconcileFailureCounts.set(localJob.id, failureCount);
        const detail = sanitizeMcpOutcomeText(error)
            || '后台生图状态查询失败';

        // 4xx（除已单独处理的 404/405）基本不会靠继续轮询自愈，直接结束等待；
        // 其余网络/5xx/timeout 给一段恢复窗口，连续失败到上限后也必须显式失败，不能永久挂起。
        if (
            isPermanentSubmitError(error)
            || failureCount >= MAX_RECONCILE_FAILURES
        ) {
            reconcileFailureCounts.delete(localJob.id);
            await markMonitoredJobFailed(
                localJob.id,
                isPermanentSubmitError(error)
                    ? detail
                    : `后台生图状态连续查询失败 ${failureCount} 次：${detail}`,
                options,
            );
            return;
        }

        const current = readState().jobs.find(
            item => item.id === localJob.id,
        );
        if (
            current?.status !== 'failed'
            && current?.status !== 'cancelled'
        ) {
            updateJob(localJob.id, {
                lastCheckedAt: now(),
                lastError: detail,
            });
        }
    }
};

let reconcilePromise:
    Promise<void> | null = null;

export const reconcileBackgroundImageJobs =
async (
    options: MonitorOptions = {},
): Promise<void> => {
    if (reconcilePromise) {
        return reconcilePromise;
    }

    reconcilePromise = (
        async () => {
            const jobs =
                getUnfinishedJobs();

            for (const job of jobs) {
                await reconcileOne(
                    job,
                    options,
                );
            }
        }
    )().finally(() => {
        reconcilePromise = null;
    });

    return reconcilePromise;
};

const queuedToolResult = (
    job: LocalBackgroundImageJob,
    remoteJob?: RemoteImageJob,
): McpToolResult => ({
    success: true,
    data: {
        status: 'queued',
        message:
            'The image is being generated in the background. '
            + 'Tell the user that it will appear automatically. '
            + 'Do not invent an image URL and do not call the image tool again.',
    },
    rawText:
        'Image generation was queued in the background.',
    backgroundJob: {
        localJobId: job.id,
        clientRequestId:
            job.clientRequestId,
        remoteJobId:
            remoteJob?.id,
        status:
            remoteJob?.status === 'running'
                ? 'running'
                : remoteJob
                    ? 'queued'
                    : 'submitting',
        engineId:
            job.engineId,
    },
});

export const getBackgroundImageJobById = (id: string): LocalBackgroundImageJob | null =>
    readState().jobs.find(job => job.id === id) || null;


const failureMessageMatchesJob = (
    message: Message,
    job: LocalBackgroundImageJob,
): boolean => message.metadata?.backgroundImageJobFailure === true
    && (
        message.metadata?.backgroundImageLocalJobId === job.id
        || message.metadata?.backgroundImageClientRequestId === job.clientRequestId
        || (
            Boolean(job.remoteJobId)
            && message.metadata?.backgroundImageJobId === job.remoteJobId
        )
    );

/**
 * 只移除已经失败或取消的本地任务卡，并精确清理它们派生的失败提示消息。
 * 进行中、保存中和已成功任务不会被删除。
 */
export async function dismissBackgroundImageJobs(jobIds: string[]): Promise<number> {
    const wanted = new Set(jobIds.filter(Boolean));
    if (!wanted.size) return 0;

    const state = readState();
    const dismissible = state.jobs.filter(job =>
        wanted.has(job.id)
        && (job.status === 'failed' || job.status === 'cancelled'),
    );
    if (!dismissible.length) return 0;

    const charIds = Array.from(new Set(dismissible.map(job => job.charId)));
    const failureMessageIds = new Set<number>();
    for (const charId of charIds) {
        const messages = await DB.getMessagesByCharId(charId, true);
        messages.forEach(message => {
            if (dismissible.some(job => job.charId === charId && failureMessageMatchesJob(message, job))) {
                failureMessageIds.add(message.id);
            }
        });
    }
    const dismissedIds = new Set(dismissible.map(job => job.id));
    const originalState = clone(state);
    state.jobs = state.jobs.filter(job => !dismissedIds.has(job.id));
    writeState(state);
    try {
        if (failureMessageIds.size) {
            await DB.deleteMessages(Array.from(failureMessageIds));
        }
    } catch (error) {
        // localStorage 与 IndexedDB 无法共享事务；消息清理失败时恢复任务记录，
        // 避免卡片消失但失败提示仍留在聊天里。
        restoreStateWithoutPruning(originalState);
        throw error;
    }

    dismissible.forEach(job => dispatchJobEvent('dismissed', job));
    return dismissible.length;
}

export async function dismissBackgroundImageJob(jobId: string): Promise<boolean> {
    return (await dismissBackgroundImageJobs([jobId])) > 0;
}

export const getPendingBackgroundImageInspectJobs = (charId: string): LocalBackgroundImageJob[] =>
    readState().jobs.filter(job =>
        job.charId === charId
        && job.resultAppliedAt
        && job.afterGenerateAction === 'inspect'
        && job.inspectStatus === 'pending',
    );

export const updateBackgroundImageInspectStatus = (
    id: string,
    status: 'running' | 'done' | 'failed',
    error?: string,
): LocalBackgroundImageJob | null => {
    const current = getBackgroundImageJobById(id);
    if (!current) return null;
    if (status === 'running' && current.inspectStatus !== 'pending') return null;
    if ((status === 'done' || status === 'failed') && current.inspectStatus !== 'running') return null;
    return updateJob(id, {
        inspectStatus: status,
        inspectError: error,
    });
};

export async function adoptBackgroundImageJob(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any>,
    remote: {
        clientRequestId: string;
        remoteJobId?: string;
    },
    context: {
        charId: string;
        ownerType?: 'chat' | 'story-theater';
        storyTheaterTarget?: {
            entryId: string;
            messageId: number;
            title: string;
        };
    },
): Promise<McpToolResult> {
    const clientRequestId = String(remote.clientRequestId || '').trim();
    if (!clientRequestId) return { success: false, error: '云端生图任务缺少 clientRequestId' };
    const { afterGenerateAction, cleanedArgs } = parseImageToolClientOptions(args);
    if (!isBackgroundImageToolCall(server, toolName)) {
        return { success: false, error: '云端生图任务对应的本地工具已不可用' };
    }
    const engineId = engineIdFromServer(server);
    if (!engineId || !server.controlBaseUrl) {
        return { success: false, error: '云端生图任务对应的本地服务配置不完整' };
    }

    const state = readState();
    const existing = state.jobs.find(job => job.clientRequestId === clientRequestId);
    if (existing) {
        const updated = updateJob(existing.id, {
            remoteJobId: remote.remoteJobId || existing.remoteJobId,
            ownerType: context.ownerType === 'story-theater' ? 'story-theater' : existing.ownerType,
            storyTheaterTarget: context.ownerType === 'story-theater'
                ? context.storyTheaterTarget
                : existing.storyTheaterTarget,
            workerOwnsSubmission: true,
            lastError: undefined,
        }) || existing;
        dispatchJobEvent('updated', updated);
        return queuedToolResult(updated, remote.remoteJobId ? ({
            id: remote.remoteJobId,
            clientRequestId,
            toolName,
            status: 'queued',
            createdAt: updated.createdAt,
            updatedAt: now(),
        } as RemoteImageJob) : undefined);
    }

    const createdAt = now();
    const localJob: LocalBackgroundImageJob = {
        id: makeLocalId(),
        clientRequestId,
        remoteJobId: remote.remoteJobId,
        engineId,
        serverId: server.id,
        serverName: server.name,
        controlBaseUrl: normalizeBaseUrl(server.controlBaseUrl),
        token: String(server.token || ''),
        charId: context.charId,
        ownerType: context.ownerType === 'story-theater' ? 'story-theater' : 'chat',
        storyTheaterTarget: context.ownerType === 'story-theater' ? context.storyTheaterTarget : undefined,
        toolName,
        toolArgs: clone(cleanedArgs),
        afterGenerateAction,
        inspectStatus: afterGenerateAction === 'inspect' ? 'pending' : undefined,
        status: remote.remoteJobId ? 'queued' : 'submitting',
        createdAt,
        updatedAt: createdAt,
        // Worker 独占自动配图的第一次 POST；客户端只按同一 clientRequestId / remoteJobId 查状态。
        // 自动流程永不补交，失败后由用户手动“重新生成”。
        submitAttempts: remote.remoteJobId ? 1 : 0,
        workerOwnsSubmission: true,
        imageBillingCapture: captureImageGenerationBilling(engineId),
    };
    upsertJob(localJob);
    dispatchJobEvent('updated', localJob);
    return queuedToolResult(localJob, remote.remoteJobId ? ({
        id: remote.remoteJobId,
        clientRequestId,
        toolName,
        status: 'queued',
        createdAt,
        updatedAt: createdAt,
    } as RemoteImageJob) : undefined);
}

export async function callMcpToolWithBackgroundImage(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any>,
    context: {
        charId: string;
        ownerType?: 'chat' | 'story-theater';
        storyTheaterTarget?: {
            entryId: string;
            messageId: number;
            title: string;
        };
    },
): Promise<McpToolResult> {
    const { afterGenerateAction, cleanedArgs } = parseImageToolClientOptions(args);
    if (
        !isBackgroundImageToolCall(
            server,
            toolName,
        )
    ) {
        return callMcpTool(
            server,
            toolName,
            cleanedArgs,
        );
    }

    const engineId =
        engineIdFromServer(server);

    if (
        !engineId
        || !server.controlBaseUrl
    ) {
        return callMcpTool(
            server,
            toolName,
            cleanedArgs,
        );
    }

    const createdAt = now();

    const localJob:
        LocalBackgroundImageJob = {
        id: makeLocalId(),
        clientRequestId:
            makeClientRequestId(),
        engineId,
        serverId: server.id,
        serverName: server.name,
        controlBaseUrl:
            normalizeBaseUrl(
                server.controlBaseUrl,
            ),
        // 冻结提交当时的 Token；切换预设不影响旧任务查询。
        token:
            String(server.token || ''),
        charId: context.charId,
        ownerType:
            context.ownerType === 'story-theater'
                ? 'story-theater'
                : 'chat',
        storyTheaterTarget:
            context.ownerType === 'story-theater'
                ? context.storyTheaterTarget
                : undefined,
        toolName,
        toolArgs: clone(cleanedArgs),
        afterGenerateAction,
        inspectStatus: afterGenerateAction === 'inspect' ? 'pending' : undefined,
        status: 'submitting',
        createdAt,
        updatedAt: createdAt,
        submitAttempts: 1,
        imageBillingCapture: captureImageGenerationBilling(engineId),
    };

    upsertJob(localJob);
    dispatchJobEvent('updated', localJob);

    try {
        const remoteJob =
            await submitRemoteJob(
                localJob,
            );

        const updated = updateJob(
            localJob.id,
            {
                remoteJobId:
                    remoteJob.id,
                status:
                    remoteStatusToLocal(
                        remoteJob.status,
                    ),
                lastCheckedAt: now(),
                lastError: undefined,
            },
        ) || localJob;

        return queuedToolResult(
            updated,
            remoteJob,
        );
    } catch (error) {
        if (isUnsupportedJobsEndpointError(error)) {
            // 旧服务或旧 Nginx 没有 /jobs。只有明确的 404/405/501 才安全直连回退；
            // timeout、断网和 5xx 可能已经接单，必须保留 clientRequestId 查询，不能重发扣费。
            removeJob(localJob.id);
            dispatchJobEvent('updated', localJob);
            try {
                return await callMcpTool(
                    server,
                    toolName,
                    cleanedArgs,
                );
            } catch (directError) {
                return {
                    success: false,
                    error: sanitizeMcpOutcomeText(directError)
                        || '直连 MCP 生图失败',
                };
            }
        }

        if (isPermanentSubmitError(error)) {
            const failed = updateJob(localJob.id, {
                status: 'failed',
                lastError: sanitizeMcpOutcomeText(error),
            }) || localJob;

            dispatchJobEvent('failed', failed);
            return {
                success: false,
                error: failed.lastError || '后台生图提交失败',
            };
        }

        // 响应丢失时保留相同 clientRequestId，恢复后先查询再重交。
        updateJob(localJob.id, {
            status: 'submitting',
            lastError: sanitizeMcpOutcomeText(error),
        });

        return queuedToolResult(localJob);
    }
}

export function startBackgroundImageJobMonitor(
    options: MonitorOptions = {},
): () => void {
    let disposed = false;
    let timer:
        ReturnType<typeof setTimeout>
        | null = null;

    const schedule = () => {
        if (disposed) return;
        if (timer) clearTimeout(timer);

        if (
            typeof document !== 'undefined'
            && document.visibilityState
                !== 'visible'
        ) return;

        timer = setTimeout(
            () => void tick(),
            FOREGROUND_POLL_MS,
        );
    };

    const tick = async () => {
        if (disposed) return;
        await reconcileBackgroundImageJobs(
            options,
        );
        schedule();
    };

    const activate = () => {
        if (!disposed) void tick();
    };

    const onVisibilityChange = () => {
        if (
            document.visibilityState
            === 'visible'
        ) {
            activate();
        } else if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const onFocus = () => activate();

    document.addEventListener(
        'visibilitychange',
        onVisibilityChange,
    );
    window.addEventListener(
        'focus',
        onFocus,
    );

    const appListenerPromise =
        Promise.resolve(
            App.addListener(
                'appStateChange',
                state => {
                    if (state.isActive) {
                        activate();
                    }
                },
            ),
        );

    activate();

    return () => {
        disposed = true;
        if (timer) clearTimeout(timer);
        document.removeEventListener(
            'visibilitychange',
            onVisibilityChange,
        );
        window.removeEventListener(
            'focus',
            onFocus,
        );
        void appListenerPromise
            .then(handle => handle.remove())
            .catch(() => {});
    };
}

export function exportBackgroundImageJobsForBackup(): BackgroundImageJobsBackup {
    return {
        version: 1,
        exportedAt: now(),
        // 只保存能继续 reconcile 的任务。已成功落图、失败或取消的历史已经在聊天/相册里。
        jobs: clone(getUnfinishedJobs()),
    };
}

export function importBackgroundImageJobsFromBackup(data: unknown): number {
    if (!data || typeof data !== 'object' || (data as any).version !== 1 || !Array.isArray((data as any).jobs)) {
        return 0;
    }

    const resumable = new Set<LocalBackgroundImageJobStatus>([
        'submitting', 'queued', 'running', 'succeeded',
    ]);
    const byIdentity = new Map<string, LocalBackgroundImageJob>();
    for (const raw of (data as any).jobs) {
        const job = sanitizeLoadedJob(raw);
        if (!job || job.resultAppliedAt || !resumable.has(job.status)) continue;
        const identity = job.clientRequestId || job.id;
        const previous = byIdentity.get(identity);
        if (!previous || previous.updatedAt <= job.updatedAt) byIdentity.set(identity, job);
    }

    const jobs = [...byIdentity.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_LOCAL_JOBS);
    writeState({ version: 1, jobs });
    return jobs.length;
}

export function getBackgroundImageJobs():
LocalBackgroundImageJob[] {
    return clone(readState().jobs);
}

export function clearBackgroundImageJobs(): void {
    localStorage.removeItem(STORAGE_KEY);
}
