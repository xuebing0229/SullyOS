import { describe, expect, it } from 'vitest';
import {
    buildGalleryExportName,
    detectGalleryImageFormat,
    sanitizeGalleryPathSegment,
} from './galleryExport';

describe('gallery export format detection', () => {
    it('detects PNG, JPEG, GIF and WebP magic bytes', () => {
        expect(detectGalleryImageFormat(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )?.mimeType).toBe('image/png');

        expect(detectGalleryImageFormat(
            new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
        )?.mimeType).toBe('image/jpeg');

        expect(detectGalleryImageFormat(
            new TextEncoder().encode('GIF89a'),
        )?.mimeType).toBe('image/gif');

        const webp = new Uint8Array(12);
        webp.set(new TextEncoder().encode('RIFF'), 0);
        webp.set(new TextEncoder().encode('WEBP'), 8);
        expect(detectGalleryImageFormat(webp)?.mimeType).toBe('image/webp');
    });

    it('uses a supported declared MIME as fallback', () => {
        expect(detectGalleryImageFormat(
            new Uint8Array([1, 2, 3]),
            'image/avif; charset=binary',
        )?.extension).toBe('avif');
        expect(detectGalleryImageFormat(
            new Uint8Array([1, 2, 3]),
            'text/plain',
        )).toBeNull();
    });
});

describe('gallery export naming', () => {
    it('removes unsafe path characters', () => {
        expect(sanitizeGalleryPathSegment(' 祁/连:*云? ')).toBe('祁_连_云_');
    });

    it('builds a stable readable filename', () => {
        const name = buildGalleryExportName(
            {
                id: 'gallery_a1b2c3',
                timestamp: new Date(2026, 6, 27, 21, 48, 12).getTime(),
            },
            '祁连云',
            'png',
        );
        expect(name).toMatch(
            /^SullyOS_祁连云_20260727_214812_[A-Za-z0-9_-]+\.png$/,
        );
    });
});
