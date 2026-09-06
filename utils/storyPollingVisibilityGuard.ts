import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

const STORY_POLL_TIMEOUT_MS = 20_000;

interface ActivePollAttempt {
  controller: AbortController;
  suspended: boolean;
}

let installed = false;
let nativeAppActive = true;
let lastVisible = true;
const visibleWaiters = new Set<() => void>();
const activeAttempts = new Set<ActivePollAttempt>();

const isAndroidNativeRuntime = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const isStoryPollingVisible = (): boolean =>
  typeof document === 'undefined'
  || (nativeAppActive && document.visibilityState === 'visible');

const flushVisibleWaiters = (): void => {
  if (!isStoryPollingVisible()) return;
  const waiters = [...visibleWaiters];
  visibleWaiters.clear();
  for (const resolve of waiters) resolve();
};

const suspendActiveAttempts = (): void => {
  for (const attempt of activeAttempts) {
    attempt.suspended = true;
    attempt.controller.abort();
  }
};

const refreshVisibilityState = (): void => {
  const visible = isStoryPollingVisible();
  if (visible === lastVisible) {
    if (visible) flushVisibleWaiters();
    return;
  }

  lastVisible = visible;
  if (visible) flushVisibleWaiters();
  else suspendActiveAttempts();
};

const waitUntilStoryPollingVisible = async (): Promise<void> => {
  if (isStoryPollingVisible()) return;
  await new Promise<void>(resolve => visibleWaiters.add(resolve));
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
};

const requestMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return String(input.method || 'GET').toUpperCase();
  }
  return 'GET';
};

const isStoryJobStatusGet = (input: RequestInfo | URL, init?: RequestInit): boolean => {
  if (requestMethod(input, init) !== 'GET') return false;
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://localhost/';
    const path = new URL(requestUrl(input), base).pathname;
    return /(?:^|\/)story-jobs\/(?:by-client\/)?[^/]+\/?$/.test(path);
  } catch {
    return false;
  }
};

const withAttemptSignal = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
): [RequestInfo | URL, RequestInit | undefined] => {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return [new Request(input, { ...init, signal }), undefined];
  }
  return [input, { ...init, signal }];
};

/**
 * Android WebView 在退到后台后可能冻结计时器/网络栈。剧情正文已经由原生
 * SullyStoryCloudMonitorService 继续盯 Worker，因此 JS 侧不应该再后台轮询同一 job。
 *
 * 这里只拦截 story-jobs 的 GET：POST 创建任务完全不碰，确保用户点生成后立刻切屏时
 * 请求已经交给 Worker。隐藏时若已有 GET 在飞，就主动撤掉；恢复前台后立即重试同一 GET。
 * 这个“生命周期撤销”不会冒泡给剧情 UI，因此不会被当成 SYSTEM ERROR。
 */
export const installStoryPollingVisibilityGuard = (): void => {
  if (installed || !isAndroidNativeRuntime() || typeof window === 'undefined') return;
  installed = true;

  nativeAppActive = document.visibilityState === 'visible';
  lastVisible = isStoryPollingVisible();

  document.addEventListener('visibilitychange', refreshVisibilityState);

  void App.getState()
    .then(({ isActive }) => {
      nativeAppActive = isActive;
      refreshVisibilityState();
    })
    .catch(() => undefined);

  void App.addListener('appStateChange', ({ isActive }) => {
    nativeAppActive = isActive;
    refreshVisibilityState();
  }).catch(() => undefined);

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isStoryJobStatusGet(input, init)) {
      return originalFetch(input, init);
    }

    for (;;) {
      await waitUntilStoryPollingVisible();

      const controller = new AbortController();
      const attempt: ActivePollAttempt = { controller, suspended: false };
      activeAttempts.add(attempt);
      const timeout = setTimeout(() => controller.abort(), STORY_POLL_TIMEOUT_MS);

      try {
        const [attemptInput, attemptInit] = withAttemptSignal(input, init, controller.signal);
        const response = await originalFetch(attemptInput, attemptInit);
        if (!attempt.suspended && isStoryPollingVisible()) return response;
      } catch (error) {
        // 只有“切到后台导致的 abort”被吞掉并在 resume 后重试。
        // 真正的 20s 超时、HTTP 网络错误仍按原逻辑交回调用方处理。
        if (!attempt.suspended) throw error;
      } finally {
        clearTimeout(timeout);
        activeAttempts.delete(attempt);
      }
    }
  };
};
