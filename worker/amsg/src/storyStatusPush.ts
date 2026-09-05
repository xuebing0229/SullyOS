import {
  createWebCryptoWebPush,
  decryptFromStorage,
  deriveUserEncryptionKey,
} from '@rei-standard/amsg-server/cloudflare';

import {
  createHybridPushTransport,
  isFcmConfigured,
  type NativeFcmEnv,
} from './nativeFcm';
import {
  STORY_BACKGROUND_STATUS_RESULT_KIND,
  type StoryBackgroundStatus,
} from '../../../utils/storyBackgroundStatus';

interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface StoryStatusPushEnv extends NativeFcmEnv {
  AMSG_MASTER_KEY: string;
  VAPID_EMAIL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  DB: NativeFcmEnv['DB'] & {
    prepare(sql: string): D1PreparedLike;
  };
}

export interface StoryStatusPushJob {
  jobId: string;
  userId: string;
  clientRequestId: string;
  ownerKey: string;
  title: string;
}

export const storyBackgroundStatusMessageId = (clientRequestId: string): string =>
  `story_${clientRequestId}`;

const notificationBody = (
  status: StoryBackgroundStatus,
  title: string,
  error?: string,
): string => {
  const label = title.trim() || '剧情';
  if (status === 'running') return `《${label}》正在后台生成`;
  if (status === 'succeeded') return `《${label}》剧情已生成完成，点开即可查看`;
  if (status === 'cancelled') return `《${label}》后台生成已取消`;
  const detail = String(error || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  return detail
    ? `《${label}》后台生成失败：${detail}`
    : `《${label}》后台生成失败，点开可重试`;
};

/**
 * 直接复用主动消息已经登记的 push subscription。
 * best-effort：通知发不出去绝不能反过来改变剧情任务的成功/失败。
 */
export const sendStoryBackgroundStatusPush = async (
  env: StoryStatusPushEnv,
  job: StoryStatusPushJob,
  status: StoryBackgroundStatus,
  error?: string,
): Promise<void> => {
  if (!env.AMSG_MASTER_KEY?.trim()) return;
  try {
    const row = await env.DB.prepare(
      'SELECT user_id, subscription FROM push_subscriptions WHERE user_id = ? LIMIT 1',
    ).bind(job.userId).first<{ user_id?: unknown; subscription?: unknown }>();
    const stored = row?.subscription;
    const userId = row?.user_id;
    if (typeof stored !== 'string' || !stored || typeof userId !== 'string' || !userId) return;

    let subscription: unknown;
    try {
      const userKey = await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY);
      subscription = JSON.parse(await decryptFromStorage(stored, userKey));
    } catch {
      // 个别老部署曾把 subscription 明文存进 D1，保持即时错误通知同样的兼容兜底。
      subscription = JSON.parse(stored);
    }

    const nativeReady = isFcmConfigured(env);
    const vapid = {
      email: env.VAPID_EMAIL?.trim() || 'mailto:noreply@sullyos.app',
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    };
    const effectiveVapid = nativeReady && (!vapid.publicKey?.trim() || !vapid.privateKey?.trim())
      ? { email: vapid.email, publicKey: 'native-fcm', privateKey: 'native-fcm' }
      : vapid;
    const transport = createHybridPushTransport(
      env,
      createWebCryptoWebPush(effectiveVapid),
    );

    const body = notificationBody(status, job.title, error);
    const messageId = storyBackgroundStatusMessageId(job.clientRequestId);
    const payload = {
      messageKind: 'result',
      resultKind: STORY_BACKGROUND_STATUS_RESULT_KIND,
      messageType: 'story-background',
      messageId,
      contactName: '剧情剧场',
      message: body,
      timestamp: new Date().toISOString(),
      storyStatus: status,
      storyJobId: job.jobId,
      storyClientRequestId: job.clientRequestId,
      storyOwnerKey: job.ownerKey,
      storyTitle: job.title,
      ...(error ? { error: String(error).slice(0, 500) } : {}),
      metadata: {
        amsgStoryBackgroundStatus: true,
        storyStatus: status,
        storyJobId: job.jobId,
        storyClientRequestId: job.clientRequestId,
        storyOwnerKey: job.ownerKey,
        storyTitle: job.title,
      },
      notification: {
        title: '剧情剧场',
        body,
        show: 'always',
        // running 只是状态牌，不叫人；终态一定重新提醒一次。
        silent: status === 'running',
        tag: `story:${job.ownerKey}`,
        renotify: status !== 'running',
      },
    };
    await transport.sendNotification(subscription, JSON.stringify(payload));
  } catch (pushError) {
    console.warn('[amsg:story-job] 剧情后台状态通知发送失败（剧情任务本身不受影响）', {
      jobId: job.jobId,
      status,
      error: String((pushError as Error)?.message || pushError).slice(0, 500),
    });
  }
};
