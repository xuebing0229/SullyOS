/**
 * MiniMax API endpoint resolution + native HTTP for Capacitor.
 *
 * Web/dev mode: prefers `/api/minimax/*` when a proxy exists.
 * Static web/file previews: falls back to MiniMax upstream directly.
 * Capacitor native: uses CapacitorHttp to bypass browser CORS.
 *
 * Region-aware: resolves upstream to either
 *   - 国内站   https://api.minimaxi.com   ('domestic', default)
 *   - 海外站   https://api.minimax.io     ('overseas')
 * The region is synced from OSContext via `setMinimaxRegion()` and also
 * forwarded on every request as `X-MiniMax-Region`, so server-side proxies
 * (Vite dev proxy, Vercel serverless, dev middleware) can route correctly.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MinimaxRegion } from '../types';
import { safeResponseJson } from './safeApi';

type MiniMaxResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  diagnostics?: {
    requestUrl: string;
    finalUrl: string;
    redirected: boolean;
    authorizationPresent: boolean;
    authorizationScheme: string;
    sentHeaderNames: string[];
  };
};

const REGION_BASE_URLS: Record<MinimaxRegion, string> = {
  domestic: 'https://api.minimaxi.com',
  overseas: 'https://api.minimax.io',
};

// Proxy path → upstream endpoint (concatenated with region base).
const PROXY_ENDPOINTS: Record<string, string> = {
  '/api/minimax/t2a': '/v1/t2a_v2',
  '/api/minimax/get-voice': '/v1/get_voice',
  '/api/minimax/music': '/v1/music_generation',
};

let currentRegion: MinimaxRegion = 'domestic';

export const normalizeMinimaxRegion = (
  raw: unknown,
): MinimaxRegion =>
  raw === 'overseas' ? 'overseas' : 'domestic';

export function setMinimaxRegion(
  region: MinimaxRegion | string | undefined | null,
): void {
  currentRegion = normalizeMinimaxRegion(region);
}

export function getMinimaxRegion(): MinimaxRegion {
  return currentRegion;
}

export function getMinimaxBaseUrl(
  region: MinimaxRegion = currentRegion,
): string {
  return REGION_BASE_URLS[normalizeMinimaxRegion(region)];
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
  const endpoint = PROXY_ENDPOINTS[proxyPath];

  if (!endpoint) {
    return null;
  }

  return `${getMinimaxBaseUrl(region)}${endpoint}`;
};

const wrapWebResponse = (
  response: Response,
): MiniMaxResponseLike => ({
  ok: response.ok,
  status: response.status,
  json: async () => safeResponseJson(response.clone()),
});

/**
 * Return the actual URL to fetch for a given proxy path.
 * Native platforms always hit the upstream directly (no CORS).
 */
export function resolveMinimaxUrl(
  proxyPath: string,
): string {
  const upstream = getUpstreamUrl(proxyPath);

  if (upstream && isNative()) {
    return upstream;
  }

  return proxyPath;
}

const normalizeHeaders = (
  headers: Record<string, string> = {},
): Record<string, string> => {
  const normalized: Record<string, string> = {};

  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });

  return normalized;
};

const withRegionHeader = (
  headers: Record<string, string> = {},
  region: MinimaxRegion,
): Record<string, string> => ({
  ...headers,
  'X-MiniMax-Region': region,
});

const buildUpstreamWebInit = (
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
} => {
  const headers = normalizeHeaders(init.headers || {});
  const groupId = (
    headers['x-minimax-group-id'] || ''
  ).trim();

  // These headers are only used by the project's own proxy.
  // They must not be sent directly to MiniMax upstream.
  delete headers['x-minimax-api-key'];
  delete headers['x-minimax-group-id'];
  delete headers['x-minimax-region'];

  if (!groupId || !init.body) {
    return {
      ...init,
      headers,
    };
  }

  try {
    const body = JSON.parse(init.body);

    if (
      body &&
      typeof body === 'object' &&
      !body.group_id
    ) {
      body.group_id = groupId;

      return {
        ...init,
        headers,
        body: JSON.stringify(body),
      };
    }
  } catch {
    // Keep the original body when it is not JSON.
  }

  return {
    ...init,
    headers,
  };
};

const shouldBypassWebProxy = (
  proxyPath: string,
): boolean => {
  if (!PROXY_ENDPOINTS[proxyPath]) {
    return false;
  }

  if (typeof window === 'undefined') {
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
    response.headers.get('content-type') || ''
  ).toLowerCase();

  return (
    contentType.includes('text/html') ||
    contentType.includes('application/xhtml+xml')
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
  const upstream = getUpstreamUrl(proxyPath, region);

  if (!upstream) {
    throw new Error(
      `No upstream mapping for ${proxyPath}`,
    );
  }

  return wrapWebResponse(
    await fetch(
      upstream,
      buildUpstreamWebInit(init),
    ),
  );
};

/**
 * A fetch-like wrapper that uses CapacitorHttp on native platforms
 * and safe JSON parsing on web. The current MiniMax region is
 * appended as `X-MiniMax-Region` so server-side proxies can route.
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

  const enrichedInit = {
    ...init,
    headers: withRegionHeader(
      init.headers,
      region,
    ),
  };

  const url = resolveMinimaxUrl(proxyPath);

  if (!isNative()) {
    if (shouldBypassWebProxy(proxyPath)) {
      return fetchUpstreamWeb(
        proxyPath,
        enrichedInit,
        region,
      );
    }

    try {
      const response = await fetch(
        url,
        enrichedInit,
      );

      // Static preview servers can rewrite missing
      // /api routes to index.html.
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

      return wrapWebResponse(response);
    } catch (error) {
      if (PROXY_ENDPOINTS[proxyPath]) {
        return fetchUpstreamWeb(
          proxyPath,
          enrichedInit,
          region,
        );
      }

      throw error;
    }
  }

  /*
   * Android APK requests MiniMax directly.
   *
   * Build a new header object instead of reusing proxy headers.
   * This guarantees that the standard Authorization header exists
   * and preserves its canonical spelling.
   *
   * Diagnostic information never contains the actual API Key.
   */
  const sourceHeaders = init.headers || {};

  const findHeader = (
    name: string,
  ): string => {
    const entry = Object.entries(
      sourceHeaders,
    ).find(
      ([key]) =>
        key.toLowerCase() ===
        name.toLowerCase(),
    );

    return entry
      ? String(entry[1] || '').trim()
      : '';
  };

  const rawAuthorization =
    findHeader('Authorization');

  const rawApiKey =
    findHeader('X-MiniMax-API-Key');

  const apiKey = (
    rawAuthorization || rawApiKey
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  if (!apiKey) {
    throw new Error(
      'MiniMax 原生请求缺少 API Key，无法生成 Authorization 请求头',
    );
  }

  const nativeHeaders: Record<string, string> = {
    'Content-Type':
      findHeader('Content-Type') ||
      'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  let nativeBody: any = init.body
    ? JSON.parse(init.body)
    : undefined;

  const groupId = findHeader(
    'X-MiniMax-Group-Id',
  );

  if (
    groupId &&
    nativeBody &&
    typeof nativeBody === 'object' &&
    !nativeBody.group_id
  ) {
    nativeBody = {
      ...nativeBody,
      group_id: groupId,
    };
  }

  const performNativeRequest = async (
    requestUrl: string,
  ) =>
    CapacitorHttp.request({
      url: requestUrl,
      method: init.method || 'POST',
      headers: nativeHeaders,
      data: nativeBody,
      disableRedirects: true,
    });

  let finalUrl = url;
  let redirected = false;

  let response =
    await performNativeRequest(finalUrl);

  /*
   * Some native HTTP stacks remove Authorization while automatically
   * following redirects. Follow one redirect manually and resend the
   * same Authorization header.
   */
  if (
    [301, 302, 303, 307, 308].includes(
      response.status,
    )
  ) {
    const responseHeaders =
      response.headers || {};

    const locationEntry = Object.entries(
      responseHeaders,
    ).find(
      ([key]) =>
        key.toLowerCase() === 'location',
    );

    const location = locationEntry
      ? String(locationEntry[1] || '').trim()
      : '';

    if (location) {
      finalUrl = new URL(
        location,
        url,
      ).toString();

      redirected = true;

      response =
        await performNativeRequest(finalUrl);
    }
  }

  return {
    ok:
      response.status >= 200 &&
      response.status < 300,

    status: response.status,

    json: async () => response.data,

    diagnostics: {
      requestUrl: url,
      finalUrl,
      redirected,
      authorizationPresent: true,
      authorizationScheme: 'Bearer',
      sentHeaderNames:
        Object.keys(nativeHeaders),
    },
  };
}
