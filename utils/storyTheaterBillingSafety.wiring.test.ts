import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const storySource = read('../components/date/story/StoryTheaterSession.tsx');
const editorSource = read('../components/date/story/StoryTheaterEditor.tsx');
const osContextSource = read('../context/OSContext.tsx');
const nativeStoryInstallerSource = read('../scripts/install-android-story-background.mjs');
const nativeStoryPluginSource = read('../native/android/SullyStoryBackgroundPlugin.java');
const nativeStoryManagerSource = read('../native/android/SullyStoryGenerationManager.java');
const nativeStoryKeepAliveSource = read('../native/android/SullyStoryKeepAliveService.java');
const nativeStoryBridgeSource = read('./nativeStoryBackground.ts');

const sliceBetween = (source: string, startAnchor: string, endAnchor: string): string => {
    const start = source.indexOf(startAnchor);
    const end = source.indexOf(endAnchor, start + startAnchor.length);
    if (start < 0 || end <= start) throw new Error(`missing source anchors: ${startAnchor} -> ${endAnchor}`);
    return source.slice(start, end);
};

describe('story theater billing safety wiring', () => {
    it('uses a synchronous mutex instead of React state as the send guard', () => {
        const sendSource = sliceBetween(storySource, 'const send = useCallback', 'const archivedCount =');
        const guard = sendSource.indexOf('if (sendLock.current || actors.length === 0) return;');
        const acquire = sendSource.indexOf('sendLock.current = true;');
        const release = sendSource.indexOf('sendLock.current = false;');

        expect(storySource).toContain('const sendLock = useRef(false);');
        expect(guard).toBeGreaterThanOrEqual(0);
        expect(acquire).toBeGreaterThan(guard);
        expect(release).toBeGreaterThan(acquire);
        expect(sendSource).not.toContain('if (sending ||');
    });

    it('does not silently replay browser chat completion requests', () => {
        const interceptorSource = sliceBetween(osContextSource, 'const patchedFetch = async', 'window.fetch = patchedFetch;');
        expect(interceptorSource.match(/await originalFetch\(/g) || []).toHaveLength(1);
        expect(interceptorSource).toContain('await originalFetch(...sendArgs)');
        expect(interceptorSource).not.toContain('回退原请求重发');
    });

    it('owns Android story generation in an app-process manager and keeps the FGS transport-free', () => {
        expect(storySource).toContain('executeStoryCompletionInNativeBackground');
        expect(storySource).toContain('getPendingNativeStoryJob');
        expect(nativeStoryBridgeSource).toContain('NativeStoryBackground.submit');
        expect(nativeStoryPluginSource).toContain('SullyStoryGenerationManager.get(getContext()).submit');
        expect(nativeStoryManagerSource).toContain('public final class SullyStoryGenerationManager');
        expect(nativeStoryManagerSource).not.toContain('extends Service');
        expect(nativeStoryKeepAliveSource).toContain('extends Service');
        expect(nativeStoryKeepAliveSource).not.toContain('OkHttpClient');
        expect(nativeStoryKeepAliveSource).not.toContain('EventSource');
        expect(nativeStoryKeepAliveSource).not.toContain('Request.Builder');
        expect(nativeStoryInstallerSource).toContain('SullyStoryGenerationManager.java');
        expect(nativeStoryInstallerSource).toContain("await rm(path.join(pluginDir, 'SullyStoryBackgroundService.java')");
    });

    it('matches RikkaHub OkHttp and EventSource lifecycle defaults', () => {
        expect(nativeStoryManagerSource).toContain('.connectTimeout(20L, TimeUnit.SECONDS)');
        expect(nativeStoryManagerSource).toContain('.readTimeout(10L, TimeUnit.MINUTES)');
        expect(nativeStoryManagerSource).toContain('.writeTimeout(120L, TimeUnit.SECONDS)');
        expect(nativeStoryManagerSource).toContain('.followSslRedirects(true)');
        expect(nativeStoryManagerSource).toContain('.followRedirects(true)');
        expect(nativeStoryManagerSource).toContain('.retryOnConnectionFailure(true)');
        expect(nativeStoryInstallerSource).toContain('okhttp-bom:5.1.0');
        expect(nativeStoryInstallerSource).toContain('implementation "com.squareup.okhttp3:okhttp"');
        expect(nativeStoryInstallerSource).toContain('implementation "com.squareup.okhttp3:okhttp-sse"');
        expect(nativeStoryInstallerSource).not.toContain('okhttp-jvm:5.5.0');
        expect(nativeStoryInstallerSource).not.toContain('okhttp-sse:5.5.0');
        expect(nativeStoryManagerSource).toContain('EventSources.createFactory(client).newEventSource');
        expect(nativeStoryManagerSource).toContain('activeSources.put(jobId, source)');
        expect(nativeStoryManagerSource).toContain('source.cancel()');
        expect(nativeStoryManagerSource).toContain('.eventListenerFactory(');
        expect(nativeStoryManagerSource).toContain('.header("Accept-Language", Locale.getDefault().toLanguageTag())');
        expect(nativeStoryManagerSource).toContain('.header("User-Agent", "SullyOS-Android")');
        expect(nativeStoryManagerSource).toContain('class StoryNetworkEventListener extends EventListener');
        expect(nativeStoryManagerSource).toContain('callStart(Call call');
        expect(nativeStoryManagerSource).toContain('dnsStart(Call call');
        expect(nativeStoryManagerSource).toContain('connectFailed(');
        expect(nativeStoryManagerSource).toContain('requestBodyEnd(Call call, long byteCount)');
        expect(nativeStoryManagerSource).toContain('responseHeadersEnd(Call call, Response response)');
        expect(nativeStoryManagerSource).toContain('callFailed(Call call, IOException ioe)');
        expect(nativeStoryManagerSource).toContain('"tlsVersion"');
        expect(nativeStoryManagerSource).toContain('"cipherSuite"');
        expect(nativeStoryManagerSource).toContain('"callFailureCauseClass"');
        expect(nativeStoryManagerSource).toContain('int statusCode = 0;');
        expect(nativeStoryManagerSource).not.toContain('int statusCode = 200;');
    });

    it('acquires foreground lifetime before launching generation and releases it in finally', () => {
        const submitIndex = nativeStoryManagerSource.indexOf('SullyStoryKeepAliveService.acquire');
        const startIndex = nativeStoryManagerSource.indexOf('start(jobId, foregroundStarted)');
        expect(submitIndex).toBeGreaterThanOrEqual(0);
        expect(startIndex).toBeGreaterThan(submitIndex);
        expect(nativeStoryManagerSource).toContain('if (foregroundStarted) releaseForeground(jobId);');
        expect(nativeStoryKeepAliveSource).toContain('return START_NOT_STICKY;');
        expect(nativeStoryKeepAliveSource).toContain('sully_story_notification');
        expect(nativeStoryKeepAliveSource).toContain('fgsForegroundStarted');
        expect(nativeStoryKeepAliveSource).toContain('fgsForegroundFailed');
        expect(nativeStoryInstallerSource).toContain("sully_story_notification.xml");
        expect(nativeStoryInstallerSource).toContain('android.permission.ACCESS_NETWORK_STATE');
        expect(nativeStoryInstallerSource).toContain('android.permission.WAKE_LOCK');
        expect(nativeStoryKeepAliveSource).toContain('PowerManager.PARTIAL_WAKE_LOCK');
        expect(nativeStoryKeepAliveSource).toContain('WAKE_LOCK_TIMEOUT_MS');
        expect(nativeStoryKeepAliveSource).toContain('wakeLockAcquired');
    });

    it('records the last real stream activity instead of only the eventual failure time', () => {
        for (const key of [
            'lastChunkAt',
            'lastReasoningAt',
            'lastVisibleAt',
            'lastActivityAt',
            'chunkCount',
        ]) {
            expect(nativeStoryManagerSource).toContain(key);
            expect(nativeStoryBridgeSource).toContain(key);
        }
        expect(nativeStoryBridgeSource).toContain('lastChunkMs');
        expect(nativeStoryBridgeSource).toContain('lastReasoningMs');
        expect(nativeStoryBridgeSource).toContain('lastVisibleMs');
        expect(nativeStoryBridgeSource).toContain('lastActivityMs');
        expect(nativeStoryBridgeSource).toContain('dnsStartMs');
        expect(nativeStoryBridgeSource).toContain('connectFailedMs');
        expect(nativeStoryBridgeSource).toContain('callStartMs');
        expect(nativeStoryBridgeSource).toContain('callFailureCauseClass');
        expect(nativeStoryBridgeSource).toContain('tlsVersion');
        expect(nativeStoryBridgeSource).toContain('requestBodyEndMs');
        expect(nativeStoryBridgeSource).toContain('responseHeadersEndMs');
        expect(nativeStoryBridgeSource).toContain('callFailedMs');
        expect(nativeStoryBridgeSource).toContain('networkEvents');
        expect(nativeStoryBridgeSource).toContain('foregroundStartedMs');
        expect(nativeStoryBridgeSource).toContain('foregroundFailedMs');
        expect(nativeStoryBridgeSource).toContain('foregroundDestroyedMs');
        expect(nativeStoryBridgeSource).toContain('appPausedMs');
        expect(nativeStoryBridgeSource).toContain('appStoppedMs');
        expect(nativeStoryBridgeSource).toContain('networkSnapshotMs');
        expect(nativeStoryBridgeSource).toContain('networkLostMs');
        expect(nativeStoryBridgeSource).toContain('networkCapabilitiesChangedMs');
        expect(nativeStoryBridgeSource).toContain('networkValidated');
        expect(nativeStoryBridgeSource).toContain('connectivityObserverRegistered');
        expect(nativeStoryBridgeSource).toContain('wakeLockAcquiredMs');
        expect(nativeStoryBridgeSource).toContain('networkBlockedMs');
        expect(nativeStoryBridgeSource).toContain('backgroundRestricted');
        expect(nativeStoryBridgeSource).toContain('ignoringBatteryOptimizations');
        expect(nativeStoryManagerSource).toContain('registerDefaultNetworkCallback');
        expect(nativeStoryManagerSource).toContain('networkCapabilitiesChanged');
        expect(nativeStoryManagerSource).toContain('onBlockedStatusChanged');
        expect(nativeStoryManagerSource).toContain('isBackgroundRestricted');
        expect(nativeStoryManagerSource).toContain('isIgnoringBatteryOptimizations');
        expect(nativeStoryManagerSource).toContain('onActivityPaused(Activity activity)');
        expect(nativeStoryManagerSource).toContain('onActivityStopped(Activity activity)');
        expect(nativeStoryManagerSource).toContain('mergeLatestRuntimeDiagnostics(context, job);');
        expect(nativeStoryManagerSource).toContain('RUNTIME_DIAGNOSTIC_KEYS');
    });

    it('clears only the JS pending pointer and never deletes a native job another observer may still be polling', () => {
        const clearStart = nativeStoryBridgeSource.indexOf('export const clearPendingNativeStoryJob');
        const clearEnd = nativeStoryBridgeSource.indexOf('export const getPendingNativeStoryJob', clearStart);
        const clearSource = nativeStoryBridgeSource.slice(clearStart, clearEnd);
        expect(clearSource).toContain('delete map[ownerKey]');
        expect(clearSource).toContain('writePending(map)');
        expect(clearSource).not.toContain('NativeStoryBackground.remove');
        expect(nativeStoryManagerSource).toContain('private static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;');
        expect(nativeStoryManagerSource).toContain('if (terminal && job.optLong("updatedAt", 0L) < cutoff) file.delete();');
    });

    it('preserves native partial content after the app process is restarted', () => {
        const sendCatch = storySource.slice(
            storySource.indexOf('const returnedPartial ='),
            storySource.indexOf('const message = String(error?.message || error)', storySource.indexOf('const returnedPartial =')),
        );
        expect(sendCatch).toContain('error?.partialContent');
        expect(sendCatch).toContain('saveCentralAndMirrors');
        expect(sendCatch).toContain('theaterInterrupted: true');
    });

    it('uses the independent story route scope instead of the main chat route', () => {
        expect(storySource).toContain("resolveApiExecutionPlan('story', apiConfig, true)");
        expect(storySource).not.toContain("resolveApiExecutionPlan('chat', apiConfig, true)");
    });

    it('labels story requests and preserves sampling and transport diagnostics', () => {
        const interceptorSource = sliceBetween(osContextSource, 'const patchedFetch = async', 'window.fetch = patchedFetch;');

        expect(storySource).toContain("purpose: '剧情续写'");
        expect(storySource).toContain('prepareStoryGenerationSettings(settings, entry.omitSamplingParams === true)');
        expect(editorSource).toContain("value={draft.omitSamplingParams === true}");
        expect(editorSource).toContain("update('omitSamplingParams', value)");
        expect(editorSource).toContain('默认关闭');
        expect(storySource).toContain('剧情请求被上游/网关断开');
        expect(storySource).toContain("transport: useNativeEventSourceTransport ? 'native-eventsource' : 'webview-fetch'");
        expect(interceptorSource).toContain('recentSuccessfulFetches.set(requestComparisonKey');
        expect(interceptorSource).toContain('summarizeFetchRequestBody((sendArgs[1] as any)?.body)');
        expect(interceptorSource).toContain('recentSuccessfulSameRequest: recentSuccess');
    });
});
