import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareStoryReferenceUploads, snapshotStoryReference } from './storyImageReferenceUploads';
import { normalizeStoryImageHandoffSpec, runStoryImageHandoff } from '../worker/amsg/src/storyImageHandoff';
import type { StoryCloudImageHandoffSpec } from './storyTheaterImage';

vi.mock('./blobRef', () => ({
    getBlobForRef: vi.fn(async () => new Blob(['new image'])),
    blobToDataUrl: vi.fn(async (blob: Blob) => `data:image/png;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`),
}));

const slot = 'a'.repeat(64);
const sha = 'b'.repeat(64);
const spec = (): StoryCloudImageHandoffSpec => ({ version: 1, referenceSources: { [slot]: btoa('new image') }, tools: [{
    exposedName: 'image_novelai', toolName: 'novelai_generate_image', engineId: 'novelai',
    controlBaseUrl: 'https://image.example.test', token: 'selected-tenant',
    references: { actors: { actor: { reference_id: slot } } },
    referenceUploads: [{ slotId: slot, sha256: sha }],
}] });

afterEach(() => vi.restoreAllMocks());

describe('story reference upload handoff', () => {
    it('snapshots local image bytes without network before native handoff', async () => {
        const fetcher = vi.spyOn(globalThis, 'fetch');
        const result = await snapshotStoryReference({ slotId: slot, imageRef: 'blobref:local', imageSha256: sha });
        expect(atob(result.base64)).toBe('new image');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([404, 200])('uploads new/replaced content when HEAD returns %s', async status => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            requests.push({ url: String(url), init });
            return init?.method === 'HEAD'
                ? new Response(null, { status, headers: { 'X-Reference-Sha256': 'old-image' } })
                : new Response(null, { status: 204 });
        });
        const input = spec();
        const prepared = await prepareStoryReferenceUploads(input);
        expect(requests.map(r => r.init?.method)).toEqual(['HEAD', 'PUT']);
        expect(requests[1].url).toBe(`https://image.example.test/references/${slot}`);
        expect(new Headers(requests[1].init?.headers).get('Authorization')).toBe('Bearer selected-tenant');
        expect(new TextDecoder().decode(requests[1].init?.body as Uint8Array)).toBe('new image');
        expect(prepared.tools[0].referenceUploads).toBeUndefined();
        expect(JSON.stringify(prepared)).not.toContain(btoa('new image'));
        expect(input.tools[0].referenceUploads).toHaveLength(1); // native failure fallback still has its bytes
    });

    it('skips PUT when the selected server already has this image', async () => {
        const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { headers: { 'X-Reference-Sha256': sha } }));
        await prepareStoryReferenceUploads(spec());
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('keeps the story spec but prevents using an old selected image after upload failure', async () => {
        const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
        const prepared = await prepareStoryReferenceUploads(spec());
        expect(prepared.tools[0].referenceUploads).toBeUndefined();
        const cloud = normalizeStoryImageHandoffSpec(prepared)!;
        expect(cloud.tools[0].referenceErrors?.[slot]).toContain('503');
        fetcher.mockClear();
        const result = await runStoryImageHandoff(cloud, 'story_test_request', '<story_image_plan>{"tool":"image_novelai","arguments":{"prompt":"portrait"}}</story_image_plan>');
        expect(result.state).toBe('failed');
        expect(result.error).toContain('参考图同步失败');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not fail a picture that explicitly declines the failed reference', async () => {
        const input = spec();
        input.tools[0].referenceErrors = { [slot]: 'upload failed' };
        const fetcher = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response(null, { status: 404 }))
            .mockResolvedValueOnce(Response.json({ job: { id: 'image-job' } }));
        const cloud = normalizeStoryImageHandoffSpec(input)!;
        const result = await runStoryImageHandoff(cloud, 'story_test_request', '<story_image_plan>{"tool":"image_novelai","arguments":{"prompt":"landscape","use_character_reference":false}}</story_image_plan>');
        expect(result.state).toBe('submitted');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
