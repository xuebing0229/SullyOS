import { Capacitor, registerPlugin } from '@capacitor/core';

import { ActiveMsgClient } from './activeMsgClient';
import { finishNativeCloudStoryMonitor } from './nativeStoryBackground';

const CLOUD_STORAGE_KEY = 'sully_story_cloud_pending_v1';
const NATIVE_STORAGE_KEY = 'sully_story_background_pending_v1';
const CANCEL_TIMEOUT_MS = 12_000;

interface PendingStoryHandle {
    jobId: string;
    ownerKey: string;
    title?: string;
}

interface NativeStoryCancelPlugin {
    remove(options: { jobId: string }): Promise<void>;
}

const NativeStoryBackground = registerPlugin<NativeStoryCancelPlugin>('SullyStoryBackground');

const readPendingMap = (storageKey: string): Record<string, PendingStoryHandle> => {
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch {
        return {};
    }
};

const clearPendingOwner = (storageKey: string, ownerKey: string): void => {
    try {
        const map = readPendingMap(storageKey);
        if (!map[ownerKey]) return;
        delete map[ownerKey];
        localStorage.setItem(storageKey, JSON.stringify(map));
    } catch {
        // best effort only
    }
};

const normalizeWorkerUrl = (value: string): string =>
    String(value || '').trim().replace(/\/+$/, '');

export interface StoryGenerationCancelResult {
    found: boolean;
    cancelled: boolean;
    transport?: 'cloud' | 'native';
    terminalStatus?: string;
    error?: string;
}

/**
 * 用户主动停止当前文游剧情生成。
 *
 * 与普通的 clearPending* 不同，这里是真正的“取消”：云端任务发 DELETE 给 Worker；
 * 旧 native EventSource 任务则调用原生 remove。只有取消请求得到明确结论后才清本地恢复指针，
 * 这样网络偶发失败时仍然可以再次点停止，不会把一个还在跑的任务变成孤儿。
 */
export const cancelStoryGenerationByOwner = async (
    ownerKey: string,
): Promise<StoryGenerationCancelResult> => {
    const normalizedOwnerKey = String(ownerKey || '').trim();
    if (!normalizedOwnerKey) return { found: false, cancelled: false };

    const cloudPending = readPendingMap(CLOUD_STORAGE_KEY)[normalizedOwnerKey];
    if (cloudPending?.jobId) {
        try {
            const config = await ActiveMsgClient.getGlobalConfig();
            const workerUrl = normalizeWorkerUrl(config.workerUrl || '');
            const userId = String(config.userId || '').trim();
            if (!/^https?:\/\//i.test(workerUrl) || !userId) {
                return {
                    found: true,
                    cancelled: false,
                    transport: 'cloud',
                    error: '主动消息 Worker 配置不可用，暂时无法取消云端剧情任务',
                };
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
            try {
                const headers = new Headers({
                    Accept: 'application/json',
                    'X-User-Id': userId,
                });
                const serverToken = String(config.serverToken || '').trim();
                if (serverToken) headers.set('X-Client-Token', serverToken);
                const response = await fetch(
                    `${workerUrl}/story-jobs/${encodeURIComponent(cloudPending.jobId)}`,
                    {
                        method: 'DELETE',
                        headers,
                        cache: 'no-store',
                        signal: controller.signal,
                    },
                );
                const text = await response.text();
                let body: any = null;
                if (text) {
                    try { body = JSON.parse(text); }
                    catch { body = { error: text.slice(0, 500) }; }
                }
                if (!response.ok) {
                    return {
                        found: true,
                        cancelled: false,
                        transport: 'cloud',
                        error: body?.error?.message
                            || body?.error
                            || `取消剧情云端任务失败（HTTP ${response.status}）`,
                    };
                }

                clearPendingOwner(CLOUD_STORAGE_KEY, normalizedOwnerKey);
                const terminalStatus = String(body?.job?.status || '');
                await finishNativeCloudStoryMonitor({
                    jobId: cloudPending.jobId,
                    title: String(cloudPending.title || '剧情'),
                    status: 'cancelled',
                    error: '已由用户停止',
                }).catch(() => undefined);
                return {
                    found: true,
                    cancelled: terminalStatus === 'cancelled' || !terminalStatus,
                    transport: 'cloud',
                    terminalStatus: terminalStatus || undefined,
                };
            } finally {
                clearTimeout(timeout);
            }
        } catch (error: any) {
            return {
                found: true,
                cancelled: false,
                transport: 'cloud',
                error: String(error?.message || error),
            };
        }
    }

    const nativePending = readPendingMap(NATIVE_STORAGE_KEY)[normalizedOwnerKey];
    if (nativePending?.jobId && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
        try {
            await NativeStoryBackground.remove({ jobId: nativePending.jobId });
            clearPendingOwner(NATIVE_STORAGE_KEY, normalizedOwnerKey);
            return { found: true, cancelled: true, transport: 'native', terminalStatus: 'cancelled' };
        } catch (error: any) {
            return {
                found: true,
                cancelled: false,
                transport: 'native',
                error: String(error?.message || error),
            };
        }
    }

    return { found: false, cancelled: false };
};
