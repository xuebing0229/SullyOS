import { processImage } from './file';

export const MAX_EMOJI_IMPORT_FILES = 30;
export const MAX_EMOJI_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_EMOJI_GIF_BYTES = 6 * 1024 * 1024;
export const MAX_EMOJI_DATA_URL_CHARS = 8 * 1024 * 1024 + 1024;
export const MAX_EMOJI_NAME_LENGTH = 40;

const MIME_BY_EXTENSION: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    bmp: 'image/bmp',
    heic: 'image/heic',
    heif: 'image/heif',
};

export interface EmojiFileLike {
    name: string;
    type: string;
    size: number;
}

export interface PreparedEmojiImage {
    suggestedName: string;
    dataUrl: string;
    isAnimatedGif: boolean;
}

export interface PendingEmojiImportItem extends PreparedEmojiImage {
    id: string;
    originalFileName: string;
    name: string;
}

function extensionOf(fileName: string): string {
    const match = fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
    return match?.[1] || '';
}

export function inferEmojiMime(file: Pick<EmojiFileLike, 'name' | 'type'>): string {
    const declared = (file.type || '').trim().toLowerCase();
    if (declared) return declared;
    return MIME_BY_EXTENSION[extensionOf(file.name)] || '';
}

export function validateEmojiFile(file: EmojiFileLike): {
    mime: string;
    isAnimatedGif: boolean;
} {
    const mime = inferEmojiMime(file);

    if (!mime.startsWith('image/')) {
        throw new Error(`${file.name || '该文件'}不是可识别的图片`);
    }
    if (mime === 'image/svg+xml' || extensionOf(file.name) === 'svg') {
        throw new Error(`${file.name}：不支持 SVG，请先转成 PNG/WebP`);
    }
    if (file.size <= 0) {
        throw new Error(`${file.name}：文件为空`);
    }
    if (file.size > MAX_EMOJI_SOURCE_BYTES) {
        throw new Error(`${file.name}：图片超过 12MB`);
    }

    const isAnimatedGif = mime === 'image/gif';
    if (isAnimatedGif && file.size > MAX_EMOJI_GIF_BYTES) {
        throw new Error(`${file.name}：GIF 超过 6MB，容易导致聊天卡顿`);
    }

    return { mime, isAnimatedGif };
}

export function suggestEmojiName(fileName: string): string {
    const withoutExtension = fileName.replace(/\.[^.]+$/, '');
    const normalized = withoutExtension
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return (normalized || '新表情').slice(0, MAX_EMOJI_NAME_LENGTH);
}

export function normalizeEmojiName(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, MAX_EMOJI_NAME_LENGTH);
}

export function allocateUniqueEmojiName(
    preferredName: string,
    occupiedNames: Set<string>,
): string {
    const base = normalizeEmojiName(preferredName) || '新表情';
    if (!occupiedNames.has(base)) {
        occupiedNames.add(base);
        return base;
    }

    for (let index = 2; index < 10000; index++) {
        const suffix = ` (${index})`;
        const stem = base.slice(0, Math.max(1, MAX_EMOJI_NAME_LENGTH - suffix.length));
        const candidate = `${stem}${suffix}`;
        if (!occupiedNames.has(candidate)) {
            occupiedNames.add(candidate);
            return candidate;
        }
    }

    const fallback = `新表情 ${Date.now()}`.slice(0, MAX_EMOJI_NAME_LENGTH);
    occupiedNames.add(fallback);
    return fallback;
}

export function limitEmojiImportBatch(files: File[], alreadyPending = 0): {
    accepted: File[];
    ignoredCount: number;
} {
    const slots = Math.max(0, MAX_EMOJI_IMPORT_FILES - alreadyPending);
    return {
        accepted: files.slice(0, slots),
        ignoredCount: Math.max(0, files.length - slots),
    };
}

export function makePendingEmojiImport(
    prepared: PreparedEmojiImage,
    fileName: string,
    id: string,
): PendingEmojiImportItem {
    return {
        id,
        originalFileName: fileName,
        name: prepared.suggestedName,
        ...prepared,
    };
}

export async function prepareEmojiImage(file: File): Promise<PreparedEmojiImage> {
    const { mime, isAnimatedGif } = validateEmojiFile(file);

    const normalizedFile = file.type
        ? file
        : new File([file], file.name, {
            type: mime,
            lastModified: file.lastModified,
        });

    const dataUrl = await processImage(normalizedFile, {
        maxWidth: 512,
        quality: 0.82,
        forceJpeg: false,
    });

    if (!dataUrl.startsWith('data:image/')) {
        throw new Error(`${file.name}：图片转换失败`);
    }
    if (dataUrl.length > MAX_EMOJI_DATA_URL_CHARS) {
        throw new Error(`${file.name}：处理后仍然过大，请先压缩`);
    }

    return {
        suggestedName: suggestEmojiName(file.name),
        dataUrl,
        isAnimatedGif,
    };
}
