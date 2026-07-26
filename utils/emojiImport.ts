import { processImageToBlob } from './file';

export const MAX_EMOJI_IMPORT_FILES = 30;
export const MAX_EMOJI_IMPORT_GIFS = 10;
export const MAX_EMOJI_IMPORT_BATCH_BYTES = 30 * 1024 * 1024;
export const MAX_EMOJI_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_EMOJI_GIF_BYTES = 6 * 1024 * 1024;
export const MAX_EMOJI_PROCESSED_BYTES = 8 * 1024 * 1024;
export const MAX_EMOJI_NAME_LENGTH = 40;

const MIME_BY_EXTENSION: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
};

export interface EmojiFileLike { name: string; type: string; size: number; }
export interface PreparedEmojiImage {
    suggestedName: string;
    blob: Blob;
    previewUrl: string;
    byteSize: number;
    isAnimatedGif: boolean;
}
export interface PendingEmojiImportItem extends PreparedEmojiImage {
    id: string;
    originalFileName: string;
    name: string;
}

function extensionOf(fileName: string): string {
    return fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

export function inferEmojiMime(file: Pick<EmojiFileLike, 'name' | 'type'>): string {
    const declared = (file.type || '').trim().toLowerCase();
    const generic = !declared || declared === 'application/octet-stream' || declared === 'binary/octet-stream' || declared === 'image/*';
    if (!generic) return declared;
    return MIME_BY_EXTENSION[extensionOf(file.name)] || '';
}

export async function sniffEmojiMime(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).startsWith('GIF8')) return 'image/gif';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
        const brand = String.fromCharCode(...bytes.slice(8, 12));
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
        if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1') return 'image/heic';
    }
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
    return '';
}

export function validateEmojiFile(file: EmojiFileLike, resolvedMime = inferEmojiMime(file)): { mime: string; isAnimatedGif: boolean } {
    if (!resolvedMime.startsWith('image/')) throw new Error(`${file.name || '该文件'}不是可识别的图片`);
    if (resolvedMime === 'image/svg+xml' || extensionOf(file.name) === 'svg') throw new Error(`${file.name}：不支持 SVG，请先转成 PNG/WebP`);
    if (file.size <= 0) throw new Error(`${file.name}：文件为空`);
    if (file.size > MAX_EMOJI_SOURCE_BYTES) throw new Error(`${file.name}：图片超过 12MB`);
    const isAnimatedGif = resolvedMime === 'image/gif';
    if (isAnimatedGif && file.size > MAX_EMOJI_GIF_BYTES) throw new Error(`${file.name}：GIF 超过 6MB，容易导致聊天卡顿`);
    return { mime: resolvedMime, isAnimatedGif };
}

export function suggestEmojiName(fileName: string): string {
    const normalized = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (normalized || '新表情').slice(0, MAX_EMOJI_NAME_LENGTH);
}
export function normalizeEmojiName(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, MAX_EMOJI_NAME_LENGTH);
}
export function allocateUniqueEmojiName(preferredName: string, occupiedNames: Set<string>): string {
    const base = normalizeEmojiName(preferredName) || '新表情';
    if (!occupiedNames.has(base)) { occupiedNames.add(base); return base; }
    for (let index = 2; index < 10000; index++) {
        const suffix = ` (${index})`;
        const candidate = `${base.slice(0, Math.max(1, MAX_EMOJI_NAME_LENGTH - suffix.length))}${suffix}`;
        if (!occupiedNames.has(candidate)) { occupiedNames.add(candidate); return candidate; }
    }
    const fallback = `新表情 ${Date.now()}`.slice(0, MAX_EMOJI_NAME_LENGTH);
    occupiedNames.add(fallback); return fallback;
}

export function limitEmojiImportBatch(files: File[], alreadyPending = 0, pendingBytes = 0, pendingGifCount = 0): {
    accepted: File[]; ignoredCount: number; totalBytes: number; gifCount: number;
} {
    const accepted: File[] = [];
    let totalBytes = pendingBytes;
    let gifCount = pendingGifCount;
    for (const file of files) {
        const isGif = inferEmojiMime(file) === 'image/gif';
        if (alreadyPending + accepted.length >= MAX_EMOJI_IMPORT_FILES) continue;
        if (totalBytes + Math.max(0, file.size) > MAX_EMOJI_IMPORT_BATCH_BYTES) continue;
        if (isGif && gifCount >= MAX_EMOJI_IMPORT_GIFS) continue;
        accepted.push(file); totalBytes += Math.max(0, file.size); if (isGif) gifCount++;
    }
    return { accepted, ignoredCount: files.length - accepted.length, totalBytes, gifCount };
}

export function makePendingEmojiImport(prepared: PreparedEmojiImage, fileName: string, id: string): PendingEmojiImportItem {
    return { id, originalFileName: fileName, name: prepared.suggestedName, ...prepared };
}

export function revokePendingEmojiPreview(item: Pick<PendingEmojiImportItem, 'previewUrl'>): void {
    if (item.previewUrl.startsWith('blob:')) { try { URL.revokeObjectURL(item.previewUrl); } catch { /* ignore */ } }
}

export async function prepareEmojiImage(file: File): Promise<PreparedEmojiImage> {
    let mime = inferEmojiMime(file);
    if (!mime || mime === 'image/*') mime = await sniffEmojiMime(file);
    const { isAnimatedGif } = validateEmojiFile(file, mime);
    const normalizedFile = file.type === mime ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified });
    const blob = isAnimatedGif ? normalizedFile : await processImageToBlob(normalizedFile, { maxWidth: 512, quality: 0.82, forceJpeg: false });
    if (blob.size <= 0) throw new Error(`${file.name}：图片处理结果为空`);
    if (blob.size > MAX_EMOJI_PROCESSED_BYTES) throw new Error(`${file.name}：处理后仍超过 8MB，请先压缩`);
    return { suggestedName: suggestEmojiName(file.name), blob, previewUrl: URL.createObjectURL(blob), byteSize: blob.size, isAnimatedGif };
}
