import type { NovelAiPreciseReferenceConfig } from '../types';
import { blobToDataUrl, getBlobForRef } from './blobRef';
import type { StoryCloudImageHandoffSpec } from './storyTheaterImage';

/** Local/native submission attachment. Removed before the story spec goes to D1. */
export interface StoryReferenceUpload {
    slotId: string;
    sha256: string;
    base64: string;
}

export async function snapshotStoryReference(config: Pick<NovelAiPreciseReferenceConfig, 'imageRef' | 'imageSha256' | 'slotId'>): Promise<StoryReferenceUpload> {
    const blob = await getBlobForRef(config.imageRef);
    if (!blob) throw new Error('本机参考图已丢失，请重新选择');
    const dataUrl = await blobToDataUrl(blob);
    return {
        slotId: config.slotId,
        sha256: config.imageSha256 || '',
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    };
}

/** Browser fallback; Android performs the same uploads on its native submission thread. */
export async function prepareStoryReferenceUploads(spec: StoryCloudImageHandoffSpec): Promise<StoryCloudImageHandoffSpec> {
    const { referenceSources, ...cloudSpec } = spec;
    const tools = [];
    for (const source of spec.tools) {
        const { referenceUploads, ...tool } = source;
        const errors = { ...tool.referenceErrors };
        for (const upload of referenceUploads || []) {
            try {
                const url = `${tool.controlBaseUrl.replace(/\/+$/, '')}/references/${upload.slotId}`;
                const headers = { Authorization: `Bearer ${tool.token}` };
                const head = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(30_000) });
                if (head.ok && upload.sha256 && head.headers.get('X-Reference-Sha256') === upload.sha256) {
                    delete errors[upload.slotId];
                    continue;
                }
                if (!head.ok && head.status !== 404) throw new Error(`参考图查询失败（HTTP ${head.status}）`);
                const base64 = referenceSources?.[upload.slotId];
                if (!base64) throw new Error('本次参考图数据缺失');
                const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                const put = await fetch(url, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'image/png', ...(upload.sha256 ? { 'X-Reference-Sha256': upload.sha256 } : {}) },
                    body: bytes,
                    signal: AbortSignal.timeout(90_000),
                });
                if (!put.ok) throw new Error(`参考图上传失败（HTTP ${put.status}）`);
                delete errors[upload.slotId];
            } catch (error) {
                errors[upload.slotId] = String((error as Error)?.message || error).slice(0, 300);
            }
        }
        tools.push({ ...tool, referenceErrors: errors });
    }
    return { ...cloudSpec, tools };
}
