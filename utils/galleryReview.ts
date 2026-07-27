import type { GalleryImage } from '../types';

/**
 * 统一修改相册点评字段。
 *
 * review 为 null/空白时，彻底删除 review 与 reviewTimestamp，
 * 而不是把它们写成空字符串或 undefined，保证备份和 UI 判断干净。
 */
export function applyGalleryReview(
    image: GalleryImage,
    review: string | null,
    timestamp: number = Date.now(),
): GalleryImage {
    const next: GalleryImage = { ...image };
    const normalized = typeof review === 'string' ? review.trim() : '';

    if (!normalized) {
        delete next.review;
        delete next.reviewTimestamp;
        return next;
    }

    next.review = normalized;
    next.reviewTimestamp = timestamp;
    return next;
}

export function buildRegeneratedReviewInstruction(previousReview?: string): string {
    const previous = previousReview?.trim();
    if (!previous) return '';

    return [
        '',
        'The user did not like your previous comment and explicitly asked you to comment again.',
        `Previous comment: ${JSON.stringify(previous)}`,
        'Give a substantially different reaction: choose a different observation, emotional angle, and wording.',
        'Do not repeat or lightly paraphrase the previous comment.',
    ].join('\n');
}
