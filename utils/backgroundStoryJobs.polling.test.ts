import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    fileURLToPath(new URL('./backgroundStoryJobs.ts', import.meta.url)),
    'utf8',
);

const sliceBetween = (start: string, end: string): string => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to <= from) throw new Error(`missing anchors: ${start} -> ${end}`);
    return source.slice(from, to);
};

describe('cloud story status polling lifecycle', () => {
    it('keeps model submission on the original request path', () => {
        expect(source).toContain("fetchJson(config, '/story-jobs', {");
        expect(source).toContain("method: 'POST'");
        expect(source).toContain('为避免重复扣费，本轮不会自动重发');
    });

    it('uses the visibility-aware helper only for story status GETs', () => {
        const byId = sliceBetween('const getRemoteJobById', 'const getRemoteJobByClientId');
        const byClient = sliceBetween('const getRemoteJobByClientId', 'const sleepUntilPollOrVisible');
        expect(byId).toContain('fetchPollingJson(');
        expect(byClient).toContain('fetchPollingJson(');
        expect(source).toContain('await waitUntilDocumentVisible();');
        expect(source).toContain("document.visibilityState !== 'visible'");
    });

    it('pauses the local GET timeout while hidden instead of aborting anything remotely', () => {
        const pollFetch = sliceBetween('const fetchPollingJson', 'export const isCloudStoryJobsAvailable');
        const visibilityHandler = pollFetch.slice(
            pollFetch.indexOf('const onVisibility = () => {'),
            pollFetch.indexOf("if (typeof document !== 'undefined')", pollFetch.indexOf('const onVisibility = () => {')),
        );
        expect(visibilityHandler).toContain('else clearVisibleTimeout();');
        expect(visibilityHandler).not.toContain('controller.abort()');
        expect(pollFetch).toContain('timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);');
        expect(pollFetch).not.toContain('DELETE');
        expect(pollFetch).not.toContain('cancel');
    });
});
