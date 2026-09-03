import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';

import type { ApiExecutionPlan } from './apiFailover';
import { recordApiCall } from './apiCallLog';

interface NativeStoryRoute {
  presetId: string;
  presetName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  temperature?: number;
  firstByteTimeoutMs?: number;
}

interface NativeStoryAttempt {
  routeIndex?: number;
  presetId?: string;
  presetName?: string;
  baseUrl?: string;
  model?: string;
  ok?: boolean;
  status?: number;
  error?: string;
  durationMs?: number;
}

interface NativeStoryJob {
  jobId: string;
  ownerKey?: string;
  title?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  responseJson?: string;
  partialContent?: string;
  error?: string;
  statusCode?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  routeIndex?: number;
  routePresetId?: string;
  routePresetName?: string;
  routeBaseUrl?: string;
  routeModel?: string;
  attempts?: NativeStoryAttempt[];
  createdAt?: number;
  updatedAt?: number;
}

interface SullyStoryBackgroundPlugin {
  submit(options: { spec: Record<string, any> }): Promise<{ job: NativeStoryJob }>;
  status(options: { jobId: string }): Promise<{ job: NativeStoryJob | null }>;
  remove(options: { jobId: string }): Promise<void>;
  acquireKeepAlive(options: { leaseId: string; title?: string }): Promise<void>;
  releaseKeepAlive(options: { leaseId: string }): Promise<void>;
}

const NativeStoryBackground = registerPlugin<SullyStoryBackgroundPlugin>('SullyStoryBackground');
const STORAGE_KEY = 'sully_story_background_pending_v1';

export interface PendingNativeStoryJob {
  jobId: string;
  ownerKey: string;
  title: string;
  createdAt: number;
  meta?: Record<string, any>;
  loggedJobId?: string;
}

interface PendingMap {
  [ownerKey: string]: PendingNativeStoryJob;
}

export interface NativeStoryCompletionOptions {
  ownerKey: string;
  title: string;
  plan: ApiExecutionPlan;
  body: Record<string, any>;
  meta?: Record<string, any>;
  onPromptTokens?: (tokens: number) => void;
  onStreamText?: (fullText: string) => void;
}

const readPending = (): PendingMap => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writePending = (value: PendingMap): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // best effort only
  }
};

const setPending = (item: PendingNativeStoryJob): void => {
  const map = readPending();
  map[item.ownerKey] = item;
  writePending(map);
};

export const clearPendingNativeStoryJob = async (ownerKey: string): Promise<void> => {
  const map = readPending();
  const pending = map[ownerKey];
  if (!pending) return;
  delete map[ownerKey];
  writePending(map);
  if (isNativeStoryBackgroundRuntime()) {
    await NativeStoryBackground.remove({ jobId: pending.jobId }).catch(() => undefined);
  }
};

export const getPendingNativeStoryJob = (ownerKey: string): PendingNativeStoryJob | null =>
  readPending()[ownerKey] || null;

export const isNativeStoryBackgroundRuntime = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const makeKeepAliveLeaseId = (ownerKey: string): string => {
  const safeOwner = String(ownerKey || 'story').replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 80);
  return `storykeep:${safeOwner}:${Date.now().toString(36)}`;
};

/**
 * Android 后台只负责“保住进程 + WakeLock”，绝不再自己直连模型 API。
 * 真正的 completion 仍走前台已经验证稳定的 safeFetchJson/fetch SSE 链路。
 */
export const acquireNativeStoryKeepAlive = async (
  ownerKey: string,
  title?: string,
): Promise<string | null> => {
  if (!isNativeStoryBackgroundRuntime()) return null;
  const leaseId = makeKeepAliveLeaseId(ownerKey);
  await NativeStoryBackground.acquireKeepAlive({
    leaseId,
    title: String(title || '剧情'),
  });
  return leaseId;
};

export const releaseNativeStoryKeepAlive = async (
  leaseId: string | null | undefined,
): Promise<void> => {
  if (!leaseId || !isNativeStoryBackgroundRuntime()) return;
  await NativeStoryBackground.releaseKeepAlive({ leaseId }).catch(() => undefined);
};

const makeJobId = (): string => {
  const random = (() => {
    try {
      if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    } catch {}
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  })();
  return `storybg_${Date.now().toString(36)}_${random}`;
};

const toNativeRoutes = (
  plan: ApiExecutionPlan,
  streamOverride?: boolean,
): NativeStoryRoute[] =>
  plan.routes.map(route => ({
    presetId: route.presetId,
    presetName: route.presetName,
    baseUrl: route.api.baseUrl,
    apiKey: route.api.apiKey || 'sk-none',
    model: route.api.model,
    // 与 WebView 路径保持同一语义：调用方明确给 stream:true/false 时优先；
    // 正文不显式指定时才跟随每条 API 预设。这样总结能真正强制非流式，
    // Gemini/特殊中转也不会被后台服务擅自改成另一种协议。
    stream: streamOverride ?? route.api.stream === true,
    ...(route.api.temperature != null ? { temperature: route.api.temperature } : {}),
    ...(route.firstByteTimeoutMs ? { firstByteTimeoutMs: route.firstByteTimeoutMs } : {}),
  }));

const checkJob = async (jobId: string): Promise<NativeStoryJob | null> => {
  const result = await NativeStoryBackground.status({ jobId });
  return result?.job || null;
};

const waitForTerminal = async (
  jobId: string,
  onStreamText?: (fullText: string) => void,
): Promise<NativeStoryJob> => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resumeHandle: { remove: () => Promise<void> } | null = null;
  let lastPartial = '';

  return new Promise<NativeStoryJob>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void resumeHandle?.remove();
      fn();
    };

    const poll = async () => {
      if (stopped) return;
      try {
        const job = await checkJob(jobId);
        if (!job) {
          finish(() => reject(new Error('剧情后台任务记录不存在')));
          return;
        }
        const partial = String(job.partialContent || '');
        if (partial && partial !== lastPartial) {
          lastPartial = partial;
          onStreamText?.(partial);
        }
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          finish(() => resolve(job));
          return;
        }
      } catch (error) {
        // App 切后台时 Capacitor bridge 可能短暂不可用；保留任务并等恢复。
      }
      if (!stopped) timer = setTimeout(poll, 800);
    };

    void App.addListener('resume', () => void poll()).then(handle => {
      resumeHandle = handle;
    }).catch(() => undefined);

    void poll();
  });
};

const logNativeAttempts = (
  job: NativeStoryJob,
  plan: ApiExecutionPlan,
  baseBody: Record<string, any>,
  response: any | undefined,
): void => {
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  for (const attempt of attempts) {
    const routeIndex = Number(attempt.routeIndex);
    const route = Number.isFinite(routeIndex) ? plan.routes[routeIndex] : undefined;
    const baseUrl = String(attempt.baseUrl || route?.api.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) continue;
    const model = String(attempt.model || route?.api.model || baseBody.model || '');
    const ok = attempt.ok === true;
    recordApiCall({
      url: `${baseUrl}/chat/completions`,
      body: { ...baseBody, model, stream: false },
      status: Number.isFinite(Number(attempt.status)) ? Number(attempt.status) : undefined,
      ok,
      response: ok ? response : undefined,
      durationMs: Number.isFinite(Number(attempt.durationMs)) ? Number(attempt.durationMs) : undefined,
      networkRequest: true,
      meta: {
        appId: 'date',
        appName: '剧情剧场',
        purpose: '剧情后台续写',
        apiPresetId: String(attempt.presetId || route?.presetId || ''),
        apiPresetName: String(attempt.presetName || route?.presetName || ''),
        failoverGroupId: plan.group?.id,
        failoverGroupName: plan.group?.name,
        failoverRouteIndex: Number.isFinite(routeIndex) ? routeIndex : undefined,
        failoverRouteCount: plan.routes.length,
        failoverPresetId: String(attempt.presetId || route?.presetId || ''),
      },
      presetId: String(attempt.presetId || route?.presetId || '') || undefined,
      presetName: String(attempt.presetName || route?.presetName || '') || undefined,
      modelOverride: model,
      baseUrlOverride: baseUrl,
    });
  }
};

export const executeStoryCompletionInNativeBackground = async (
  options: NativeStoryCompletionOptions,
): Promise<any> => {
  if (!isNativeStoryBackgroundRuntime()) {
    throw new Error('当前不是 Android 原生剧情后台运行环境');
  }

  const existing = getPendingNativeStoryJob(options.ownerKey);
  let jobId = existing?.jobId || '';
  let job: NativeStoryJob | null = jobId ? await checkJob(jobId).catch(() => null) : null;

  if (!job || (job.status !== 'queued' && job.status !== 'running' && job.status !== 'succeeded' && job.status !== 'failed')) {
    jobId = makeJobId();
    const streamOverride = Object.prototype.hasOwnProperty.call(options.body, 'stream')
      ? Boolean(options.body.stream)
      : undefined;
    const routes = toNativeRoutes(options.plan, streamOverride);
    const timeoutMs = options.plan.group?.policy.timeoutMs ?? 240_000;
    // 先记本地 pending，再把任务交给原生层：即使用户恰好在 submit 返回前
    // 切屏/系统冻结 WebView，回来也知道这一轮有后台任务需要接回。
    setPending({
      jobId,
      ownerKey: options.ownerKey,
      title: options.title || '剧情',
      createdAt: Date.now(),
      meta: options.meta,
    });
    try {
      const submitted = await NativeStoryBackground.submit({
        spec: {
          jobId,
          ownerKey: options.ownerKey,
          title: options.title || '剧情',
          mode: options.plan.mode,
          timeoutMs,
          routes,
          baseBody: {
            ...options.body,
            // 后台服务自己根据每条 API 的 stream 偏好决定是否走 SSE；
            // 页面不再承担长连接，因此切屏/锁屏不会让请求跟着 WebView 冻结。
            stream: false,
          },
        },
      });
      job = submitted.job;
    } catch (error) {
      await clearPendingNativeStoryJob(options.ownerKey);
      throw error;
    }
  }

  if (job.status === 'queued' || job.status === 'running') {
    job = await waitForTerminal(jobId, options.onStreamText);
  }

  let parsed: any | undefined;
  if (job.responseJson) {
    try { parsed = JSON.parse(job.responseJson); } catch {}
  }

  const pendingBeforeLog = getPendingNativeStoryJob(options.ownerKey);
  if (pendingBeforeLog?.loggedJobId !== job.jobId) {
    logNativeAttempts(job, options.plan, options.body, parsed);
    if (pendingBeforeLog) {
      setPending({ ...pendingBeforeLog, loggedJobId: job.jobId });
    }
  }

  const promptTokens = Number(job.promptTokens ?? parsed?.usage?.prompt_tokens);
  if (Number.isFinite(promptTokens) && promptTokens > 0) options.onPromptTokens?.(promptTokens);

  // 不在这里清 pending：native 已经拿到回复 ≠ 剧情楼层已经成功落库。
  // 由 StoryTheaterSession 在 assistant 楼层保存成功后再清理，避免 App 恰好
  // 在“收到结果→写 IndexedDB”之间被系统杀掉时丢失这一轮。
  if (job.status === 'succeeded' && parsed) return parsed;

  const error = new Error(job.error || '剧情后台续写失败');
  (error as any).status = job.statusCode;
  if (job.partialContent) (error as any).partialContent = job.partialContent;
  throw error;
};
