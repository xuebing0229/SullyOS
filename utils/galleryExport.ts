import { Capacitor, registerPlugin } from '@capacitor/core';
import type { GalleryImage } from '../types';
import {
    dataUrlToBlob,
    getBlobForRef,
    isBlobRef,
} from './blobRef';

export const GALLERY_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

export type SupportedGalleryMime =
    | 'image/png'
    | 'image/jpeg'
    | 'image/gif'
    | 'image/webp'
    | 'image/avif';

export interface GalleryImageFormat {
    mimeType: SupportedGalleryMime;
    extension: 'png' | 'jpg' | 'gif' | 'webp' | 'avif';
}

interface NativeSaveImageOptions {
    base64?: string;
    sourceUrl?: string;
    mimeType?: string;
    displayName: string;
    albumName: string;
}

interface NativeSaveImageResult {
    uri: string;
    displayName: string;
    relativePath: string;
}

interface SullyGalleryPlugin {
    saveImage(options: NativeSaveImageOptions): Promise<NativeSaveImageResult>;
}

export interface GalleryExportResult {
    native: boolean;
    displayName: string;
    uri?: string;
    relativePath?: string;
}

const MIME_TO_FORMAT: Record<SupportedGalleryMime, GalleryImageFormat> = {
    'image/png': { mimeType: 'image/png', extension: 'png' },
    'image/jpeg': { mimeType: 'image/jpeg', extension: 'jpg' },
    'image/gif': { mimeType: 'image/gif', extension: 'gif' },
    'image/webp': { mimeType: 'image/webp', extension: 'webp' },
    'image/avif': { mimeType: 'image/avif', extension: 'avif' },
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
    return String.fromCharCode(...bytes.slice(start, end));
}

export function detectGalleryImageFormat(
    bytes: Uint8Array,
    declaredMime = '',
): GalleryImageFormat | null {
    if (
        bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a
    ) {
        return MIME_TO_FORMAT['image/png'];
    }

    if (
        bytes.length >= 3
        && bytes[0] === 0xff
        && bytes[1] === 0xd8
        && bytes[2] === 0xff
    ) {
        return MIME_TO_FORMAT['image/jpeg'];
    }

    if (
        bytes.length >= 6
        && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
    ) {
        return MIME_TO_FORMAT['image/gif'];
    }

    if (
        bytes.length >= 12
        && ascii(bytes, 0, 4) === 'RIFF'
        && ascii(bytes, 8, 12) === 'WEBP'
    ) {
        return MIME_TO_FORMAT['image/webp'];
    }

    if (
        bytes.length >= 12
        && ascii(bytes, 4, 8) === 'ftyp'
        && ['avif', 'avis'].includes(ascii(bytes, 8, 12))
    ) {
        return MIME_TO_FORMAT['image/avif'];
    }

    const normalized = declaredMime.toLowerCase().split(';', 1)[0].trim();
    return MIME_TO_FORMAT[normalized as SupportedGalleryMime] || null;
}

export function sanitizeGalleryPathSegment(value: string, fallback = '未命名角色'): string {
    const normalized = (value || '')
        .normalize('NFKC')
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^\.+|\.+$/g, '')
        .trim()
        .slice(0, 48);
    return normalized || fallback;
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

function timestampPart(timestamp: number): string {
    const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
    return [
        date.getFullYear(),
        pad2(date.getMonth() + 1),
        pad2(date.getDate()),
        '_',
        pad2(date.getHours()),
        pad2(date.getMinutes()),
        pad2(date.getSeconds()),
    ].join('');
}

export function buildGalleryExportName(
    image: Pick<GalleryImage, 'id' | 'timestamp'>,
    characterName: string,
    extension: GalleryImageFormat['extension'],
): string {
    const character = sanitizeGalleryPathSegment(characterName, '角色')
        .replace(/\s+/g, '_')
        .slice(0, 24);
    const idSuffix = String(image.id || 'image')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(-8) || 'image';
    return `SullyOS_${character}_${timestampPart(image.timestamp)}_${idSuffix}.${extension}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
    if (typeof FileReader !== 'undefined') {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const value = String(reader.result || '');
                const comma = value.indexOf(',');
                if (comma < 0) {
                    reject(new Error('图片 Base64 编码失败'));
                    return;
                }
                resolve(value.slice(comma + 1));
            };
            reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
            reader.readAsDataURL(blob);
        });
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
}

async function inspectBlob(blob: Blob): Promise<GalleryImageFormat> {
    if (blob.size <= 0) throw new Error('图片内容为空');
    if (blob.size > GALLERY_EXPORT_MAX_BYTES) {
        throw new Error('图片超过 32 MiB，无法安全导出');
    }

    const prefix = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    const format = detectGalleryImageFormat(prefix, blob.type);
    if (!format) {
        throw new Error(`暂不支持这种图片格式${blob.type ? `：${blob.type}` : ''}`);
    }
    return format;
}

type ResolvedSource =
    | { kind: 'blob'; blob: Blob; format: GalleryImageFormat }
    | { kind: 'remote'; sourceUrl: string; hintedFormat: GalleryImageFormat | null };

function formatFromUrl(url: string): GalleryImageFormat | null {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.endsWith('.png')) return MIME_TO_FORMAT['image/png'];
        if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return MIME_TO_FORMAT['image/jpeg'];
        if (pathname.endsWith('.gif')) return MIME_TO_FORMAT['image/gif'];
        if (pathname.endsWith('.webp')) return MIME_TO_FORMAT['image/webp'];
        if (pathname.endsWith('.avif')) return MIME_TO_FORMAT['image/avif'];
    } catch {
        // handled by caller
    }
    return null;
}

async function resolveGallerySource(value: string): Promise<ResolvedSource> {
    if (!value) throw new Error('相册图片数据已丢失');

    if (isBlobRef(value)) {
        const blob = await getBlobForRef(value);
        if (!blob) throw new Error('本机相册原图已丢失');
        return { kind: 'blob', blob, format: await inspectBlob(blob) };
    }

    if (value.startsWith('data:')) {
        const blob = dataUrlToBlob(value);
        return { kind: 'blob', blob, format: await inspectBlob(blob) };
    }

    if (!/^https?:\/\//i.test(value)) {
        throw new Error('这条旧相册记录不是可导出的图片地址');
    }

    try {
        const response = await fetch(value, {
            signal: AbortSignal.timeout(60_000),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return { kind: 'blob', blob, format: await inspectBlob(blob) };
    } catch (error) {
        // Android Native 可以绕过 WebView CORS，直接下载 HTTPS 旧图。
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
            return {
                kind: 'remote',
                sourceUrl: value,
                hintedFormat: formatFromUrl(value),
            };
        }
        throw new Error(`无法读取这张旧图片：${(error as Error)?.message || String(error)}`);
    }
}

function triggerBrowserDownload(source: ResolvedSource, displayName: string): void {
    const anchor = document.createElement('a');
    anchor.download = displayName;
    anchor.rel = 'noopener';

    let objectUrl: string | null = null;
    if (source.kind === 'blob') {
        objectUrl = URL.createObjectURL(source.blob);
        anchor.href = objectUrl;
    } else {
        anchor.href = source.sourceUrl;
        anchor.target = '_blank';
    }

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (objectUrl) {
        window.setTimeout(() => URL.revokeObjectURL(objectUrl!), 10_000);
    }
}

export async function saveGalleryImageToDevice(
    image: GalleryImage,
    characterName: string,
): Promise<GalleryExportResult> {
    const source = await resolveGallerySource(image.url);
    const fallbackFormat = source.kind === 'blob'
        ? source.format
        : source.hintedFormat || MIME_TO_FORMAT['image/png'];
    const displayName = buildGalleryExportName(
        { ...image, timestamp: Date.now() },
        characterName,
        fallbackFormat.extension,
    );
    const albumName = sanitizeGalleryPathSegment(characterName);

    if (!(Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android')) {
        triggerBrowserDownload(source, displayName);
        return { native: false, displayName };
    }

    if (!Capacitor.isPluginAvailable('SullyGallery')) {
        throw new Error('当前 APK 未包含系统相册保存组件，请安装重新构建后的 APK');
    }

    const plugin = registerPlugin<SullyGalleryPlugin>('SullyGallery');
    const result = source.kind === 'blob'
        ? await plugin.saveImage({
            base64: await blobToBase64(source.blob),
            mimeType: source.format.mimeType,
            displayName,
            albumName,
        })
        : await plugin.saveImage({
            sourceUrl: source.sourceUrl,
            mimeType: source.hintedFormat?.mimeType,
            displayName,
            albumName,
        });

    return {
        native: true,
        displayName: result.displayName,
        uri: result.uri,
        relativePath: result.relativePath,
    };
}
