import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { PushNotifications, type Token } from '@capacitor/push-notifications';

export const NATIVE_PUSH_TOKEN_STORAGE_KEY = 'amsg2_fcm_token_v1';

export const isNativeAmsgPushRuntime = (): boolean =>
  import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true' && Capacitor.isNativePlatform();

export const readNativeAmsgPushToken = (): string => {
  if (!isNativeAmsgPushRuntime() || typeof localStorage === 'undefined') return '';
  return localStorage.getItem(NATIVE_PUSH_TOKEN_STORAGE_KEY)?.trim() || '';
};

const rememberToken = (token: Token): string => {
  const value = token.value?.trim() || '';
  if (value && typeof localStorage !== 'undefined') {
    localStorage.setItem(NATIVE_PUSH_TOKEN_STORAGE_KEY, value);
  }
  return value;
};

export interface NativeAmsgPushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  hasToken: boolean;
  detail?: string;
}

export const getNativeAmsgPushStatus = async (): Promise<NativeAmsgPushStatus> => {
  if (!isNativeAmsgPushRuntime()) {
    return { supported: false, permission: 'unsupported', hasToken: false };
  }
  const permission = await PushNotifications.checkPermissions();
  const mapped: NotificationPermission = permission.receive === 'granted'
    ? 'granted'
    : permission.receive === 'denied'
      ? 'denied'
      : 'default';
  const hasToken = Boolean(readNativeAmsgPushToken());
  return {
    supported: true,
    permission: mapped,
    hasToken,
    detail: hasToken
      ? '原生 Android 推送已登记。'
      : mapped === 'denied'
        ? '系统通知权限已被拒绝，请到手机系统设置里允许 SullyOS 通知。'
        : '使用 Android 原生推送，不依赖 WebView 的 Push API。',
  };
};

/**
 * 主动请求系统权限并拿到 FCM registration token。
 *
 * `register()` 自身只负责启动注册，结果从 registration / registrationError 事件回来，
 * 所以这里把两条事件收束成一个有超时的 Promise，供设置页的按钮直接等待。
 */
export const ensureNativeAmsgPushToken = async (timeoutMs = 20_000): Promise<string> => {
  if (!isNativeAmsgPushRuntime()) throw new Error('当前不是已启用原生推送的 Android App。');

  const current = await PushNotifications.checkPermissions();
  const permission = current.receive === 'prompt'
    ? await PushNotifications.requestPermissions()
    : current;
  if (permission.receive !== 'granted') {
    throw new Error('通知权限未授予，请到手机系统设置里允许 SullyOS 通知。');
  }

  const existing = readNativeAmsgPushToken();
  if (existing) return existing;

  let registrationHandle: PluginListenerHandle | undefined;
  let errorHandle: PluginListenerHandle | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let resolveToken!: (value: string) => void;
    let rejectToken!: (reason: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });
    const settle = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      fn();
    };
    registrationHandle = await PushNotifications.addListener('registration', (token) => {
      const value = rememberToken(token);
      settle(() => value ? resolveToken(value) : rejectToken(new Error('FCM 返回了空的设备令牌。')));
    });
    errorHandle = await PushNotifications.addListener('registrationError', (error) => {
      settle(() => rejectToken(new Error(`原生推送注册失败：${error?.error || '未知错误'}`)));
    });
    timer = setTimeout(
      () => rejectToken(new Error('原生推送注册超时，请确认手机可以连接 Google 推送服务后重试。')),
      timeoutMs,
    );
    try {
      await PushNotifications.register();
    } catch (error: any) {
      settle(() => rejectToken(new Error(`原生推送注册失败：${error?.message || error}`)));
    }
    return await result;
  } finally {
    if (timer) clearTimeout(timer);
    await registrationHandle?.remove().catch(() => undefined);
    await errorHandle?.remove().catch(() => undefined);
  }
};
