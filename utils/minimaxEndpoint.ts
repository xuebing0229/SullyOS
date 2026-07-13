/**
 * MiniMax API endpoint resolution.
 *
 * Web/dev mode:
 *   - Prefer the project's `/api/minimax/*` proxy.
 *   - Static previews fall back to MiniMax upstream.
 *
 * Android/Capacitor mode:
 *   - Request MiniMax upstream directly with standard fetch().
 *   - Do not use CapacitorHttp because the native bridge may discard
 *     the Authorization header on this device/build.
 */

import { Capacitor } from '@capacitor/core';
import type { MinimaxRegion } from '../types';
import { safeResponseJson } from './safeApi';

type MiniMaxDiagnostics = {
  requestUrl: string;
  finalUrl: string;
  redirected: boolean;
  authorizationPresent: boolean;
  authorizationScheme: string;
  sentHeaderNames: string[];
};

type MiniMaxResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  diagnostics?: MiniMaxDiagnostics;
};

const REGION_BASE_URLS: Record<
  MinimaxRegion,
  string
> = {
  domestic: 'https://api.minimaxi.com',
  overseas: 'https://api.minimax.io',
};

const PROXY_ENDPOINTS: Record<
  string,
  string
> = {
  '/api/minimax/t2a': '/v1/t2a_v2',
  '/api/minimax/get-voice': '/v1/get_voice',
  '/api/minimax/music': '/v1/music_generation',
};

let currentRegion: MinimaxRegion =
  'domestic';

export const normalizeMinimaxRegion = (
  raw: unknown,
): MinimaxRegion =>
  raw === 'overseas'
    ? 'overseas'
    : 'domestic';

export function setMinimaxRegion(
  region:
    | MinimaxRegion
    | string
    | undefined
    | null,
): void {
  currentRegion =
    normalizeMinimaxRegion(region);
}

export function getMinimaxRegion():
  MinimaxRegion {
  return currentRegion;
}

export function getMinimaxBaseUrl(
  region: MinimaxRegion = currentRegion,
): string {
  return REGION_BASE_URLS[
    normalizeMinimaxRegion(region)
  ];
}

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const getUpstreamUrl = (
  proxyPath: string,
  region: MinimaxRegion = currentRegion,
): string | null => {
  const endpoint =
    PROXY_ENDPOINTS[proxyPath];

  if (!endpoint) {
    return null;
  }

  return (
    getMinimaxBaseUrl(region) +
    endpoint
  );
};

const normalizeHeaders = (
  headers: Record<string, string> = {},
): Record<string, string> => {
  const normalized: Record<
    string,
    string
  > = {};

  Object.entries(headers).forEach(
    ([key, value]) => {
      normalized[key.toLowerCase()] =
        String(value);
    },
  );

  return normalized;
};

const findHeader = (
  headers: Record<string, string>,
  name: string,
): string => {
  const entry = Object.entries(
    headers,
  ).find(
    ([key]) =>
      key.toLowerCase() ===
      name.toLowerCase(),
  );

  return entry
    ? String(entry[1] || '').trim()
    : '';
};

const withRegionHeader = (
  headers: Record<string, string> = {},
  region: MinimaxRegion,
): Record<string, string> => ({
  ...headers,
  'X-MiniMax-Region': region,
});

const buildDirectRequest = (
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): {
  method: string;
  headers: Record<string, string>;
  body?: string;
} => {
  const sourceHeaders =
    init.headers || {};

  const rawAuthorization =
    findHeader(
      sourceHeaders,
      'Authorization',
    );

  const rawApiKey =
    findHeader(
      sourceHeaders,
      'X-MiniMax-API-Key',
    );

  const apiKey = (
    rawAuthorization || rawApiKey
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  if (!apiKey) {
    throw new Error(
      'MiniMax 直连请求缺少 API Key，无法生成 Authorization 请求头',
    );
  }

  const groupId =
    findHeader(
      sourceHeaders,
      'X-MiniMax-Group-Id',
    );

  let requestBody =
    init.body || undefined;

  if (groupId && requestBody) {
    try {
      const parsedBody =
        JSON.parse(requestBody);

      if (
        parsedBody &&
        typeof parsedBody === 'object' &&
        !parsedBody.group_id
      ) {
        parsedBody.group_id =
          groupId;

        requestBody =
          JSON.stringify(parsedBody);
      }
    } catch {
      // 请求体不是 JSON 时保持原样。
    }
  }

  /*
   * 直接构造全新的请求头。
   *
   * 不把下面这些项目内部代理头发送给 MiniMax：
   *   X-MiniMax-API-Key
   *   X-MiniMax-Group-Id
   *   X-MiniMax-Region
   */
  const directHeaders: Record<
    string,
    string
  > = {
    'Content-Type':
      findHeader(
        sourceHeaders,
        'Content-Type',
      ) || 'application/json',

    Authorization:
      `Bearer ${apiKey}`,
  };

  return {
    method: init.method || 'POST',
    headers: directHeaders,
    body: requestBody,
  };
};

const wrapFetchResponse = (
  response: Response,
  diagnostics?: MiniMaxDiagnostics,
): MiniMaxResponseLike => ({
  ok: response.ok,

  status: response.status,

  json: async () =>
    safeResponseJson(
      response.clone(),
    ),

  diagnostics,
});

const shouldBypassWebProxy = (
  proxyPath: string,
): boolean => {
  if (!PROXY_ENDPOINTS[proxyPath]) {
    return false;
  }

  if (
    typeof window === 'undefined'
  ) {
    return false;
  }

  const protocol = String(
    window.location.protocol || '',
  ).toLowerCase();

  if (protocol === 'file:') {
    return true;
  }

  const host = String(
    window.location.hostname || '',
  ).toLowerCase();

  return (
    host === 'github.io' ||
    host.endsWith('.github.io')
  );
};

const shouldRetryAgainstUpstream = (
  proxyPath: string,
  response: Response,
): boolean => {
  if (!PROXY_ENDPOINTS[proxyPath]) {
    return false;
  }

  if (
    response.status === 404 ||
    response.status === 405
  ) {
    return true;
  }

  const contentType = (
    response.headers.get(
      'content-type',
    ) || ''
  ).toLowerCase();

  return (
    contentType.includes(
      'text/html',
    ) ||
    contentType.includes(
      'application/xhtml+xml',
    )
  );
};

const fetchUpstreamWeb = async (
  proxyPath: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
  region: MinimaxRegion,
): Promise<MiniMaxResponseLike> => {
  const upstream =
    getUpstreamUrl(
      proxyPath,
      region,
    );

  if (!upstream) {
    throw new Error(
      `No upstream mapping for ${proxyPath}`,
    );
  }

  const directInit =
    buildDirectRequest(init);

  const response = await fetch(
    upstream,
    {
      method: directInit.method,
      headers: directInit.headers,
      body: directInit.body,
    },
  );

  return wrapFetchResponse(
    response,
    {
      requestUrl: upstream,

      finalUrl:
        response.url || upstream,

      redirected:
        response.redirected === true,

      authorizationPresent: true,

      authorizationScheme:
        'Bearer',

      sentHeaderNames:
        Object.keys(
          directInit.headers,
        ),
    },
  );
};

/**
 * Resolve the actual URL used by a MiniMax request.
 *
 * Android APK always requests MiniMax upstream directly.
 */
export function resolveMinimaxUrl(
  proxyPath: string,
): string {
  const upstream =
    getUpstreamUrl(proxyPath);

  if (upstream && isNative()) {
    return upstream;
  }

  return proxyPath;
}

/**
 * MiniMax fetch wrapper.
 */
export async function minimaxFetch(
  proxyPath: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<MiniMaxResponseLike> {
  const region = currentRegion;

  /*
   * Android APK:
   *
   * Do not use CapacitorHttp.request().
   * Use the browser-standard fetch implementation and explicitly
   * provide Authorization.
   */
  if (isNative()) {
    const upstream =
      getUpstreamUrl(
        proxyPath,
        region,
      );

    if (!upstream) {
      throw new Error(
        `MiniMax 原生请求没有对应接口：${proxyPath}`,
      );
    }

    const directInit =
      buildDirectRequest(init);

    console.error(
      `[MM-NATIVE-1] TRANSPORT=fetch`,
    );

    console.error(
      `[MM-NATIVE-2] URL=${upstream}`,
    );

    console.error(
      `[MM-NATIVE-3] HEADERS=${Object.keys(
        directInit.headers,
      ).join('|')}`,
    );

    console.error(
      `[MM-NATIVE-4] AUTH_CONSTRUCTED=yes`,
    );

    try {
      const response =
        await fetch(
          upstream,
          {
            method:
              directInit.method,

            headers:
              directInit.headers,

            body:
              directInit.body,

            redirect: 'follow',

            cache: 'no-store',
          },
        );

      const finalUrl =
        response.url || upstream;

      console.error(
        `[MM-NATIVE-5] HTTP=${response.status}`,
      );

      console.error(
        `[MM-NATIVE-6] REDIRECTED=${
          response.redirected
            ? 'yes'
            : 'no'
        }`,
      );

      console.error(
        `[MM-NATIVE-7] FINAL_URL=${finalUrl}`,
      );

      return wrapFetchResponse(
        response,
        {
          requestUrl: upstream,

          finalUrl,

          redirected:
            response.redirected === true,

          authorizationPresent:
            true,

          authorizationScheme:
            'Bearer',

          sentHeaderNames:
            Object.keys(
              directInit.headers,
            ),
        },
      );
    } catch (error: any) {
      const errorName =
        error?.name ||
        'UnknownError';

      const errorMessage =
        error?.message ||
        String(error);

      /*
       * 如果 MiniMax 不允许 WebView 跨域直连，这里会明确记录
       * TypeError / Failed to fetch，而不是继续显示错误的登录提示。
       */
      console.error(
        `[MM-NATIVE-ERR-1] NAME=${errorName}`,
      );

      console.error(
        `[MM-NATIVE-ERR-2] MESSAGE=${errorMessage}`,
      );

      console.error(
        `[MM-NATIVE-ERR-3] URL=${upstream}`,
      );

      throw new Error(
        `MiniMax 标准 fetch 请求失败：${errorName}: ${errorMessage}`,
      );
    }
  }

  /*
   * Web/dev mode:
   *
   * Continue using the local/server proxy when it exists.
   */
  const enrichedInit = {
    ...init,

    headers: withRegionHeader(
      init.headers,
      region,
    ),
  };

  if (
    shouldBypassWebProxy(
      proxyPath,
    )
  ) {
    return fetchUpstreamWeb(
      proxyPath,
      enrichedInit,
      region,
    );
  }

  try {
    const response =
      await fetch(
        proxyPath,
        enrichedInit,
      );

    if (
      shouldRetryAgainstUpstream(
        proxyPath,
        response,
      )
    ) {
      return fetchUpstreamWeb(
        proxyPath,
        enrichedInit,
        region,
      );
    }

    return wrapFetchResponse(
      response,
    );
  } catch (error) {
    if (
      PROXY_ENDPOINTS[proxyPath]
    ) {
      return fetchUpstreamWeb(
        proxyPath,
        enrichedInit,
        region,
      );
    }

    throw error;
  }
}
