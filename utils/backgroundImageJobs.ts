import { App } from '@capacitor/app';

import type {
    CharacterProfile,
    Message,
} from '../types';
import { DB } from './db';
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
    resultAppliedAt?: number;
    lastError?: string;
}

interface LocalState {
    version: 1;
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
        resultAppliedAt:
            Number.isFinite(raw.resultAppliedAt)
                ? raw.resultAppliedAt
                : undefined,
        lastError:
            typeof raw.lastError === 'string'
                ? raw.lastError
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
        if (
            error instanceof JobHttpError
            && error.status === 404
        ) return null;
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
        if (
            error instanceof JobHttpError
            && error.status === 404
        ) return null;
        throw error;
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
    type: 'completed' | 'failed' | 'updated',
    job: LocalBackgroundImageJob,
): void => {
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
                },
            },
        ),
    );
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
const applySucceededJob = async (
    localJob: LocalBackgroundImageJob,
    remoteJob: RemoteImageJob,
): Promise<void> => {
    const characters =
        await DB.getAllCharacters();

    const character = characters.find(
        item => item.id === localJob.charId,
    );

    if (!character) {
        throw new Error(
            '后台图片对应的角色已不存在',
        );
    }

    const recentMessages =
        await DB.getRecentMessagesByCharId(
            localJob.charId,
            500,
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
                remoteJobId:
                    remoteJob.id,
                status: 'succeeded',
                resultAppliedAt: now(),
                lastError: undefined,
            },
        );

        if (updated) {
            dispatchJobEvent(
                'completed',
                updated,
            );
        }
        return;
    }

    const result = remoteJob.result || {};

    const mcpResult: McpToolResult = {
        success: true,
        data:
            result.structuredContent
            ?? result,
        structuredContent:
            result.structuredContent,
        content:
            Array.isArray(result.content)
                ? result.content
                : [],
        rawResult: result,
    };

    const outcome =
        await persistMcpGeneratedImages({
            result: mcpResult,
            char:
                character as CharacterProfile,
            server: {
                id: localJob.serverId,
                name: localJob.serverName,
            },
            toolName:
                localJob.toolName,
            toolArgs:
                localJob.toolArgs,
            recentMessages,
            extraMessageMetadata: {
                backgroundImageJobId:
                    remoteJob.id,
                backgroundImageClientRequestId:
                    localJob.clientRequestId,
                backgroundGenerated:
                    true,
            },
            extraGallerySourceMeta: {
                backgroundImageJobId:
                    remoteJob.id,
                backgroundImageClientRequestId:
                    localJob.clientRequestId,
            },
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
            remoteJobId:
                remoteJob.id,
            status: 'succeeded',
            resultAppliedAt: now(),
            lastError: undefined,
        },
    );

    if (updated) {
        dispatchJobEvent(
            'completed',
            updated,
        );
    }
};

const reconcileOne = async (
    localJob: LocalBackgroundImageJob,
    options: MonitorOptions,
): Promise<void> => {
    let remoteJob:
        RemoteImageJob | null = null;

    try {
        if (localJob.remoteJobId) {
            remoteJob =
                await getRemoteJobById(
                    localJob,
                );
        }

        if (!remoteJob) {
            remoteJob =
                await findRemoteJobByClientId(
                    localJob,
                );
        }

        if (!remoteJob) {
            if (
                localJob.submitAttempts
                >= MAX_SUBMIT_ATTEMPTS
            ) {
                const failed = updateJob(
                    localJob.id,
                    {
                        status: 'failed',
                        lastError:
                            '后台生图任务多次提交失败',
                    },
                );

                if (failed) {
                    dispatchJobEvent(
                        'failed',
                        failed,
                    );
                    options.onFailed?.(
                        failed,
                    );
                }
                return;
            }

            const attempted = updateJob(
                localJob.id,
                {
                    status: 'submitting',
                    submitAttempts:
                        localJob.submitAttempts + 1,
                    lastCheckedAt: now(),
                },
            );

            if (!attempted) return;

            try {
                remoteJob =
                    await submitRemoteJob(
                        attempted,
                    );
            } catch (error) {
                if (
                    isPermanentSubmitError(
                        error,
                    )
                ) {
                    const failed = updateJob(
                        localJob.id,
                        {
                            status: 'failed',
                            lastError:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    );

                    if (failed) {
                        dispatchJobEvent(
                            'failed',
                            failed,
                        );
                        options.onFailed?.(
                            failed,
                        );
                    }
                }
                throw error;
            }
        }

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
                lastError:
                    remoteJob.error?.message,
            },
        );

        if (!updated) return;

        dispatchJobEvent(
            'updated',
            updated,
        );

        if (
            remoteJob.status
            === 'succeeded'
        ) {
            await applySucceededJob(
                updated,
                remoteJob,
            );

            const completed =
                readState().jobs.find(
                    item =>
                        item.id === updated.id,
                );

            if (completed) {
                options.onCompleted?.(
                    completed,
                );
            }
            return;
        }

        if (
            remoteJob.status === 'failed'
            || remoteJob.status
                === 'cancelled'
        ) {
            dispatchJobEvent(
                'failed',
                updated,
            );
            options.onFailed?.(
                updated,
            );
        }
    } catch (error) {
        const current = readState().jobs.find(
            item => item.id === localJob.id,
        );

        // 已经明确判为失败时不再覆盖状态。
        if (
            current?.status !== 'failed'
            && current?.status !== 'cancelled'
        ) {
            updateJob(
                localJob.id,
                {
                    lastCheckedAt: now(),
                    lastError:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            );
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

export async function callMcpToolWithBackgroundImage(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any>,
    context: {
        charId: string;
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
        toolName,
        toolArgs: clone(cleanedArgs),
        afterGenerateAction,
        inspectStatus: afterGenerateAction === 'inspect' ? 'pending' : undefined,
        status: 'submitting',
        createdAt,
        updatedAt: createdAt,
        submitAttempts: 1,
    };

    upsertJob(localJob);

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
        if (
            isPermanentSubmitError(error)
        ) {
            const failed = updateJob(
                localJob.id,
                {
                    status: 'failed',
                    lastError:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            ) || localJob;

            dispatchJobEvent(
                'failed',
                failed,
            );

            return {
                success: false,
                error:
                    failed.lastError
                    || '后台生图提交失败',
            };
        }

        // 响应丢失时保留相同 clientRequestId，恢复后先查询再重交。
        updateJob(
            localJob.id,
            {
                status: 'submitting',
                lastError:
                    error instanceof Error
                        ? error.message
                        : String(error),
            },
        );

        return queuedToolResult(
            localJob,
        );
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

export function getBackgroundImageJobs():
LocalBackgroundImageJob[] {
    return clone(readState().jobs);
}

export function clearBackgroundImageJobs(): void {
    localStorage.removeItem(STORAGE_KEY);
}
