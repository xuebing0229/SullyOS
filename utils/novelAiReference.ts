import type {
    CharacterProfile,
    NovelAiPreciseReferenceConfig,
    NovelAiReferenceType,
} from '../types';
import {
    dataUrlToBlob,
    getBlobForRef,
    isBlobRef,
    putImageBlob,
    resolveRefToDataUrl,
} from './blobRef';
import {
    loadBuiltinImageSettings,
    type BuiltinImageBinding,
} from './builtinImageMcp';
import type { McpServerConfig } from './mcpClient';

const SLOT_RE = /^[a-f0-9]{64}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const REFERENCE_FIELDS = [
    'reference_id',
    'reference_type',
    'reference_strength',
    'reference_fidelity',
] as const;

export interface PreparedReferenceImage {
    blob: Blob;
    sha256: string;
    width: number;
    height: number;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createNovelAiReferenceSlotId(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}

export async function sha256Blob(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return bytesToHex(new Uint8Array(digest));
}

async function decodeBlob(blob: Blob): Promise<{
    width: number;
    height: number;
    draw: (context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;
    close: () => void;
}> {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(blob);
            return {
                width: bitmap.width,
                height: bitmap.height,
                draw: (context, x, y, w, h) => context.drawImage(bitmap, x, y, w, h),
                close: () => bitmap.close(),
            };
        } catch {
            // Android WebView may fail here; fall through to HTMLImageElement.
        }
    }

    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('无法解码参考图'));
            image.src = objectUrl;
        });
        return {
            width: image.naturalWidth,
            height: image.naturalHeight,
            draw: (context, x, y, w, h) => context.drawImage(image, x, y, w, h),
            close: () => URL.revokeObjectURL(objectUrl),
        };
    } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
    }
}

function chooseReferenceCanvas(width: number, height: number): { width: number; height: number } {
    const ratio = width / height;
    if (ratio >= 1.2) return { width: 1536, height: 1024 };
    if (ratio <= 1 / 1.2) return { width: 1024, height: 1536 };
    return { width: 1472, height: 1472 };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('参考图 PNG 编码失败'));
        }, 'image/png');
    });
}

export async function prepareNovelAiReferenceImage(source: Blob): Promise<PreparedReferenceImage> {
    if (!source.type.startsWith('image/')) throw new Error('请选择图片文件');
    if (source.type === 'image/gif') throw new Error('锁脸参考图不支持 GIF，请选择静态图片');
    if (source.type === 'image/svg+xml') throw new Error('锁脸参考图不支持 SVG');
    if (source.size <= 0 || source.size > MAX_SOURCE_BYTES) {
        throw new Error('参考图必须小于 20 MiB');
    }

    const decoded = await decodeBlob(source);
    try {
        if (!decoded.width || !decoded.height) throw new Error('参考图尺寸无效');
        const target = chooseReferenceCanvas(decoded.width, decoded.height);
        const scale = Math.min(target.width / decoded.width, target.height / decoded.height);
        const drawWidth = Math.max(1, Math.round(decoded.width * scale));
        const drawHeight = Math.max(1, Math.round(decoded.height * scale));
        const offsetX = Math.floor((target.width - drawWidth) / 2);
        const offsetY = Math.floor((target.height - drawHeight) / 2);

        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('当前设备无法处理参考图');

        context.fillStyle = '#000000';
        context.fillRect(0, 0, target.width, target.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        decoded.draw(context, offsetX, offsetY, drawWidth, drawHeight);

        const blob = await canvasToPng(canvas);
        return {
            blob,
            sha256: await sha256Blob(blob),
            width: target.width,
            height: target.height,
        };
    } finally {
        decoded.close();
    }
}

async function sourceValueToBlob(value: string): Promise<Blob> {
    if (isBlobRef(value)) {
        const blob = await getBlobForRef(value);
        if (!blob) throw new Error('本机图片数据已丢失');
        return blob;
    }
    if (value.startsWith('data:')) return dataUrlToBlob(value);

    const resolved = await resolveRefToDataUrl(value);
    if (resolved.startsWith('data:')) return dataUrlToBlob(resolved);
    let response: Response;
    try {
        response = await fetch(resolved, { signal: AbortSignal.timeout(30_000) });
    } catch (error: any) {
        throw new Error(`无法读取这张相册图片：${error?.message || String(error)}`);
    }
    if (!response.ok) throw new Error(`无法读取这张相册图片：HTTP ${response.status}`);
    return response.blob();
}

export async function createReferenceConfigFromSource(
    source: Blob,
    sourceName = 'reference.png',
    previous?: NovelAiPreciseReferenceConfig,
): Promise<NovelAiPreciseReferenceConfig> {
    const prepared = await prepareNovelAiReferenceImage(source);
    const imageRef = await putImageBlob(prepared.blob);
    return {
        enabled: true,
        imageRef,
        imageSha256: prepared.sha256,
        slotId: previous && SLOT_RE.test(previous.slotId)
            ? previous.slotId
            : createNovelAiReferenceSlotId(),
        type: previous?.type || 'character',
        strength: previous?.strength ?? 0.75,
        fidelity: previous?.fidelity ?? 0.85,
        sourceName,
        updatedAt: Date.now(),
    };
}

export async function createReferenceConfigFromStoredImage(
    value: string,
    sourceName: string,
    previous?: NovelAiPreciseReferenceConfig,
): Promise<NovelAiPreciseReferenceConfig> {
    return createReferenceConfigFromSource(
        await sourceValueToBlob(value),
        sourceName,
        previous,
    );
}

function referenceUrl(binding: BuiltinImageBinding, slotId: string): string {
    if (!SLOT_RE.test(slotId)) throw new Error('角色锁脸槽位无效，请重新选择参考图');
    return `${binding.controlBaseUrl.trim().replace(/\/+$/, '')}/references/${slotId}`;
}

function authHeaders(binding: BuiltinImageBinding): Headers {
    if (!binding.token.trim()) throw new Error('请先在“设置 → 生图功能 → NovelAI”填写 MCP Token');
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${binding.token.trim()}`);
    headers.set('Accept', 'application/json');
    return headers;
}

async function readError(response: Response): Promise<string> {
    const text = await response.text().catch(() => '');
    try {
        const parsed = text ? JSON.parse(text) : null;
        return String(parsed?.message || parsed?.error || text || `HTTP ${response.status}`);
    } catch {
        return text.slice(0, 240) || `HTTP ${response.status}`;
    }
}

export async function ensureNovelAiReferenceUploaded(
    config: NovelAiPreciseReferenceConfig,
): Promise<{ uploaded: boolean; sha256: string }> {
    if (!config.imageRef) throw new Error('角色没有参考图');
    if (!SLOT_RE.test(config.slotId)) throw new Error('角色锁脸槽位无效，请重新选择参考图');

    const binding = loadBuiltinImageSettings().engines.novelai;
    const headers = authHeaders(binding);
    const url = referenceUrl(binding, config.slotId);
    const blob = await getBlobForRef(config.imageRef);
    if (!blob) throw new Error('本机锁脸参考图已丢失，请重新选择');
    const sha256 = SHA_RE.test(config.imageSha256 || '')
        ? config.imageSha256
        : await sha256Blob(blob);

    let head: Response;
    try {
        head = await fetch(url, {
            method: 'HEAD',
            headers,
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error: any) {
        throw new Error(`无法检查锁脸参考图：${error?.message || String(error)}`);
    }

    const remoteSha = (head.headers.get('X-Reference-Sha256') || '').toLowerCase();
    if (head.ok && remoteSha === sha256) {
        return { uploaded: false, sha256 };
    }
    if (head.status !== 404 && !head.ok) {
        throw new Error(`无法检查锁脸参考图：${await readError(head)}`);
    }

    const putHeaders = authHeaders(binding);
    putHeaders.set('Content-Type', 'image/png');
    putHeaders.set('X-Reference-Sha256', sha256);
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'PUT',
            headers: putHeaders,
            body: blob,
            signal: AbortSignal.timeout(90_000),
        });
    } catch (error: any) {
        throw new Error(`锁脸参考图上传失败：${error?.message || String(error)}`);
    }
    if (!response.ok) {
        throw new Error(`锁脸参考图上传失败：${await readError(response)}`);
    }
    return { uploaded: true, sha256 };
}

export async function deleteRemoteNovelAiReference(
    config: NovelAiPreciseReferenceConfig | undefined,
): Promise<void> {
    if (!config || !SLOT_RE.test(config.slotId)) return;
    const binding = loadBuiltinImageSettings().engines.novelai;
    if (!binding.token.trim() || !binding.controlBaseUrl.trim()) return;
    const response = await fetch(referenceUrl(binding, config.slotId), {
        method: 'DELETE',
        headers: authHeaders(binding),
        signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (response && !response.ok && response.status !== 404) {
        throw new Error(`服务器参考图删除失败：${await readError(response)}`);
    }
}

export function sanitizeNovelAiReferenceToolArguments(
    args: Record<string, any>,
): Record<string, any> {
    const clean = { ...(args || {}) };
    for (const key of REFERENCE_FIELDS) delete clean[key];
    return clean;
}

export function applyManagedNovelAiReferenceArguments(
    args: Record<string, any>,
    reference?: NovelAiPreciseReferenceConfig,
): Record<string, any> {
    const clean = sanitizeNovelAiReferenceToolArguments(args);
    if (!reference?.enabled) return clean;
    return {
        ...clean,
        reference_id: reference.slotId,
        reference_type: reference.type,
        reference_strength: reference.strength,
        reference_fidelity: reference.fidelity,
    };
}

export async function prepareBuiltinImageToolArguments({
    server,
    toolName,
    args,
    character,
}: {
    server: McpServerConfig;
    toolName: string;
    args: Record<string, any>;
    character?: CharacterProfile | null;
}): Promise<Record<string, any>> {
    if (
        server.id !== 'builtin_image_novelai'
        || toolName !== 'novelai_generate_image'
    ) {
        return args;
    }

    const clean = sanitizeNovelAiReferenceToolArguments(args);
    const reference = character?.novelAiReference;
    if (!reference?.enabled) return clean;
    if (!reference.imageRef) throw new Error('当前角色已开启锁脸，但没有参考图');
    if (!SLOT_RE.test(reference.slotId)) throw new Error('当前角色的锁脸槽位无效');

    await ensureNovelAiReferenceUploaded(reference);

    return applyManagedNovelAiReferenceArguments(clean, reference);
}

export function stripNovelAiReferenceForTextOnlyBackup(character: CharacterProfile): CharacterProfile {
    const clean = { ...character };
    delete clean.novelAiReference;
    return clean;
}

export function clampReferenceUnit(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

export function isNovelAiReferenceType(value: unknown): value is NovelAiReferenceType {
    return value === 'character' || value === 'style' || value === 'character&style';
}
