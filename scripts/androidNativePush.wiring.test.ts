import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Android native push release wiring', () => {
  it('APK 构建默认打开无需 Google 的 UnifiedPush 通道', () => {
    const workflow = readFileSync(resolve(__dirname, '../.github/workflows/build-apk.yml'), 'utf8');
    expect(workflow).toContain("VITE_AMSG_NATIVE_PUSH: 'true'");
    expect(workflow).not.toContain('ANDROID_GOOGLE_SERVICES_JSON_BASE64');
    expect(workflow).not.toContain('google-services.json');
  });

  it('Capacitor 同步时安装 UnifiedPush，同时保留轮询备用实现', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts['capacitor:sync:after']).toContain('install-android-unified-push.mjs');
    expect(pkg.scripts['capacitor:sync:after']).toContain('install-android-amsg-poll.mjs');
    const unifiedInstaller = readFileSync(resolve(__dirname, './install-android-unified-push.mjs'), 'utf8');
    expect(unifiedInstaller).toContain('org.unifiedpush.android:connector:3.3.5');
    expect(unifiedInstaller).toContain('AmsgUnifiedPushService');
    const installer = readFileSync(resolve(__dirname, './install-android-amsg-poll.mjs'), 'utf8');
    expect(installer).toContain('FOREGROUND_SERVICE_DATA_SYNC');
    expect(installer).toContain('SullyAmsgPollService');
  });

  it('UnifiedPush 是发布默认，原生轮询仍可显式选为备用构建', () => {
    const client = readFileSync(resolve(__dirname, '../utils/activeMsgClient.ts'), 'utf8');
    const unified = readFileSync(resolve(__dirname, '../utils/unifiedPushPlugin.ts'), 'utf8');
    const worker = readFileSync(resolve(__dirname, '../worker/amsg/src/index.ts'), 'utf8');
    expect(client).toContain("VITE_AMSG_NATIVE_PUSH === 'poll'");
    expect(client).toContain('endpoint: `poll:${token}`');
    expect(unified).toContain("VITE_AMSG_NATIVE_PUSH === 'true'");
    expect(worker).toContain("pathname.endsWith('/native-poll')");
  });
});
