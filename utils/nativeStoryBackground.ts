import { Capacitor, registerPlugin } from '@capacitor/core';

interface SullyStoryBackgroundPlugin {
  acquireKeepAlive(options: { leaseId: string; title?: string }): Promise<void>;
  releaseKeepAlive(options: { leaseId: string }): Promise<void>;
}

const NativeStoryBackground = registerPlugin<SullyStoryBackgroundPlugin>('SullyStoryBackground');
const LEGACY_STORAGE_KEY = 'sully_story_background_pending_v1';

export const clearPendingNativeStoryJob = async (ownerKey: string): Promise<void> => {
  // 9/3 以前的原生直连版本会在这里留下 pending 元数据。新版不再创建 native
  // completion job，只清本地遗留，防止升级后出现“幽灵任务”。
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    if (!(ownerKey in parsed)) return;
    delete parsed[ownerKey];
    if (Object.keys(parsed).length === 0) localStorage.removeItem(LEGACY_STORAGE_KEY);
    else localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // best effort only
  }
};

export const isNativeStoryBackgroundRuntime = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const makeKeepAliveLeaseId = (ownerKey: string): string => {
  const safeOwner = String(ownerKey || 'story').replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 80);
  return `storykeep:${safeOwner}:${Date.now().toString(36)}`;
};

/**
 * Android 原生层只负责前台服务 + WakeLock。
 * 模型 HTTP/SSE 永远由 WebView 的 safeApi 发送和解析，避免维护第二套传输协议。
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
