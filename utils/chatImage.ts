import { processImage } from './file';

export const MAX_CHAT_GIF_BYTES = 50 * 1024 * 1024;
export const CHAT_IMAGE_MAX_EDGE = 600;
export const CHAT_IMAGE_JPEG_QUALITY = 0.6;

export interface PreparedChatImage {
    /** 聊天气泡和相册里显示的图片。GIF 保留原动画。 */
    displayDataUrl: string;
    /** 发送给视觉模型的图片。GIF 使用首帧 JPEG。 */
    visionDataUrl: string;
    isAnimatedGif: boolean;
}

function extensionOf(fileName: string): string {
    return fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

/** Android 文件选择器偶尔不给 MIME，因此也检查扩展名。 */
export function isGifFile(file: Pick<File, 'name' | 'type'>): boolean {
    return (file.type || '').trim().toLowerCase() === 'image/gif'
        || extensionOf(file.name) === 'gif';
}

export function fitChatImageSize(
    width: number,
    height: number,
    maxEdge = CHAT_IMAGE_MAX_EDGE,
): { width: number; height: number } {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('图片尺寸无效');
    }

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result === 'string' && result.startsWith('data:')) resolve(result);
            else reject(new Error('动图读取失败'));
        };
        reader.onerror = () => reject(new Error('动图读取失败'));
        reader.readAsDataURL(file);
    });
}

async function drawGifFirstFrameWithBitmap(file: File): Promise<string> {
    const bitmap = await createImageBitmap(file);
    try {
        const size = fitChatImageSize(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context error');

        // GIF 可能含透明像素；JPEG 没有 alpha，先铺白底避免透明区变黑。
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size.width, size.height);
        ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        return canvas.toDataURL('image/jpeg', CHAT_IMAGE_JPEG_QUALITY);
    } finally {
        bitmap.close();
    }
}

function drawGifFirstFrameWithImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        let settled = false;

        const cleanup = () => {
            URL.revokeObjectURL(objectUrl);
            img.onload = null;
            img.onerror = null;
        };

        img.onload = () => {
            if (settled) return;
            settled = true;
            try {
                const size = fitChatImageSize(img.naturalWidth || img.width, img.naturalHeight || img.height);
                const canvas = document.createElement('canvas');
                canvas.width = size.width;
                canvas.height = size.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('Canvas context error');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, size.width, size.height);
                ctx.drawImage(img, 0, 0, size.width, size.height);
                resolve(canvas.toDataURL('image/jpeg', CHAT_IMAGE_JPEG_QUALITY));
            } catch (error) {
                reject(error);
            } finally {
                cleanup();
            }
        };
        img.onerror = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('无法读取 GIF 首帧'));
        };
        img.src = objectUrl;
    });
}

async function extractGifFirstFrame(file: File): Promise<string> {
    if (typeof createImageBitmap === 'function') {
        try {
            return await drawGifFirstFrameWithBitmap(file);
        } catch {
            // 老 WebView 或特定 GIF 解码失败时，退回 HTMLImageElement。
        }
    }
    return drawGifFirstFrameWithImage(file);
}

/**
 * 聊天图片统一处理：
 * - 普通静态图沿用现有 processImage，气泡和模型都使用压缩 JPEG；
 * - GIF 在气泡/相册中保留原动画，同时额外提取首帧 JPEG 给视觉模型。
 *
 * 这样模型请求永远不会携带 data:image/gif，避免该消息留在上下文后每轮持续 400。
 */
export async function prepareChatImageForSend(file: File): Promise<PreparedChatImage> {
    if (!isGifFile(file)) {
        const jpeg = await processImage(file, {
            maxWidth: CHAT_IMAGE_MAX_EDGE,
            quality: CHAT_IMAGE_JPEG_QUALITY,
            forceJpeg: true,
        });
        return {
            displayDataUrl: jpeg,
            visionDataUrl: jpeg,
            isAnimatedGif: false,
        };
    }

    if (file.size > MAX_CHAT_GIF_BYTES) {
        throw new Error('GIF 图片过大(>50MB)，可能导致应用崩溃');
    }

    // MIME 为空时补成 image/gif，确保 FileReader 产出的 data URL 可被 <img> 正确识别。
    const normalizedGif = file.type
        ? file
        : new File([file], file.name, {
            type: 'image/gif',
            lastModified: file.lastModified,
        });

    const [displayDataUrl, visionDataUrl] = await Promise.all([
        readFileAsDataUrl(normalizedGif),
        extractGifFirstFrame(normalizedGif),
    ]);

    if (!displayDataUrl.startsWith('data:image/gif')) {
        throw new Error('GIF 读取结果格式异常');
    }
    if (!visionDataUrl.startsWith('data:image/jpeg')) {
        throw new Error('GIF 首帧转换失败');
    }

    return {
        displayDataUrl,
        visionDataUrl,
        isAnimatedGif: true,
    };
}
