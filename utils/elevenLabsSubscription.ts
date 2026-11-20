/** ElevenLabs 官方订阅额度查询：只读，不生成语音，不缓存 Key。 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { normalizeApiKey } from './minimaxApiKey';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';

const UPSTREAM = 'https://api.elevenlabs.io/v1/user/subscription';
export const ELEVENLABS_USAGE_CHANGED_EVENT = 'sully:elevenlabs-usage-changed';

export interface ElevenLabsSubscriptionBalance {
  used: number;
  limit: number;
  remaining: number;
  tier: string;
  nextResetUnix: number | null;
  overageEnabled: boolean;
}

export function parseElevenLabsSubscriptionBalance(raw: unknown): ElevenLabsSubscriptionBalance {
  if (!raw || typeof raw !== 'object') throw new Error('ElevenLabs 未返回有效订阅信息');
  const data = raw as Record<string, unknown>;
  const used = data.character_count;
  const limit = data.character_limit;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 ||
      typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    throw new Error('ElevenLabs 返回的额度字段不完整');
  }
  const reset = data.next_character_count_reset_unix;
  return {
    used: Math.trunc(used),
    limit: Math.trunc(limit),
    remaining: Math.max(0, Math.trunc(limit) - Math.trunc(used)),
    tier: typeof data.tier === 'string' ? data.tier : '',
    nextResetUnix: typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset : null,
    overageEnabled: data.can_extend_character_limit === true && data.max_credit_limit_extension !== 0,
  };
}

function subscriptionError(status: number): Error {
  if (status === 401) return new Error('API Key 无效或已过期');
  if (status === 403) return new Error('Key 无读取权限，请在 ElevenLabs 为此 Key 开启 User: Read');
  if (status === 429) return new Error('查询太频繁，请稍后再试');
  return new Error('查询 ElevenLabs 额度失败 (HTTP ' + status + ')');
}

export async function fetchElevenLabsSubscriptionBalance(rawApiKey: string): Promise<ElevenLabsSubscriptionBalance> {
  const apiKey = normalizeApiKey(rawApiKey);
  if (!apiKey) throw new Error('请先填写 ElevenLabs API Key');
  let data: unknown;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      method: 'GET',
      url: UPSTREAM,
      headers: { 'xi-api-key': apiKey, 'Accept': 'application/json' },
      responseType: 'json',
      connectTimeout: 12000,
      readTimeout: 12000,
    });
    if (response.status < 200 || response.status >= 300) throw subscriptionError(response.status);
    data = response.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error('ElevenLabs 订阅信息解析失败'); }
    }
  } else {
    const staticWeb = typeof window !== 'undefined' &&
      isStaticWebDeployment(window.location.protocol, window.location.hostname);
    const endpoint = staticWeb
      ? getProxyWorkerUrl() + '/elevenlabs/subscription'
      : '/api/elevenlabs/subscription';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { 'xi-api-key': apiKey, 'Accept': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw subscriptionError(response.status);
      try { data = await response.json(); } catch { throw new Error('ElevenLabs 订阅信息解析失败'); }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw new Error('查询超时，请检查网络');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  return parseElevenLabsSubscriptionBalance(data);
}

/** 发给余额 UI 的事件只包含预设 ID，不包含 Key 或用户身份。 */
export function notifyElevenLabsUsageChanged(presetId: string): void {
  if (typeof window === 'undefined' || !presetId) return;
  window.dispatchEvent(new CustomEvent(ELEVENLABS_USAGE_CHANGED_EVENT, { detail: { presetId } }));
}
