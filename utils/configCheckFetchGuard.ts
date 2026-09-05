const CONFIG_CHECK_TIMEOUT_MS = 8_000;

const isConfigCheckRequest = (input: RequestInfo | URL, init?: RequestInit): boolean => {
  const method = (
    init?.method
    || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  if (method !== 'GET') return false;

  let rawUrl = '';
  if (typeof input === 'string') rawUrl = input;
  else if (typeof URL !== 'undefined' && input instanceof URL) rawUrl = input.toString();
  else if (typeof Request !== 'undefined' && input instanceof Request) rawUrl = input.url;

  if (!rawUrl) return false;
  try {
    const pathname = new URL(rawUrl, window.location.href).pathname.replace(/\/+$/, '');
    return pathname.endsWith('/config-check');
  } catch {
    return /\/config-check(?:[?#]|$)/.test(rawUrl);
  }
};

const isAbortLike = (error: unknown): boolean => {
  const value = error as { name?: unknown; message?: unknown } | null | undefined;
  if (value?.name === 'AbortError' || value?.name === 'TimeoutError') return true;
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  return message.includes('aborted') || message.includes('aborterror');
};

/**
 * /config-check 只是设置页和运行时的只读能力探测，不该无限吊在 Android WebView 里。
 *
 * 以前这些探测有几条没带 timeout：切后台/锁屏后请求可能挂几分钟，等 WebView 恢复时
 * 才以 AbortError 收尾。OSContext 的全局 fetch 诊断会把这个「生命周期取消」当成真正
 * 网络故障，结果就是体检已经全绿，顶部还冒 SYSTEM ERROR。
 *
 * 这里放在 OSContext 的 fetch 拦截器下面一层：
 *   1. 给所有 GET /config-check 统一 8s 护栏；
 *   2. 只吞掉 Abort/Timeout 这一类探测取消，转换成 success:false 的本地响应；
 *   3. DNS、CORS、Failed to fetch、真实 HTTP 错误仍原样交给现有诊断系统。
 *
 * 这样既不会再留下几分钟的僵尸探测，也不会掩盖真正的 Worker 连通性问题。
 */
const installConfigCheckFetchGuard = (): void => {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  const marker = '__sullyConfigCheckFetchGuardInstalled';
  const host = window as typeof window & Record<string, unknown>;
  if (host[marker] === true) return;
  host[marker] = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isConfigCheckRequest(input, init) || typeof AbortController === 'undefined') {
      return nativeFetch(input, init);
    }

    const controller = new AbortController();
    const inheritedSignal = init?.signal
      || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);

    const forwardAbort = () => {
      if (!controller.signal.aborted) controller.abort();
    };

    if (inheritedSignal) {
      if (inheritedSignal.aborted) forwardAbort();
      else inheritedSignal.addEventListener('abort', forwardAbort, { once: true });
    }

    const timer = window.setTimeout(forwardAbort, CONFIG_CHECK_TIMEOUT_MS);

    try {
      return await nativeFetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted && !isAbortLike(error)) throw error;

      return new Response(JSON.stringify({
        success: false,
        error: {
          code: 'CONFIG_CHECK_ABORTED',
          message: 'config-check probe cancelled',
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Sully-Probe-Aborted': '1',
        },
      });
    } finally {
      window.clearTimeout(timer);
      inheritedSignal?.removeEventListener('abort', forwardAbort);
    }
  }) as typeof window.fetch;
};

installConfigCheckFetchGuard();

export {};
