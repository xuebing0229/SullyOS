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
        expect(nativeStoryInstallerSource).not.toContain('SullyStoryBackgroundService.java\',\n');
    });

    it('matches RikkaHub OkHttp and EventSource lifecycle defaults', () => {
        expect(nativeStoryManagerSource).toContain('.connectTimeout(20L, TimeUnit.SECONDS)');
        expect(nativeStoryManagerSource).toContain('.readTimeout(10L, TimeUnit.MINUTES)');
        expect(nativeStoryManagerSource).toContain('.writeTimeout(120L, TimeUnit.SECONDS)');
        expect(nativeStoryManagerSource).toContain('.followSslRedirects(true)');
        expect(nativeStoryManagerSource).toContain('.followRedirects(true)');
        expect(nativeStoryManagerSource).toContain('.retryOnConnectionFailure(true)');
        expect(nativeStoryManagerSource).toContain('EventSources.createFactory(client).newEventSource');
        expect(nativeStoryManagerSource).toContain('activeSources.put(jobId, source)');
        expect(nativeStoryManagerSource).toContain('source.cancel()');
        expect(nativeStoryInstallerSource).toContain('com.squareup.okhttp3:okhttp-sse:4.12.0');
    });

    it('acquires foreground lifetime before launching generation and releases it in finally', () => {
        const submitIndex = nativeStoryManagerSource.indexOf('SullyStoryKeepAliveService.acquire');
        const startIndex = nativeStoryManagerSource.indexOf('start(jobId, foregroundStarted)');
        expect(submitIndex).toBeGreaterThanOrEqual(0);
        expect(startIndex).toBeGreaterThan(submitIndex);
        expect(nativeStoryManagerSource).toContain('if (foregroundStarted) releaseForeground(jobId);');
        expect(nativeStoryKeepAliveSource).toContain('return START_NOT_STICKY;');
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
