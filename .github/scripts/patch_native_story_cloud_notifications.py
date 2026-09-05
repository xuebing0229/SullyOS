from pathlib import Path

# 1) Capacitor bridge
p = Path('native/android/SullyStoryBackgroundPlugin.java')
s = p.read_text()
needle = '''    @PluginMethod\n    public void submit(PluginCall call) {\n'''
insert = '''    @PluginMethod\n    public void startCloudMonitor(PluginCall call) {\n        String jobId = call.getString("jobId", "").trim();\n        String title = call.getString("title", "剧情");\n        String workerUrl = call.getString("workerUrl", "").trim().replaceAll("/+$", "");\n        String userId = call.getString("userId", "").trim();\n        String serverToken = call.getString("serverToken", "");\n        if (!jobId.matches("[A-Za-z0-9_-]{12,160}")) {\n            call.reject("剧情云端监控 jobId 无效");\n            return;\n        }\n        if (!workerUrl.startsWith("https://") || userId.isEmpty()) {\n            call.reject("剧情云端监控 Worker 配置无效");\n            return;\n        }\n        if (SullyStoryCloudMonitorService.start(getContext(), jobId, title, workerUrl, userId, serverToken)) {\n            call.resolve();\n        } else {\n            call.reject("无法启动剧情云端状态通知");\n        }\n    }\n\n    @PluginMethod\n    public void finishCloudMonitor(PluginCall call) {\n        String jobId = call.getString("jobId", "").trim();\n        String title = call.getString("title", "剧情");\n        String status = call.getString("status", "failed").trim();\n        String error = call.getString("error", "");\n        if (!jobId.matches("[A-Za-z0-9_-]{12,160}")) {\n            call.reject("剧情云端监控 jobId 无效");\n            return;\n        }\n        SullyStoryCloudMonitorService.finish(getContext(), jobId, title, status, error);\n        call.resolve();\n    }\n\n    @PluginMethod\n    public void submit(PluginCall call) {\n'''
assert needle in s
s = s.replace(needle, insert, 1)
p.write_text(s)

# 2) Android installer / manifest
p = Path('scripts/install-android-story-background.mjs')
s = p.read_text()
needle = "  'SullyStoryGenerationManager.java',\n  'SullyStoryKeepAliveService.java',\n"
replacement = "  'SullyStoryGenerationManager.java',\n  'SullyStoryKeepAliveService.java',\n  'SullyStoryCloudMonitorService.java',\n"
assert needle in s
s = s.replace(needle, replacement, 1)
needle = '''if (!manifest.includes('SullyStoryKeepAliveService')) {\n  manifest = manifest.replace('</application>', [\n    '        <service',\n    '            android:name=".plugins.SullyStoryKeepAliveService"',\n    '            android:exported="false"',\n    '            android:foregroundServiceType="dataSync" />',\n    '    </application>',\n  ].join('\\n'));\n}\nawait writeFile(manifestPath, manifest);\n'''
replacement = '''if (!manifest.includes('SullyStoryKeepAliveService')) {\n  manifest = manifest.replace('</application>', [\n    '        <service',\n    '            android:name=".plugins.SullyStoryKeepAliveService"',\n    '            android:exported="false"',\n    '            android:foregroundServiceType="dataSync" />',\n    '    </application>',\n  ].join('\\n'));\n}\nif (!manifest.includes('SullyStoryCloudMonitorService')) {\n  manifest = manifest.replace('</application>', [\n    '        <service',\n    '            android:name=".plugins.SullyStoryCloudMonitorService"',\n    '            android:exported="false"',\n    '            android:foregroundServiceType="dataSync" />',\n    '    </application>',\n  ].join('\\n'));\n}\nawait writeFile(manifestPath, manifest);\n'''
assert needle in s
s = s.replace(needle, replacement, 1)
s = s.replace(
    "console.log('[SullyStoryBackground] RikkaHub-style generation manager + foreground keepalive installed');",
    "console.log('[SullyStoryBackground] generation manager + keepalive + cloud status monitor installed');",
)
p.write_text(s)

# 3) TS native bridge + notification permission
p = Path('utils/nativeStoryBackground.ts')
s = p.read_text()
needle = "import { Capacitor, registerPlugin } from '@capacitor/core';\n"
replacement = "import { Capacitor, registerPlugin } from '@capacitor/core';\nimport { LocalNotifications } from '@capacitor/local-notifications';\n"
assert needle in s
s = s.replace(needle, replacement, 1)
needle = '''  acquireKeepAlive(options: { leaseId: string; title?: string }): Promise<void>;\n  releaseKeepAlive(options: { leaseId: string }): Promise<void>;\n}\n'''
replacement = '''  acquireKeepAlive(options: { leaseId: string; title?: string }): Promise<void>;\n  releaseKeepAlive(options: { leaseId: string }): Promise<void>;\n  startCloudMonitor(options: {\n    jobId: string;\n    title: string;\n    workerUrl: string;\n    userId: string;\n    serverToken?: string;\n  }): Promise<void>;\n  finishCloudMonitor(options: {\n    jobId: string;\n    title: string;\n    status: 'succeeded' | 'failed' | 'cancelled';\n    error?: string;\n  }): Promise<void>;\n}\n'''
assert needle in s
s = s.replace(needle, replacement, 1)
needle = '''export const isNativeStoryBackgroundRuntime = (): boolean =>\n  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';\n\nconst makeKeepAliveLeaseId = (ownerKey: string): string => {\n'''
replacement = '''export const isNativeStoryBackgroundRuntime = (): boolean =>\n  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';\n\nexport interface NativeCloudStoryMonitorOptions {\n  jobId: string;\n  title: string;\n  workerUrl: string;\n  userId: string;\n  serverToken?: string;\n}\n\nconst ensureStoryNotificationPermission = async (): Promise<boolean> => {\n  if (!isNativeStoryBackgroundRuntime()) return false;\n  const current = await LocalNotifications.checkPermissions();\n  const resolved = current.display === 'prompt'\n    ? await LocalNotifications.requestPermissions()\n    : current;\n  return resolved.display === 'granted';\n};\n\n/**\n * 云端 Story Jobs 的系统状态牌。与主动消息 push 完全独立：Android 自己轮询同一个 job。\n */\nexport const startNativeCloudStoryMonitor = async (\n  options: NativeCloudStoryMonitorOptions,\n): Promise<boolean> => {\n  if (!isNativeStoryBackgroundRuntime()) return false;\n  const granted = await ensureStoryNotificationPermission();\n  if (!granted) {\n    console.warn('[StoryTheater] 系统通知权限未授予，剧情后台状态牌无法显示');\n    return false;\n  }\n  await NativeStoryBackground.startCloudMonitor(options);\n  return true;\n};\n\nexport const finishNativeCloudStoryMonitor = async (options: {\n  jobId: string;\n  title: string;\n  status: 'succeeded' | 'failed' | 'cancelled';\n  error?: string;\n}): Promise<void> => {\n  if (!isNativeStoryBackgroundRuntime()) return;\n  await NativeStoryBackground.finishCloudMonitor(options);\n};\n\nconst makeKeepAliveLeaseId = (ownerKey: string): string => {\n'''
assert needle in s
s = s.replace(needle, replacement, 1)
p.write_text(s)

# 4) Cloud Story client starts the Android monitor once the remote job is known.
p = Path('utils/backgroundStoryJobs.ts')
s = p.read_text()
needle = "import { ActiveMsgClient } from './activeMsgClient';\n"
replacement = "import { ActiveMsgClient } from './activeMsgClient';\nimport { finishNativeCloudStoryMonitor, startNativeCloudStoryMonitor } from './nativeStoryBackground';\n"
assert needle in s
s = s.replace(needle, replacement, 1)
needle = '''    // 无论是刚提交还是进程重启后重新发现的 job，都用同一个 id 补上 API 调用记录。\n    // DB 按 id 合并；重复写不会产生第二笔费用记录。\n    if (job && firstRoute) {\n'''
replacement = '''    // 一旦 Worker 明确存在这条 job，就让 Android 自己接管系统状态牌。\n    // 这条链不依赖 WebView timer / 主动消息 push；切屏和锁屏后仍会轮询同一个远端 job。\n    if (job) {\n        try {\n            await startNativeCloudStoryMonitor({\n                jobId: pending.jobId,\n                title: pending.title,\n                workerUrl: config.workerUrl,\n                userId: config.userId,\n                serverToken: config.serverToken,\n            });\n        } catch (error) {\n            console.warn('[StoryTheater] native cloud story status monitor failed to start', error);\n        }\n    }\n\n    // 无论是刚提交还是进程重启后重新发现的 job，都用同一个 id 补上 API 调用记录。\n    // DB 按 id 合并；重复写不会产生第二笔费用记录。\n    if (job && firstRoute) {\n'''
assert needle in s
s = s.replace(needle, replacement, 1)
needle = '''            if (!job.response) {\n                throw toCloudError('剧情云端任务完成了，但没有保存响应正文', job, config, { terminal: true });\n            }\n            return job.response;\n'''
replacement = '''            if (!job.response) {\n                await finishNativeCloudStoryMonitor({\n                    jobId: pending.jobId,\n                    title: pending.title,\n                    status: 'failed',\n                    error: '剧情云端任务完成了，但没有保存响应正文',\n                }).catch(() => undefined);\n                throw toCloudError('剧情云端任务完成了，但没有保存响应正文', job, config, { terminal: true });\n            }\n            await finishNativeCloudStoryMonitor({\n                jobId: pending.jobId,\n                title: pending.title,\n                status: 'succeeded',\n            }).catch(() => undefined);\n            return job.response;\n'''
assert needle in s
s = s.replace(needle, replacement, 1)
needle = '''        if (job.status === 'failed' || job.status === 'cancelled') {\n            settleCloudApiCall({ id: logId, ok: false });\n            throw toCloudError(\n'''
replacement = '''        if (job.status === 'failed' || job.status === 'cancelled') {\n            settleCloudApiCall({ id: logId, ok: false });\n            await finishNativeCloudStoryMonitor({\n                jobId: pending.jobId,\n                title: pending.title,\n                status: job.status,\n                error: job.error,\n            }).catch(() => undefined);\n            throw toCloudError(\n'''
assert needle in s
s = s.replace(needle, replacement, 1)
p.write_text(s)

# 5) Wiring test and APK regression suite
p = Path('scripts/storyBackgroundStatusNotification.wiring.test.ts')
s = p.read_text()
needle = '''  it('status pushes are consumed as non-chat results and poll fallback updates by messageId', () => {\n'''
insert = '''  it('Android cloud Story monitor is independent from active-message push subscriptions', () => {\n    const client = read('utils/backgroundStoryJobs.ts');\n    const native = read('utils/nativeStoryBackground.ts');\n    const service = read('native/android/SullyStoryCloudMonitorService.java');\n    const installer = read('scripts/install-android-story-background.mjs');\n    expect(client).toContain('startNativeCloudStoryMonitor');\n    expect(native).toContain('LocalNotifications.requestPermissions()');\n    expect(service).toContain('/story-jobs/');\n    expect(service).toContain('startForeground');\n    expect(installer).toContain('SullyStoryCloudMonitorService.java');\n  });\n\n  it('status pushes are consumed as non-chat results and poll fallback updates by messageId', () => {\n'''
assert needle in s
s = s.replace(needle, insert, 1)
p.write_text(s)

p = Path('.github/workflows/build-apk.yml')
s = p.read_text()
needle = 'pnpm exec vitest run utils/safeApi.stream.test.ts utils/apiFailover.test.ts utils/storyTheaterBillingSafety.wiring.test.ts'
replacement = needle + ' scripts/storyBackgroundStatusNotification.wiring.test.ts'
assert needle in s
s = s.replace(needle, replacement, 1)
p.write_text(s)
