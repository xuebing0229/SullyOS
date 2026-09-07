export interface StoryEgressEnv {
  STORY_EGRESS_RELAY_URL?: string;
  STORY_EGRESS_RELAY_TOKEN?: string;
}

export interface StoryEgressRoute {
  url: string;
  relayed: boolean;
}

const normalizeRelayUrl = (value: string): string => value.trim();

export const resolveStoryEgressRoute = (
  env: StoryEgressEnv,
  targetUrl: string,
): StoryEgressRoute => {
  const relayUrl = normalizeRelayUrl(String(env.STORY_EGRESS_RELAY_URL || ''));
  const relayToken = String(env.STORY_EGRESS_RELAY_TOKEN || '').trim();

  if (!relayUrl && !relayToken) {
    return { url: targetUrl, relayed: false };
  }
  if (!relayUrl || !relayToken) {
    throw new Error('剧情统一出口配置不完整：STORY_EGRESS_RELAY_URL 与 STORY_EGRESS_RELAY_TOKEN 必须同时配置');
  }

  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error('剧情统一出口地址无效：STORY_EGRESS_RELAY_URL 不是合法 URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('剧情统一出口必须使用 HTTPS');
  }

  return { url: parsed.toString(), relayed: true };
};

/**
 * 剧情云端任务的统一模型出口。
 *
 * - 未配置 relay：保持旧行为，Cloudflare Worker 直接请求模型上游。
 * - relay URL + token 同时配置：所有剧情模型线路统一经 relay 出网。
 * - 只配置一半：明确失败，不偷偷回退 Cloudflare 直连，避免同一个上游一会儿走日本机、
 *   一会儿又走 Cloudflare 出口，排障时无法判断真实路径。
 */
export const fetchStoryUpstream = async (
  env: StoryEgressEnv,
  targetUrl: string,
  init: RequestInit,
): Promise<Response> => {
  const route = resolveStoryEgressRoute(env, targetUrl);
  if (!route.relayed) return fetch(targetUrl, init);

  const headers = new Headers(init.headers || {});
  headers.set('X-Sully-Egress-Version', '1');
  headers.set('X-Sully-Egress-Target', targetUrl);
  headers.set('X-Sully-Egress-Token', String(env.STORY_EGRESS_RELAY_TOKEN || '').trim());

  return fetch(route.url, {
    ...init,
    headers,
  });
};
