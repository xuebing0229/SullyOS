import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Android native push release wiring', () => {
  it('APK 构建打开无需 Google 的原生轮询通道', () => {
    const workflow = readFileSync(resolve(__dirname, '../.github/workflows/build-apk.yml'), 'utf8');
    expect(workflow).toContain("VITE_AMSG_NATIVE_PUSH: 'poll'");
    expect(workflow).not.toContain('ANDROID_GOOGLE_SERVICES_JSON_BASE64');
    expect(workflow).not.toContain('google-services.json');
  });

  it('Capacitor 同步时安装前台轮询服务', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts['capacitor:sync:after']).toContain('install-android-amsg-poll.mjs');
    const installer = readFileSync(resolve(__dirname, './install-android-amsg-poll.mjs'), 'utf8');
    expect(installer).toContain('FOREGROUND_SERVICE_DATA_SYNC');
    expect(installer).toContain('SullyAmsgPollService');
  });

  it('轮询构建从设置按钮一路接到 Worker 收件箱，不再误走 UnifiedPush', () => {
    const client = readFileSync(resolve(__dirname, '../utils/activeMsgClient.ts'), 'utf8');
    const unified = readFileSync(resolve(__dirname, '../utils/unifiedPushPlugin.ts'), 'utf8');
    const worker = readFileSync(resolve(__dirname, '../worker/amsg/src/index.ts'), 'utf8');
    expect(client).toContain("VITE_AMSG_NATIVE_PUSH === 'poll'");
    expect(client).toContain('endpoint: `poll:${token}`');
    expect(unified).toContain("VITE_AMSG_NATIVE_PUSH === 'true'");
    expect(worker).toContain("pathname.endsWith('/native-poll')");
  });
});
