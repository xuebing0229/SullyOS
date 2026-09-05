import type { GalleryImage } from '../types';
import { DB } from './db';

/**
 * All Story Theater illustrations share one gallery-only virtual owner.
 * This keeps plot CGs out of real character albums without creating one album per save.
 */
export const STORY_THEATER_GALLERY_CHAR_ID = '__story_theater_gallery__';
export const STORY_THEATER_GALLERY_CHAR_NAME = '剧情剧场';

export const isStoryTheaterGalleryImage = (image: GalleryImage): boolean => {
    const sourceMeta = image.sourceMeta && typeof image.sourceMeta === 'object'
        ? image.sourceMeta as Record<string, unknown>
        : undefined;
    return sourceMeta?.source === 'story-theater'
        || sourceMeta?.theaterId !== undefined
        || String(image.charId || '').startsWith('story_theater_');
};

/**
 * Idempotent migration for older Story Theater images that were stored under a
 * per-save virtual thread id. Existing blobs/gallery ids stay untouched; only
 * the gallery owner is normalized to the shared Story Theater album.
 */
export async function migrateStoryTheaterGalleryImages(): Promise<number> {
    const images = await DB.getGalleryImages();
    const legacy = images.filter(image =>
        image.charId !== STORY_THEATER_GALLERY_CHAR_ID
        && isStoryTheaterGalleryImage(image)
    );
    let migrated = 0;
    for (const image of legacy) {
        await DB.saveGalleryImage({
            ...image,
            charId: STORY_THEATER_GALLERY_CHAR_ID,
        });
        migrated += 1;
    }
    return migrated;
}
