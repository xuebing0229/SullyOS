import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

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
  startedAt?: number;
  openedAt?: number;
  firstEventAt?: number;
  firstVisibleAt?: number;
  lastChunkAt?: number;
  lastReasoningAt?: number;
  lastVisibleAt?: number;
  lastActivityAt?: number;
  chunkCount?: number;
  dnsStartAt?: number;
  dnsEndAt?: number;
  connectStartAt?: number;
  connectEndAt?: number;
  connectFailedAt?: number;
  secureConnectStartAt?: number;
  secureConnectEndAt?: number;
  connectionAcquiredAt?: number;
  requestHeadersStartAt?: number;
  requestHeadersEndAt?: number;
  requestBodyStartAt?: number;
  requestBodyEndAt?: number;
  responseHeadersStartAt?: number;
  responseHeadersEndAt?: number;
  callEndAt?: number;
  callFailedAt?: number;
  responseCode?: number;
  networkProtocol?: string;
  remoteAddress?: string;
  dnsHost?: string;
  dnsAddresses?: string[];
  connectProxy?: string;
  tlsVersion?: string;
  cipherSuite?: string;
  requestBodyBytes?: number;
  callStartAt?: number;
  callFailureClass?: string;
  callFailureMessage?: string;
  callFailureCauseClass?: string;
  callFailureCauseMessage?: string;
  foregroundRequestedAt?: number;
  foregroundStartedAt?: number;
  foregroundFailedAt?: number;
  foregroundDestroyedAt?: number;
  foregroundReleasedAt?: number;
  foregroundFailureClass?: string;
  foregroundFailureMessage?: string;
  wakeLockAcquiredAt?: number;
  wakeLockReleasedAt?: number;
  wakeLockFailedAt?: number;
  appPausedAt?: number;
  appStoppedAt?: number;
  appStartedAt?: number;
  appResumedAt?: number;
  networkSnapshotAt?: number;
  networkAvailableAt?: number;
  networkLostAt?: number;
  networkLosingAt?: number;
  networkCapabilitiesChangedAt?: number;
  linkPropertiesChangedAt?: number;
  androidNetwork?: string;
  networkTransports?: string[];
  networkValidated?: boolean;
  networkInternet?: boolean;
  networkNotSuspended?: boolean;
  networkMetered?: boolean;
  networkInterface?: string;
  networkBlocked?: boolean;
  networkBlockedAt?: number;
  restrictBackgroundStatus?: number;
  backgroundRestricted?: boolean;
  powerSaveMode?: boolean;
  deviceIdleMode?: boolean;
  ignoringBatteryOptimizations?: boolean;
  connectivityObserverRegistered?: boolean;
  connectivityObserverFailureClass?: string;
  connectivityObserverFailureMessage?: string;
  networkEvents?: Array<Record<string, any>>;
  sseEvents?: number;
  reasoningChars?: number;
  visibleChars?: number;
  streamFinishReason?: string;
  updatedAt?: number;
}

interface SullyStoryBackgroundPlugin {
  submit(options: { spec: Record<string, any> }): Promise<{ job: NativeStoryJob }>;
  status(options: { jobId: string }): Promise<{ job: NativeStoryJob | null }>;
  remove(options: { jobId: string }): Promise<void>;
  acquireKeepAlive(options: { leaseId: string; title?: string }): Promise<void>;
  releaseKeepAlive(options: { leaseId: string }): Promise<void>;
  startCloudMonitor(options: {
    jobId: string;
    title: string;
    workerUrl: string;
    userId: string;
    serverToken?: string;
  }): Promise<void>;
  finishCloudMonitor(options: {
    jobId: string;
    title: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    error?: string;
  }): Promise<void>;
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
  if (!map[ownerKey]) return;
  // 这里只清 JS 的“待接回”指针，绝不能物理删除 native job。
  // 页面切出再回来时，旧/新 StoryTheaterSession 可能短时间同时观察同一个 generation；
  // 任一观察者完成后若 remove(jobId)，另一个观察者下一次 status() 就会误报“任务记录不存在”。
  // native terminal job 由 SullyStoryGenerationManager 的 retention cleanup 统一回收。
  delete map[ownerKey];
  writePending(map);
};

export const getPendingNativeStoryJob = (ownerKey: string): PendingNativeStoryJob | null =>
  readPending()[ownerKey] || null;

export const isNativeStoryBackgroundRuntime = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export interface NativeCloudStoryMonitorOptions {
  jobId: string;
  title: string;
  workerUrl: string;
  userId: string;
  serverToken?: string;
}

const ensureStoryNotificationPermission = async (): Promise<{
  granted: boolean;
  prompted: boolean;
}> => {
  if (!isNativeStoryBackgroundRuntime()) return { granted: false, prompted: false };
  const current = await LocalNotifications.checkPermissions();
  if (current.display !== 'prompt') {
    return { granted: current.display === 'granted', prompted: false };
  }
  const resolved = await LocalNotifications.requestPermissions();
  return { granted: resolved.display === 'granted', prompted: true };
};

/**
 * 云端 Story Jobs 的系统状态牌。与主动消息 push 完全独立：Android 自己轮询同一个 job。
 *
 * 关键顺序：先把 startCloudMonitor 交给原生层，再做通知权限 bridge 往返。
 * 这样用户点完“生成”立刻切屏时，WebView 即使马上冻结，原生前台服务也已经收到启动请求。
 */
export const startNativeCloudStoryMonitor = async (
  options: NativeCloudStoryMonitorOptions,
): Promise<boolean> => {
  if (!isNativeStoryBackgroundRuntime()) return false;

  let immediateStartError: unknown = null;
  try {
    // Android 13+ 即使通知权限尚未授予，也允许启动 foreground service；
    // 权限只决定通知能否正常展示。因此先启动，不能让权限查询成为后台接管前置门槛。
    await NativeStoryBackground.startCloudMonitor(options);
  } catch (error) {
    immediateStartError = error;
  }

  const permission = await ensureStoryNotificationPermission();
  if (!permission.granted) {
    console.warn('[StoryTheater] 系统通知权限未授予，剧情后台状态牌无法显示');
    if (immediateStartError) throw immediateStartError;
    return false;
  }

  // 如果刚刚弹过权限框，或第一次原生启动失败，重新发一次 start：
  // 已运行的 service 会更新同一 job/notification，不会创建第二条模型请求。
  if (permission.prompted || immediateStartError) {
    await NativeStoryBackground.startCloudMonitor(options);
  }
  return true;
};

export const finishNativeCloudStoryMonitor = async (options: {
  jobId: string;
  title: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  error?: string;
}): Promise<void> => {
  if (!isNativeStoryBackgroundRuntime()) return;
  await NativeStoryBackground.finishCloudMonitor(options);
};

const makeKeepAliveLeaseId = (ownerKey: string): string => {
  const safeOwner = String(ownerKey || 'story').replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 80);
  return `storykeep:${safeOwner}:${Date.now().toString(36)}`;
};

/**
 * 这个 keepalive lease 只给剧情完成后的 JS 阶段（例如自动配图）使用。
 * 真正的剧情 completion 在 Android App 进程里由 SullyStoryGenerationManager 持有；
 * ForegroundService 只负责进程前台生命周期。
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
): NativeStoryRoute[] =>
  plan.routes.map(route => ({
    presetId: route.presetId,
    presetName: route.presetName,
    baseUrl: route.api.baseUrl,
    apiKey: route.api.apiKey || 'sk-none',
    model: route.api.model,
    // Android 剧情后台采用 ForegroundService + okhttp-sse EventSource。
    // 长正文和事件盒都统一 stream=true，避免代理在长思考期间因零字节响应触发 524。
    stream: true,
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
      body: { ...baseBody, model, stream: true },
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
    const routes = toNativeRoutes(options.plan);
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
            // ForegroundService 从一开始就持有官方 okhttp-sse EventSource，
            // 页面切屏/锁屏不会再迁移或重建这次 completion。
            stream: true,
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
  const startedAt = Number(job.startedAt || job.createdAt || 0);
  const elapsedFromStart = (at?: number): number | undefined => {
    const value = Number(at || 0);
    return startedAt > 0 && value >= startedAt ? value - startedAt : undefined;
  };
  (error as any).nativeStoryDiagnostics = {
    jobId: job.jobId,
    status: job.status,
    statusCode: job.statusCode,
    startedAt: job.startedAt,
    openedAt: job.openedAt,
    firstEventAt: job.firstEventAt,
    firstVisibleAt: job.firstVisibleAt,
    lastChunkAt: job.lastChunkAt,
    lastReasoningAt: job.lastReasoningAt,
    lastVisibleAt: job.lastVisibleAt,
    lastActivityAt: job.lastActivityAt,
    dnsStartAt: job.dnsStartAt,
    dnsEndAt: job.dnsEndAt,
    connectStartAt: job.connectStartAt,
    connectEndAt: job.connectEndAt,
    connectFailedAt: job.connectFailedAt,
    secureConnectStartAt: job.secureConnectStartAt,
    secureConnectEndAt: job.secureConnectEndAt,
    connectionAcquiredAt: job.connectionAcquiredAt,
    requestHeadersStartAt: job.requestHeadersStartAt,
    requestHeadersEndAt: job.requestHeadersEndAt,
    requestBodyStartAt: job.requestBodyStartAt,
    requestBodyEndAt: job.requestBodyEndAt,
    responseHeadersStartAt: job.responseHeadersStartAt,
    responseHeadersEndAt: job.responseHeadersEndAt,
    callEndAt: job.callEndAt,
    callFailedAt: job.callFailedAt,
    responseCode: job.responseCode,
    networkProtocol: job.networkProtocol,
    remoteAddress: job.remoteAddress,
    dnsHost: job.dnsHost,
    dnsAddresses: job.dnsAddresses,
    connectProxy: job.connectProxy,
    tlsVersion: job.tlsVersion,
    cipherSuite: job.cipherSuite,
    requestBodyBytes: job.requestBodyBytes,
    callStartAt: job.callStartAt,
    callFailureClass: job.callFailureClass,
    callFailureMessage: job.callFailureMessage,
    callFailureCauseClass: job.callFailureCauseClass,
    callFailureCauseMessage: job.callFailureCauseMessage,
    foregroundRequestedAt: job.foregroundRequestedAt,
    foregroundStartedAt: job.foregroundStartedAt,
    foregroundFailedAt: job.foregroundFailedAt,
    foregroundDestroyedAt: job.foregroundDestroyedAt,
    foregroundReleasedAt: job.foregroundReleasedAt,
    foregroundFailureClass: job.foregroundFailureClass,
    foregroundFailureMessage: job.foregroundFailureMessage,
    wakeLockAcquiredAt: job.wakeLockAcquiredAt,
    wakeLockReleasedAt: job.wakeLockReleasedAt,
    wakeLockFailedAt: job.wakeLockFailedAt,
    appPausedAt: job.appPausedAt,
    appStoppedAt: job.appStoppedAt,
    appStartedAt: job.appStartedAt,
    appResumedAt: job.appResumedAt,
    networkSnapshotAt: job.networkSnapshotAt,
    networkAvailableAt: job.networkAvailableAt,
    networkLostAt: job.networkLostAt,
    networkLosingAt: job.networkLosingAt,
    networkCapabilitiesChangedAt: job.networkCapabilitiesChangedAt,
    linkPropertiesChangedAt: job.linkPropertiesChangedAt,
    androidNetwork: job.androidNetwork,
    networkTransports: job.networkTransports,
    networkValidated: job.networkValidated,
    networkInternet: job.networkInternet,
    networkNotSuspended: job.networkNotSuspended,
    networkMetered: job.networkMetered,
    networkInterface: job.networkInterface,
    networkBlocked: job.networkBlocked,
    networkBlockedAt: job.networkBlockedAt,
    restrictBackgroundStatus: job.restrictBackgroundStatus,
    backgroundRestricted: job.backgroundRestricted,
    powerSaveMode: job.powerSaveMode,
    deviceIdleMode: job.deviceIdleMode,
    ignoringBatteryOptimizations: job.ignoringBatteryOptimizations,
    connectivityObserverRegistered: job.connectivityObserverRegistered,
    connectivityObserverFailureClass: job.connectivityObserverFailureClass,
    connectivityObserverFailureMessage: job.connectivityObserverFailureMessage,
    foregroundRequestedMs: elapsedFromStart(job.foregroundRequestedAt),
    foregroundStartedMs: elapsedFromStart(job.foregroundStartedAt),
    foregroundFailedMs: elapsedFromStart(job.foregroundFailedAt),
    foregroundDestroyedMs: elapsedFromStart(job.foregroundDestroyedAt),
    foregroundReleasedMs: elapsedFromStart(job.foregroundReleasedAt),
    wakeLockAcquiredMs: elapsedFromStart(job.wakeLockAcquiredAt),
    wakeLockReleasedMs: elapsedFromStart(job.wakeLockReleasedAt),
    wakeLockFailedMs: elapsedFromStart(job.wakeLockFailedAt),
    appPausedMs: elapsedFromStart(job.appPausedAt),
    appStoppedMs: elapsedFromStart(job.appStoppedAt),
    appStartedMs: elapsedFromStart(job.appStartedAt),
    appResumedMs: elapsedFromStart(job.appResumedAt),
    networkSnapshotMs: elapsedFromStart(job.networkSnapshotAt),
    networkAvailableMs: elapsedFromStart(job.networkAvailableAt),
    networkLostMs: elapsedFromStart(job.networkLostAt),
    networkLosingMs: elapsedFromStart(job.networkLosingAt),
    networkCapabilitiesChangedMs: elapsedFromStart(job.networkCapabilitiesChangedAt),
    linkPropertiesChangedMs: elapsedFromStart(job.linkPropertiesChangedAt),
    networkBlockedMs: elapsedFromStart(job.networkBlockedAt),
    callStartMs: elapsedFromStart(job.callStartAt),
    openedMs: elapsedFromStart(job.openedAt),
    firstEventMs: elapsedFromStart(job.firstEventAt),
    firstVisibleMs: elapsedFromStart(job.firstVisibleAt),
    lastChunkMs: elapsedFromStart(job.lastChunkAt),
    lastReasoningMs: elapsedFromStart(job.lastReasoningAt),
    lastVisibleMs: elapsedFromStart(job.lastVisibleAt),
    lastActivityMs: elapsedFromStart(job.lastActivityAt),
    dnsStartMs: elapsedFromStart(job.dnsStartAt),
    dnsEndMs: elapsedFromStart(job.dnsEndAt),
    connectStartMs: elapsedFromStart(job.connectStartAt),
    connectEndMs: elapsedFromStart(job.connectEndAt),
    connectFailedMs: elapsedFromStart(job.connectFailedAt),
    secureConnectStartMs: elapsedFromStart(job.secureConnectStartAt),
    secureConnectEndMs: elapsedFromStart(job.secureConnectEndAt),
    connectionAcquiredMs: elapsedFromStart(job.connectionAcquiredAt),
    requestHeadersStartMs: elapsedFromStart(job.requestHeadersStartAt),
    requestHeadersEndMs: elapsedFromStart(job.requestHeadersEndAt),
    requestBodyStartMs: elapsedFromStart(job.requestBodyStartAt),
    requestBodyEndMs: elapsedFromStart(job.requestBodyEndAt),
    responseHeadersStartMs: elapsedFromStart(job.responseHeadersStartAt),
    responseHeadersEndMs: elapsedFromStart(job.responseHeadersEndAt),
    callEndMs: elapsedFromStart(job.callEndAt),
    callFailedMs: elapsedFromStart(job.callFailedAt),
    networkEvents: job.networkEvents,
    chunkCount: job.chunkCount,
    sseEvents: job.sseEvents,
    reasoningChars: job.reasoningChars,
    visibleChars: job.visibleChars,
    streamFinishReason: job.streamFinishReason,
    attempts: job.attempts,
  };
  throw error;
};