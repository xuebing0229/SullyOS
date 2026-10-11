import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DatabaseGuard from './components/DatabaseGuard';
import { openDB } from './utils/db';
import { checkDatabaseReadable } from './utils/databaseHealth';
import { installTranslateCrashGuard } from './utils/translateCrashGuard';
import { ActiveMsgRuntime } from './utils/activeMsgRuntime';
import { KeepAlive } from './utils/keepAlive';
import { ProactiveChat } from './utils/proactiveChat';
import { VRScheduler } from './utils/vrWorld/scheduler';
import { installIOSStandaloneWorkaround } from './utils/iosStandalone';
import { installWakeListener } from './utils/proactivePushConfig';

import { installStoryPollingVisibilityGuard } from './utils/storyPollingVisibilityGuard';
import { Capacitor } from '@capacitor/core';
import { isChunkLoadError, refreshDocumentForInstalledAppVersion, tryAutoReloadForChunkError } from './utils/chunkLoadRecovery';
import { APP_RELEASE_VERSION } from './utils/buildInfo';

const refreshingAfterAndroidUpdate = Capacitor.isNativePlatform()
  && Capacitor.getPlatform() === 'android'
  && refreshDocumentForInstalledAppVersion(APP_RELEASE_VERSION);

if (!refreshingAfterAndroidUpdate) {
  // 动态 chunk 也可能在 React ErrorBoundary 之外失败（例如顶层 import() / preload）。
// 更新 APK 后若 WebView 还拿着旧 index.html，这类失败必须先绕过文档缓存再重载。
if (typeof window !== 'undefined') {
  const recoverChunkFailure = (error: unknown) => {
    if (!isChunkLoadError(error)) return;
    void tryAutoReloadForChunkError();
  };
  window.addEventListener('unhandledrejection', event => {
    if (!isChunkLoadError(event.reason)) return;
    if (tryAutoReloadForChunkError()) event.preventDefault();
  });
  window.addEventListener('error', event => {
    recoverChunkFailure(event.error || event.message);
  });
}

// Android WebView 退到后台后不再自己轮询 story-jobs；原生 monitor 继续盯任务，
// 回前台时 JS 立即接回同一个 job，避免后台冻结被误判成网络/SYSTEM ERROR。
installStoryPollingVisibilityGuard();

// 普通网页不加载原生推送插件；只有显式开启的 Capacitor 构建才初始化。
const nativePushMode = import.meta.env.VITE_AMSG_NATIVE_PUSH;
if (Capacitor.isNativePlatform()) {
  if (nativePushMode === 'true' && Capacitor.getPlatform() === 'android') {
    void import('./utils/unifiedPushRuntime').then(({ initUnifiedPushRuntime }) => initUnifiedPushRuntime());
  } else if (nativePushMode === 'true' || nativePushMode === 'fcm') {
    void import('./utils/nativeAmsgPush').then(({ initNativeAmsgPush }) => initNativeAmsgPush());
  } else if (nativePushMode === 'poll') {
    void import('./utils/nativeAmsgPoll').then(({ initNativeAmsgPoll }) => initNativeAmsgPoll());
  }
}

// Finish opening/upgrading the archive before our SW registration starts update
// inspection, offline-shell preparation or cache cleanup. DatabaseGuard gates AI callers too.
checkDatabaseReadable(openDB).then(async () => {
  await KeepAlive.init();
  // Resume any active proactive schedule after SW is ready
  ProactiveChat.resume();
  // Resume 「彼方」 autonomous-login schedules
  VRScheduler.resume();
  void ActiveMsgRuntime.init();
  // Record every wake the SW reports so the diagnostic panel can show "last received".
  installWakeListener();
}).catch(error => console.error('后台任务暂未启动：本地数据或保活服务未就绪', error));

installIOSStandaloneWorkaround();

// 使用统计。构建时没配 VITE_UMAMI_* 就整个不生效，自部署实例默认如此。
// 用户关掉开关、或浏览器开了 DNT，同样在这里就返回，连脚本都不会挂上去。


// 浏览器自动翻译 (Chrome/Edge 等) 会改动 React 托管的 DOM，导致 reconcile 时
// insertBefore/removeChild 抛 NotFoundError 白屏。挂载前先打护栏。详见该 util 注释。
installTranslateCrashGuard();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <DatabaseGuard>{startupBoot => <App startupBoot={startupBoot} />}</DatabaseGuard>
  </React.StrictMode>
);
}
