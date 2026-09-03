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
const nativeStoryServiceSource = read('../native/android/SullyStoryBackgroundService.java');
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

    it('does not silently issue a second physical chat completion request', () => {
        const interceptorSource = sliceBetween(osContextSource, 'const patchedFetch = async', 'window.fetch = patchedFetch;');

        expect(interceptorSource.match(/await originalFetch\(/g) || []).toHaveLength(1);
        expect(interceptorSource).toContain('await originalFetch(...sendArgs)');
        expect(interceptorSource).not.toContain('回退原请求重发');
    });

    it('uses a native foreground EventSource for Android story completions', () => {
        expect(storySource).toContain('executeStoryCompletionInNativeBackground');
        expect(storySource).toContain("transport: useNativeEventSourceTransport ? 'native-eventsource' : 'webview-fetch'");
        expect(storySource).toContain('getPendingNativeStoryJob');
        expect(nativeStoryBridgeSource).toContain('NativeStoryBackground.submit');
        expect(nativeStoryBridgeSource).toContain('stream: true');
        expect(nativeStoryPluginSource).toContain('void submit(');
        expect(nativeStoryPluginSource).toContain('void status(');
        expect(nativeStoryPluginSource).toContain('void remove(');
    });

    it('delegates SSE framing to okhttp-sse instead of a hand-written line parser', () => {
        expect(nativeStoryInstallerSource).toContain('com.squareup.okhttp3:okhttp-sse:4.12.0');
        expect(nativeStoryServiceSource).toContain('EventSources.createFactory');
        expect(nativeStoryServiceSource).toContain('EventSourceListener');
        expect(nativeStoryServiceSource).toContain('.readTimeout(0L, TimeUnit.MILLISECONDS)');
        expect(nativeStoryServiceSource).toContain('.retryOnConnectionFailure(false)');
        expect(nativeStoryServiceSource).not.toContain('readUtf8Line');
        expect(nativeStoryServiceSource).not.toContain('BufferedSource');
        expect(nativeStoryServiceSource).not.toContain('HttpURLConnection');
        expect(nativeStoryServiceSource).not.toContain('Protocol.HTTP_1_1');
    });

    it('uses the independent story route scope instead of the main chat route', () => {
        expect(storySource).toContain("resolveApiExecutionPlan('story', apiConfig, true)");
        expect(storySource).not.toContain("resolveApiExecutionPlan('chat', apiConfig, true)");
    });

    it('labels story requests and wires same-endpoint evidence into CORS diagnostics', () => {
        const interceptorSource = sliceBetween(osContextSource, 'const patchedFetch = async', 'window.fetch = patchedFetch;');

        expect(storySource).toContain("purpose: '剧情续写'");
        expect(storySource).toContain('prepareStoryGenerationSettings(settings, entry.omitSamplingParams === true)');
        expect(editorSource).toContain("value={draft.omitSamplingParams === true}");
        expect(editorSource).toContain("update('omitSamplingParams', value)");
        expect(editorSource).toContain('默认关闭');
        expect(storySource).toContain('剧情请求被上游/网关断开');
        expect(interceptorSource).toContain('recentSuccessfulFetches.set(requestComparisonKey');
        expect(interceptorSource).toContain('summarizeFetchRequestBody((sendArgs[1] as any)?.body)');
        expect(interceptorSource).toContain('recentSuccessfulSameRequest: recentSuccess');
    });
});
