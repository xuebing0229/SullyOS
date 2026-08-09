import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listeners, checkPermissions, requestPermissions, register } = vi.hoisted(() => ({
  listeners: new Map<string, (value: any) => void>(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  register: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions,
    requestPermissions,
    register,
    addListener: vi.fn(async (name: string, callback: (value: any) => void) => {
      listeners.set(name, callback);
      return { remove: vi.fn(async () => listeners.delete(name)) };
    }),
  },
}));

import {
  ensureNativeAmsgPushToken,
  getNativeAmsgPushStatus,
  NATIVE_PUSH_TOKEN_STORAGE_KEY,
} from './nativePushTransport';

describe('native AMSG push transport', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AMSG_NATIVE_PUSH', 'true');
    localStorage.clear();
    listeners.clear();
    checkPermissions.mockReset().mockResolvedValue({ receive: 'prompt' });
    requestPermissions.mockReset().mockResolvedValue({ receive: 'granted' });
    register.mockReset().mockImplementation(async () => {
      listeners.get('registration')?.({ value: 'fcm-device-token' });
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('由按钮申请系统权限并等待 FCM token', async () => {
    await expect(ensureNativeAmsgPushToken()).resolves.toBe('fcm-device-token');
    expect(requestPermissions).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(NATIVE_PUSH_TOKEN_STORAGE_KEY)).toBe('fcm-device-token');
  });

  it('状态页把原生 token 当成当前设备已订阅', async () => {
    localStorage.setItem(NATIVE_PUSH_TOKEN_STORAGE_KEY, 'saved-token');
    checkPermissions.mockResolvedValue({ receive: 'granted' });
    await expect(getNativeAmsgPushStatus()).resolves.toMatchObject({
      supported: true,
      permission: 'granted',
      hasToken: true,
    });
  });

  it('权限拒绝时给出能操作的错误', async () => {
    requestPermissions.mockResolvedValue({ receive: 'denied' });
    await expect(ensureNativeAmsgPushToken()).rejects.toThrow(/系统设置/);
    expect(register).not.toHaveBeenCalled();
  });
});
